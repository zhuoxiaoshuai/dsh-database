import { Worker } from 'node:worker_threads'
import { randomUUID } from 'node:crypto'
import type { Connection, ConnectionTest, CatalogRequest, CatalogResult, ConnectionWorkbench, DatabaseWorkspaceSnapshot, QueryEditSource, Result, SharedQuery, SourceConnectionInput, SourceConnectionSettings } from '../shared/workbench.ts'
import type { DataSourceId } from '../shared/data-sources/types.ts'
import { connectionFingerprint, validateConnection, canReuseSavedLogin } from '../shared/connection-input.ts'
import { isWritableEnvironment } from '../shared/connection-permission.ts'
import { publicConnection, SavedDatabaseConnections, uniqueCopyName, type StoredDatabaseConnection } from './saved-connections.ts'
import { ConversationWorkbenchStore, sanitizeConversationWorkbench, type ConversationLayout } from './conversation-workbench-store.ts'
import { SqlTemplateStore } from './sql-template-store.ts'
import { KnowledgeService } from './knowledge-service.ts'
import { ExplorerService } from './explorer-service.ts'
import type { ExplorerListInput, ExplorerReadInput } from '../shared/explorer.ts'
import type { PasswordProtector } from '../password-protector.ts'
import type { ExecutionStore } from './execution-store.ts'
import { authorizeStatement, splitStatements } from './query-policy.mjs'
import { applySharedQueryPatch, catalogSchemaName, coerceVisibleSchemas, connectionOwnsSchema, emptySharedQuery, returnSharedQueryControl, takeSharedQueryControl, sharedQuerySurface } from '../shared/workbench.ts'
import { inferExecutionType, executionStop } from '../shared/execution.ts'
import { HOST_TIMEOUTS, connectTimeoutMessage, hostDeadlineFor, hostTimeoutMessage } from './request-timeouts.mjs'
import { databaseErrorDetail } from './connect-error.mjs'
import { CONNECTION_ERROR_CODES, ServiceError, type ConnectionErrorCode } from '../shared/connection-errors.ts'
import type { ServiceRequestAction } from '../shared/database-actions.ts'
import { DEFAULT_QUERY_PAGE_SIZE } from '../shared/limits.ts'
import { authorizeRedisCommand } from './redis-policy.ts'
import { controlExecutionDocument, emptyExecutionDocument, updateExecutionDocument, type ExecutionDocument } from '../shared/execution-document.ts'
import { redisLivePreview } from './redis-live-preview.ts'
import { getSourceRuntime } from './data-sources/runtime-registry.mjs'
import { runOperation } from './operation-runtime.ts'
import { assertRedisClusterDatabase, assertRedisDatabaseId, recordUserRedisCommand, redisAiDispatchAllowed, redisCommandRecordsHistory, redisPreparedInput } from './redis-request.ts'
import { hostModules } from './data-sources/modules.ts'
export { connectionFingerprint, validateConnection } from '../shared/connection-input.ts'

const MAX_LIVE = 20
const MAX_AI_STATEMENTS = 8
const MAX_READONLY = 3
const MAX_GLOBAL_READONLY = 16
const MAX_AI_READONLY = MAX_READONLY - 1
const MAX_GLOBAL_AI_READONLY = MAX_GLOBAL_READONLY - 2
const REVIVE_DELAYS_MS = [500, 1000, 2000, 5000]
const MAX_REVIVE_ATTEMPTS = 4
const fail = (message: string, code: typeof CONNECTION_ERROR_CODES[keyof typeof CONNECTION_ERROR_CODES]) => new ServiceError(message, code)
const publicErrorCodes = new Set<string>(Object.values(CONNECTION_ERROR_CODES))
const workerError = (message: string, code?: string): Error =>
  code && publicErrorCodes.has(code) ? new ServiceError(message, code as ConnectionErrorCode) : new Error(message)

type Entry = { session: string; worker: Worker; connection: Connection; touched: number; unexpectedlyClosed?: boolean }
type AuthorizedStatement = Awaited<ReturnType<typeof authorizeStatement>>
type TrustedAuthorization = Pick<AuthorizedStatement, 'kind' | 'sql' | 'tables'> & {
  targets?: { schema: string; name: string }[]
}
function sourceFingerprint(input: SourceConnectionSettings | SourceConnectionInput): string {
  return hostModules.get(input.dialect).connection.fingerprint(input as never)
}
function sameLogin(a: StoredDatabaseConnection['settings'], b: SourceConnectionInput): boolean {
  if (a.dialect !== b.dialect) return false
  const connection = hostModules.get(a.dialect).connection
  return connection.sameLogin ? connection.sameLogin(a, b) : sourceFingerprint(a) === sourceFingerprint(b)
}
function normalizeSourceConnection(raw: unknown, options?: { passwordOptional?: boolean }): SourceConnectionInput {
  const id = raw && typeof raw === 'object' ? (raw as { dialect?: unknown }).dialect : undefined
  return hostModules.get(id as DataSourceId).connection.validate(raw, options)
}
function keepVisibleSchemas(previous: StoredDatabaseConnection | undefined, next: StoredDatabaseConnection): StoredDatabaseConnection {
  return previous?.visibleSchemas?.length ? { ...next, visibleSchemas: [...previous.visibleSchemas] } : next
}
type ServiceRequest = {
  kind?: string
  schema?: string
  table?: string
  search?: string
  schemas?: string[]
  offset?: number
  refresh?: boolean
  sql?: string
  limit?: number
  executionId?: string
  conversationId?: string
  operation?: Record<string, unknown>
  operations?: unknown[]
  confirmed?: boolean
  enabled?: boolean
  id?: string
  targetName?: string
  command?: string
  text?: string
  args?: string[]
  cursor?: string
  match?: string
  prefix?: string
  key?: string
  value?: string
  seconds?: number
  database?: string
}

function sanitizeWorkerError(error: unknown): string {
  return databaseErrorDetail(error, { maxLength: 1000, normalizeWhitespace: false })
}

async function waitWhile(blocked: () => boolean, timeoutMs: number, timeoutError: () => Error, started = Date.now()): Promise<number> {
  while (blocked()) {
    if (Date.now() - started > timeoutMs) throw timeoutError()
    await new Promise(resolve => setTimeout(resolve, 20))
  }
  return Date.now() - started
}

function workerInitFailureMessage(error: unknown): string {
  const detail = sanitizeWorkerError(error)
  const base = '数据库驱动初始化失败，请检查插件依赖。'
  return detail && !detail.includes('数据库驱动初始化失败') ? `${base}（${detail}）` : base
}

export class ConnectionService {
  #entries = new Map<string, Entry>()
  #attempts = new Map<Worker, string>()
  #closed = false
  #editing = new Set<string>()
  #busy = new Map<Worker, number>()
  #catalogLocks = new Map<string, Promise<void>>()
  #readonlyActive = new Map<string, number>()
  #globalReadonly = 0
  #cache = new Map<string, { time: number; value: CatalogResult }>()
  #revision = 0
  #slotLock = Promise.resolve()
  #restoreRunning?: Promise<void>
  #connectionRunning = new Map<string, string>()
  #executions?: ExecutionStore
  #rows?: Map<string, StoredDatabaseConnection>
  #lastActiveId?: string
  #legacyDrafts = new Map<string, ConnectionWorkbench>()
  #legacyTemplates = new Map<string, string[]>()
  #migratedOwners = new Set<string>()
  #maintaining = new Set<string>()
  #reviveTimers = new Map<string, NodeJS.Timeout>()
  #reviveAttempts = new Map<string, number>()
  readonly templates: SqlTemplateStore
  private readonly knowledge: KnowledgeService
  private readonly explorer = new ExplorerService()
  private sessionValid: (session: string) => boolean
  private readonly store: SavedDatabaseConnections
  private readonly conversations: ConversationWorkbenchStore
  private readonly workerUrl: URL
  private readonly workerFactory: (url: URL) => Worker
  constructor(sessionValid: (session: string) => boolean = () => true, storageDirectory?: string, workerUrl = new URL('./connection-worker.mjs', import.meta.url), protector?: PasswordProtector, executions?: ExecutionStore, templates?: SqlTemplateStore, workerFactory = (url: URL) => new Worker(url, { resourceLimits: { maxOldGenerationSizeMb: 128, maxYoungGenerationSizeMb: 32 } })) {
    this.workerFactory = workerFactory
    this.#executions = executions
    this.sessionValid = sessionValid
    this.store = new SavedDatabaseConnections(storageDirectory, protector)
    this.conversations = new ConversationWorkbenchStore(this.store.root)
    this.templates = templates || new SqlTemplateStore(this.store.root)
    this.knowledge = new KnowledgeService(this.templates)
    this.workerUrl = workerUrl
  }
  list(session: string): Connection[] {
    return this.snapshot(session).connections
  }
  snapshot(session: string): DatabaseWorkspaceSnapshot {
    if (this.#closed || !this.sessionValid(session)) throw new Error('当前对话已失效。')
    const rows = this.ensure()
    const layout = this.#layout(session, rows)
    return {
      connections: [...rows.values()].map(row => publicConnection(row, this.#entries.get(row.id)?.connection, layout.workbenches[row.id])),
      lastActiveId: this.#lastActiveId && rows.has(this.#lastActiveId) ? this.#lastActiveId : undefined,
      passwordStorage: this.store.passwordStorage,
      revision: this.#revision,
    }
  }
  importConnections(session: string, items: unknown): {
    created: ReturnType<typeof publicConnection>[]
    skipped: { name: string; host: string; port?: number; username: string; database: string; reason: 'duplicate' | 'invalid'; message?: string }[]
  } {
    if (this.#closed || !this.sessionValid(session)) throw new Error('当前对话已失效。')
    if (!Array.isArray(items)) throw new Error('请提供要导入的连接列表。')
    const rows = this.ensure()
    const seen = new Set([...rows.values()].map(row => sourceFingerprint(row.settings)))
    const created: ReturnType<typeof publicConnection>[] = []
    const skipped: { name: string; host: string; port?: number; username: string; database: string; reason: 'duplicate' | 'invalid'; message?: string }[] = []
    const summarize = (value: Record<string, unknown>, extra: { reason: 'duplicate' | 'invalid'; message?: string }) => ({
      name: typeof value.name === 'string' ? value.name.slice(0, 80) : '',
      host: typeof value.host === 'string' ? value.host.slice(0, 253) : '',
      ...(typeof value.port === 'number' ? { port: value.port } : {}),
      username: typeof value.username === 'string' ? value.username.slice(0, 128) : '',
      database: typeof value.database === 'string' ? value.database.slice(0, 128) : '',
      ...extra,
    })
    const incoming = items.slice(0, 50)
    for (const extra of items.slice(50)) {
      skipped.push(summarize(extra && typeof extra === 'object' ? extra as Record<string, unknown> : {}, { reason: 'invalid', message: '单次最多导入 50 条。' }))
    }
    for (const item of incoming) {
      const raw = item && typeof item === 'object' ? item as Record<string, unknown> : {}
      try {
        const rawInput = {
          name: typeof raw.name === 'string' ? raw.name : '',
          dialect: raw.dialect,
          host: raw.host,
          port: raw.port,
          database: typeof raw.database === 'string' ? raw.database : '',
          oracleMode: raw.oracleMode === 'sid' ? 'sid' : 'service',
          username: raw.username,
          password: '',
          environment: raw.environment,
          tls: raw.tls,
          redisMode: raw.redisMode,
          sentinelMaster: raw.sentinelMaster,
          brokers: raw.brokers,
          saslMechanism: raw.saslMechanism,
        }
        const input = normalizeSourceConnection(rawInput, { passwordOptional: true })
        const key = sourceFingerprint(input)
        if (seen.has(key)) {
          skipped.push(summarize(raw, { reason: 'duplicate', message: '已存在相同主机、端口、用户名和数据库的连接。' }))
          continue
        }
        if (rows.size >= 100) {
          skipped.push(summarize(raw, { reason: 'invalid', message: '保存的数据库连接数量已达上限。' }))
          continue
        }
        seen.add(key)
        const { password: _password, caPem: _caPem, rememberPassword: _remember, useSavedPassword: _saved, ...settings } = input
        const id = randomUUID()
        const stored: StoredDatabaseConnection = { id, settings }
        rows.set(id, stored)
        created.push(publicConnection(stored, undefined, this.#layout(session, rows).workbenches[id]))
      } catch (error) {
        skipped.push(summarize(raw, { reason: 'invalid', message: error instanceof Error ? error.message : '连接字段无效。' }))
      }
    }
    if (created.length) this.persist()
    return { created, skipped }
  }
  async duplicate(session: string, id: string): Promise<Connection> {
    if (this.#closed || !this.sessionValid(session)) throw fail('当前对话已失效。', CONNECTION_ERROR_CODES.session)
    const rows = this.ensure()
    const original = rows.get(id)
    if (!original) throw fail('连接不存在或当前对话已失效。', CONNECTION_ERROR_CODES.offline)
    if (rows.size >= 100) throw fail('保存的数据库连接数量已达上限。', CONNECTION_ERROR_CODES.busy)
    const names = new Set([...rows.values()].map(row => row.settings.name))
    const name = uniqueCopyName(original.settings.name, names)
    const copyId = randomUUID()
    let protectedPassword: string | undefined
    let protectedCa: string | undefined
    if (original.protectedPassword) {
      try {
        const secret = await this.store.resolvePassword(original)
        protectedPassword = await this.store.protectPassword(copyId, secret)
      } catch { /* 副本仍可保存，连接时再输入密码 */ }
    }
    if (original.protectedCa) {
      try { protectedCa = await this.store.protectCa(copyId, await this.store.resolveCa(original)) }
      catch { /* copied connection remains available without custom CA */ }
    }
    const stored: StoredDatabaseConnection = {
      id: copyId,
      settings: { ...original.settings, name },
      ...(protectedPassword ? { protectedPassword } : {}),
      ...(protectedCa ? { protectedCa } : {}),
      ...(original.visibleSchemas?.length ? { visibleSchemas: [...original.visibleSchemas] } : {}),
    }
    rows.set(copyId, stored)
    this.persist()
    this.#bump()
    return structuredClone(publicConnection(stored, undefined, this.#layout(session, rows).workbenches[copyId]))
  }
  activate(session: string, id?: string): void {
    if (this.#closed || !this.sessionValid(session)) throw new Error('当前对话已失效。')
    const rows = this.ensure()
    if (id && !rows.has(id)) throw new Error('连接不存在或当前对话已失效。')
    this.#lastActiveId = id
    this.persist()
    this.#bump()
  }
  saveWorkbench(session: string, id: string, patch: unknown): ConnectionWorkbench {
    if (this.#closed || !this.sessionValid(session) || !this.ensure().has(id)) throw new Error('连接不存在或当前对话已失效。')
    const rows = this.#rows!
    const row = rows.get(id)!
    const incoming = patch && typeof patch === 'object' ? patch as ConnectionWorkbench : {}
    if (Object.hasOwn(incoming, 'visibleSchemas')) {
      const visible = coerceVisibleSchemas(incoming.visibleSchemas)
      if (visible.length) row.visibleSchemas = visible
      else delete row.visibleSchemas
      this.persist()
    }
    const { sharedQuery: _ignored, aiDocument: _document, aiCollab: _legacy, visibleSchemas: _visible, ...rest } = incoming
    const current = this.#layout(session, rows)
    const workbench = sanitizeConversationWorkbench({ ...current.workbenches[id], ...rest, sharedQuery: current.workbenches[id]?.sharedQuery })
    current.workbenches[id] = workbench
    this.conversations.save(session, current, new Set(rows.keys()))
    return publicConnection(row, undefined, workbench).workbench || workbench
  }
  getSharedQuery(session: string, id: string): SharedQuery {
    if (this.#closed || !this.sessionValid(session) || !this.ensure().has(id)) throw new Error('连接不存在或当前对话已失效。')
    return this.#layout(session, this.#rows!).workbenches[id]?.sharedQuery || emptySharedQuery()
  }
  getExecutionDocument(session: string, id: string, generation?: unknown): ExecutionDocument {
    if (this.#closed || !this.sessionValid(session)) throw new Error('当前对话已失效。')
    const saved = this.ensure().get(id)
    if (!saved) throw new Error('连接不存在。')
    if (generation !== undefined && this.#entries.get(id)?.connection.generation !== generation) throw new Error('连接已变化，请刷新。')
    if (getSourceRuntime(saved.settings.dialect).documentKind === 'sql') {
      const query = this.getSharedQuery(session, id)
      return { sourceId: saved.settings.dialect, text: query.sql, context: { schema: query.schema || '' }, revision: query.revision, controller: query.controller, controllerReason: query.controllerReason }
    }
    const document = this.#layout(session, this.#rows!).workbenches[id]?.aiDocument
    return document?.sourceId === saved.settings.dialect ? document : emptyExecutionDocument(saved.settings.dialect, 'database' in saved.settings ? { database: saved.settings.database } : {})
  }
  updateExecutionDocument(session: string, id: string, text: string, source: 'ai' | 'user' | 'system', expectedRevision?: number, generation?: unknown, context?: unknown): ExecutionDocument {
    const previous = this.getExecutionDocument(session, id, generation)
    if (getSourceRuntime(previous.sourceId).documentKind === 'sql') {
      this.updateSharedQuery(session, id, { sql: text }, source, expectedRevision)
      return this.getExecutionDocument(session, id)
    }
    const binding = this.#entries.get(id)?.connection || this.list(session).find(item => item.id === id)!
    const normalize = hostModules.get(previous.sourceId).execution.normalizeContext
    if (context !== undefined && !normalize) throw new Error('此数据源不支持文档上下文更新。')
    const normalized = context === undefined ? undefined : normalize!(context, binding)
    const next = updateExecutionDocument(previous, text, source, expectedRevision, normalized)
    if (next === previous) return previous
    const layout = this.#layout(session, this.#rows!)
    layout.workbenches[id] = sanitizeConversationWorkbench({ ...layout.workbenches[id], aiDocument: next })
    this.conversations.save(session, layout, new Set(this.#rows!.keys()))
    this.#executions?.emitWorkbench(session, { type: 'EXECUTION_DOCUMENT_CHANGED', connectionId: id,
      generation: this.#entries.get(id)?.connection.generation, document: next })
    return next
  }
  patchExecutionDocumentContext(session: string, id: string, database: string | Record<string, unknown>, generation?: unknown, expectedRevision?: number): ExecutionDocument {
    const previous = this.getExecutionDocument(session, id, generation)
    return this.updateExecutionDocument(session, id, previous.text, 'system', expectedRevision, generation, typeof database === 'string' ? { database } : database)
  }
  controlExecutionDocument(session: string, id: string, controller: 'ai' | 'user', reason = 'user-takeover', generation?: unknown): ExecutionDocument {
    const previous = this.getExecutionDocument(session, id, generation)
    if (getSourceRuntime(previous.sourceId).documentKind === 'sql') {
      if (controller === 'ai') this.returnSharedQuery(session, id)
      else this.takeSharedQuery(session, id, reason)
      return this.getExecutionDocument(session, id)
    }
    const next = controlExecutionDocument(previous, controller, reason)
    if (next === previous) return previous
    const layout = this.#layout(session, this.#rows!)
    layout.workbenches[id] = sanitizeConversationWorkbench({ ...layout.workbenches[id], aiDocument: next })
    this.#executions?.emitWorkbench(session, { type: 'EXECUTION_DOCUMENT_CHANGED', connectionId: id,
      generation: this.#entries.get(id)?.connection.generation, document: next })
    return next
  }
  async runExecutionDocument(session: string, id: string, generation: unknown, revision: number, signal?: AbortSignal): Promise<Record<string, unknown>> {
    const document = this.getExecutionDocument(session, id, generation)
    if (document.revision !== revision) throw new Error('AI Query 已变化，请刷新后再执行。')
    if (document.controller !== 'user') throw new Error('请先接管 AI Query。')
    const connection = this.#entries.get(id)?.connection
    if (!connection || connection.generation !== generation) throw new Error('连接已变化，请刷新。')
    if (getSourceRuntime(document.sourceId).documentKind === 'sql') return this.runSharedQuery(session, {
      connectionId: id, generation, schema: document.context.schema || '', sql: document.text,
      revision: document.revision, initiator: 'user', purpose: 'result',
    }, signal)
    if (getSourceRuntime(document.sourceId).textExecution === true) {
      const current = this.getExecutionDocument(session, id, generation)
      if (current.revision !== revision || current.controller !== 'user') throw new Error('AI Query 已变化，请刷新后再执行。')
      return this.executeText(session, id, generation, current.text, signal, 'user', undefined, current.revision, undefined, current.context)
    }
    const command = authorizeRedisCommand(document.text)[0].toUpperCase()
    const record = this.#executions?.create({ conversationId: session, connectionId: id, generation: connection.generation,
      connectionName: connection.name, dialect: 'redis', environment: connection.environment, operation: 'redis_execute',
      initiator: 'user', type: 'query', queryRevision: document.revision, title: `Redis ${command}` })
    const executionId = record?.executionId || ''
    const controller = new AbortController()
    if (signal?.aborted) controller.abort()
    else signal?.addEventListener('abort', () => controller.abort(), { once: true })
    if (executionId) { this.#executions?.attachAbort(executionId, controller); this.#executions?.transition(executionId, 'running'); this.#executions?.event(executionId, 'dispatched') }
    try {
      const current = this.getExecutionDocument(session, id, generation)
      if (current.revision !== revision || current.controller !== 'user' || current.text !== document.text) throw new Error('AI Query 已变化，请刷新后再执行。')
      const database = current.context.database || connection.database
      const result = await this.redisRequest(session, id, generation, 'redis-command', { command: current.text, ...(database ? { database } : {}) }, controller.signal, 'user', { record: false, queryRevision: revision })
      this.#executions?.complete(executionId, result.failed === true ? 'failed' : 'succeeded', `${command} 已完成。`)
      this.#executions?.emitWorkbench(session, { type: 'EXECUTION_FINISHED', connectionId: id,
        generation: connection.generation, executionId, queryRevision: document.revision,
        status: result.failed === true ? 'failed' : 'succeeded', sourceResult: redisLivePreview(result) })
      return { ...result, executionId }
    } catch (error) {
      const message = error instanceof Error ? error.message : 'Redis 命令失败。'
      this.#executions?.complete(executionId, /未知|超时|已取消|已关闭|断开/.test(message) ? 'unknown' : 'failed', message)
      throw error
    }
  }
  updateSharedQuery(session: string, id: string, patch: Partial<SharedQuery>, source: QueryEditSource, expectedRevision?: number): SharedQuery {
    if (this.#closed || !this.sessionValid(session) || !this.ensure().has(id)) throw new Error('连接不存在或当前对话已失效。')
    const rows = this.#rows!
    const current = this.#layout(session, rows)
    const previous = current.workbenches[id]?.sharedQuery || emptySharedQuery()
    const next = applySharedQueryPatch(previous, patch, source, expectedRevision)
    current.workbenches[id] = sanitizeConversationWorkbench({ ...current.workbenches[id], sharedQuery: next })
    const contentChanged = next.sql !== previous.sql || next.schema !== previous.schema || next.lastExecutionId !== previous.lastExecutionId || next.lastRun !== previous.lastRun
    if (contentChanged) this.conversations.save(session, current, new Set(rows.keys()))
    this.#emitQueryState(session, id, previous, next)
    return next
  }
  takeSharedQuery(session: string, id: string, reason = 'user-takeover'): SharedQuery {
    if (this.#closed || !this.sessionValid(session) || !this.ensure().has(id)) throw new Error('连接不存在或当前对话已失效。')
    const rows = this.#rows!
    const current = this.#layout(session, rows)
    const previous = current.workbenches[id]?.sharedQuery || emptySharedQuery()
    const next = takeSharedQueryControl(previous, reason)
    current.workbenches[id] = sanitizeConversationWorkbench({ ...current.workbenches[id], sharedQuery: next })
    this.#emitQueryState(session, id, previous, next)
    return next
  }
  returnSharedQuery(session: string, id: string): SharedQuery {
    if (this.#closed || !this.sessionValid(session) || !this.ensure().has(id)) throw new Error('连接不存在或当前对话已失效。')
    const rows = this.#rows!
    const current = this.#layout(session, rows)
    const previous = current.workbenches[id]?.sharedQuery || emptySharedQuery()
    const next = returnSharedQueryControl(previous)
    // 归还 AI 只改内存：控制权是会话级状态，重启后默认回到 AI（落盘快照已统一重置）
    current.workbenches[id] = sanitizeConversationWorkbench({ ...current.workbenches[id], sharedQuery: next })
    this.#emitQueryState(session, id, previous, next)
    return next
  }
  async runSharedQuery(session: string, input: {
    connectionId: string
    generation: unknown
    schema: string
    sql: string
    revision?: number
    initiator: 'ai' | 'user'
    callId?: string
    rootCallId?: string
    limit?: number
    purpose?: string
  }, signal?: AbortSignal): Promise<Record<string, unknown>> {
    if (this.#closed || !this.sessionValid(session)) throw new Error('当前对话已失效。')
    const id = input.connectionId
    const connection = this.#entries.get(id)?.connection
    if (!connection?.live) throw new Error('请先连接数据库。')
    if (getSourceRuntime(connection.dialect).documentKind !== 'sql') throw new Error('此数据源不使用 SQL 工作台。')
    if (connection.generation !== input.generation) throw new Error('连接已变化或当前对话已失效，请刷新。')
    const query = this.getSharedQuery(session, id)
    if (input.initiator === 'ai') {
      if (query.controller !== 'ai') throw new Error('用户已接管 AI Query，无法覆盖 SQL。')
      if (input.revision !== undefined && input.revision !== query.revision) throw new Error('AI Query 已变化，请重新读取后再试。')
    }
    const schema = input.schema || query.schema || connection.database
    const sql = input.sql || query.sql
    if (input.initiator === 'ai' && splitStatements(sql, connection.dialect).length > MAX_AI_STATEMENTS) throw new Error(`一次最多执行 ${MAX_AI_STATEMENTS} 条 SQL。`)
    const publishSql = true
    const publishGrid = input.initiator !== 'ai' || sharedQuerySurface(sql, input.purpose) === 'result'
    const executionType = inferExecutionType(input.initiator === 'ai' ? 'database_execute_sql' : 'workbench_shared_query', publishGrid ? 'result' : 'verify')
    const occupyRun = executionType !== 'verify'
    if (occupyRun) this.#acquireRun(id)
    let executionId = ''
    let published = query
    let record: ReturnType<NonNullable<ExecutionStore['create']>> | undefined
    try {
    if (publishSql && input.initiator === 'ai') {
      this.updateSharedQuery(session, id, { sql, schema }, 'ai', query.revision)
    }
    published = this.getSharedQuery(session, id)
    const operation = executionType === 'verify' ? 'database_execute_sql' : (input.initiator === 'ai' ? 'database_execute_sql' : 'workbench_shared_query')
    record = this.#executions?.create({
      conversationId: session,
      callId: input.callId,
      rootCallId: input.rootCallId,
      connectionId: id,
      generation: connection.generation,
      connectionName: connection.name,
      dialect: connection.dialect,
      environment: connection.environment,
      schema,
      operation,
      sql,
      initiator: input.initiator,
      type: executionType,
      queryRevision: published.revision,
      executedSql: sql,
      draft: { kind: 'query', sql, schema },
      title: input.initiator === 'ai'
        ? (executionType === 'verify' ? '验证查询' : `在 ${schema} 中执行查询，取得当前数据`)
        : '执行当前 SQL',
      reason: input.initiator === 'ai' ? '为在可见 AI Query 中取得当前数据。' : '用户在 AI Query 中执行当前 SQL。',
    })
    executionId = record?.executionId || ''
    if (occupyRun) this.#connectionRunning.set(id, executionId)
    } catch (error) {
      if (occupyRun) this.#releaseRun(id)
      throw error
    }
    if (publishGrid) this.#executions?.emitWorkbench(session, {
      type: 'EXECUTION_STARTED', connectionId: id, executionId, queryRevision: published.revision, executedSql: sql, initiator: input.initiator, sql, schema,
    })
    const controller = new AbortController()
    if (signal?.aborted) controller.abort()
    else signal?.addEventListener('abort', () => controller.abort(), { once: true })
    if (executionId) this.#executions?.attachAbort(executionId, controller)
    try {
      const authorized = await authorizeStatement(connection.dialect, sql, schema)
      if (record) this.#executions?.annotate(executionId, { tables: authorized.tables, sql: authorized.sql, executedSql: authorized.sql })
      if (authorized.kind === 'show') throw new Error('AI Query 暂不执行 SHOW，请使用对象详情或 SQL 查询页。')
      const showGrid = publishGrid || authorized.kind === 'write'
      if (authorized.kind === 'write') {
        if (!isWritableEnvironment(connection.environment)) throw new Error('只读权限连接不能提交写入。')
        this.#executions?.annotate(executionId, { type: 'write', draft: { kind: 'query', sql: authorized.sql, schema }, conclusion: 'SIT 写操作已直接执行。' })
        this.updateSharedQuery(session, id, { sql: authorized.sql, schema, lastExecutionId: executionId }, 'system')
      }
      if (authorized.kind === 'explain') this.#executions?.annotate(executionId, { type: 'explain' })
      this.#executions?.event(executionId, 'check-passed')
      this.#executions?.transition(executionId, 'running')
      this.#executions?.event(executionId, 'dispatched')
      if (showGrid) this.updateSharedQuery(session, id, { sql: authorized.sql, schema, lastExecutionId: executionId }, 'system')
      const trusted: TrustedAuthorization = {
        kind: authorized.kind,
        sql: authorized.sql,
        tables: authorized.tables,
        ...(authorized.targets ? { targets: authorized.targets } : {}),
      }
      const result = await this.request(session, id, connection.generation, 'query', { schema, sql: authorized.sql, limit: input.limit ?? DEFAULT_QUERY_PAGE_SIZE }, controller.signal, trusted) as unknown as Result
      const sets = Array.isArray(result.batch) && result.batch.length > 1 ? result.batch : [result]
      const batchMessage = sets.length > 1 ? `已执行 ${sets.length} 条` : result.message
      const latest = this.getSharedQuery(session, id)
      const generationAlive = this.#entries.get(id)?.connection.generation === connection.generation
      if (showGrid && generationAlive && latest.lastExecutionId === executionId) {
        this.updateSharedQuery(session, id, {
          lastExecutionId: executionId,
          lastRun: {
            columns: result.columns,
            rowCount: result.rows.length,
            truncated: result.truncated,
            elapsedMs: result.elapsedMs,
            message: batchMessage,
            at: new Date().toISOString(),
            executionId,
          },
        }, 'system')
      }
      this.#executions?.complete(executionId, 'succeeded', batchMessage || result.message, result, sets.length > 1
        ? `已执行 ${sets.length} 条。`
        : authorized.kind === 'write'
          ? (result.message || `已提交 · 影响 ${result.affectedRows ?? 0} 行。`)
          : `返回 ${result.rows.length} 行${result.truncated ? '（已截断）' : ''}。`)
      const after = this.getSharedQuery(session, id)
      const controlLost = input.initiator === 'ai' && after.controller !== 'ai'
      if (showGrid) this.#executions?.emitWorkbench(session, {
        type: 'EXECUTION_FINISHED',
        connectionId: id,
        executionId,
        queryRevision: published.revision,
        executedSql: authorized.sql,
        initiator: input.initiator,
        status: 'succeeded',
        result,
        kind: authorized.kind === 'write' ? 'write' : authorized.kind === 'explain' ? 'explain' : 'query',
        schema,
      })
      const statements = sets.map(item => ({
        ...(item.sql ? { sql: item.sql } : {}),
        columns: item.columns,
        rowCount: item.rows.length,
        truncated: item.truncated,
        elapsedMs: item.elapsedMs,
        ...(item.affectedRows !== undefined ? { affectedRows: item.affectedRows } : {}),
        rows: item.rows.slice(0, DEFAULT_QUERY_PAGE_SIZE),
      }))
      const model = {
        columns: result.columns,
        rowCount: result.rows.length,
        truncated: result.truncated,
        elapsedMs: result.elapsedMs,
        executionId,
        rows: result.rows.slice(0, DEFAULT_QUERY_PAGE_SIZE),
        ...(sets.length > 1 ? { statements } : {}),
        ...(batchMessage ? { message: batchMessage } : {}),
        ...(result.affectedRows !== undefined ? { affectedRows: result.affectedRows } : {}),
        ...(controlLost ? { controlLost: true } : {}),
      }
      return {
        executionId,
        status: 'succeeded',
        sql: authorized.sql,
        tables: authorized.tables,
        controlLost,
        result,
        model,
      }
    } catch (error) {
      const message = error instanceof Error ? error.message : '执行失败'
      const stop = executionStop({
        aborted: !!signal?.aborted,
        dispatched: !!this.#executions?.dispatched(executionId),
        message,
      })
      this.#executions?.complete(executionId, stop.status, stop.message)
      if (publishGrid) this.#executions?.emitWorkbench(session, {
        type: 'EXECUTION_FAILED', connectionId: id, executionId, queryRevision: published.revision, executedSql: sql, initiator: input.initiator, status: stop.status, kind: 'query', schema, message: stop.message,
      })
      const latest = this.getSharedQuery(session, id)
      const generationAlive = this.#entries.get(id)?.connection.generation === connection.generation
      if (publishGrid && generationAlive && latest.lastExecutionId === executionId) {
        this.updateSharedQuery(session, id, {
          lastExecutionId: executionId,
          lastRun: { columns: [], rowCount: 0, truncated: false, elapsedMs: 0, message: stop.message, at: new Date().toISOString(), executionId },
        }, 'system')
      }
      throw new Error(stop.message)
    } finally {
      this.#releaseRun(id, executionId)
    }
  }
  async explainPlan(session: string, connectionId: string, generation: unknown, input: { schema: string; sql: string; initiator?: 'ai' | 'user'; callId?: string; rootCallId?: string }, signal?: AbortSignal): Promise<Result & { executionId?: string }> {
    if (this.#closed || !this.sessionValid(session)) throw new Error('当前对话已失效。')
    const connection = this.#entries.get(connectionId)?.connection
    if (!connection?.live) throw new Error('请先连接数据库。')
    if (connection.generation !== generation) throw new Error('连接已变化或当前对话已失效，请刷新。')
    const query = this.getSharedQuery(session, connectionId)
    this.#acquireRun(connectionId)
    const record = this.#executions?.create({
      conversationId: session,
      callId: input.callId,
      rootCallId: input.rootCallId,
      connectionId,
      generation: connection.generation,
      connectionName: connection.name,
      dialect: connection.dialect,
      environment: connection.environment,
      schema: input.schema,
      operation: 'database_explain_plan',
      sql: input.sql,
      initiator: input.initiator || 'ai',
      type: 'explain',
      queryRevision: query.revision,
      executedSql: input.sql,
      title: '查看执行计划，诊断索引与扫描',
      reason: '为诊断索引与扫描方式。',
    })
    const executionId = record?.executionId || ''
    this.#connectionRunning.set(connectionId, executionId)
    const controller = new AbortController()
    if (signal?.aborted) controller.abort()
    else signal?.addEventListener('abort', () => controller.abort(), { once: true })
    if (executionId) this.#executions?.attachAbort(executionId, controller)
    try {
      this.#executions?.event(executionId, 'check-passed')
      this.#executions?.transition(executionId, 'running')
      this.#executions?.event(executionId, 'dispatched')
      this.#executions?.emitWorkbench(session, { type: 'EXECUTION_STARTED', connectionId, executionId, executedSql: input.sql, initiator: input.initiator || 'ai' })
      const result = await this.request(session, connectionId, generation, 'query', { schema: input.schema, sql: input.sql, limit: DEFAULT_QUERY_PAGE_SIZE }, controller.signal) as unknown as Result
      this.#executions?.complete(executionId, 'succeeded', result.message, result, result.message || '已采集执行计划。')
      this.#executions?.emitWorkbench(session, {
        type: 'EXECUTION_FINISHED', connectionId, executionId, queryRevision: query.revision, executedSql: input.sql, initiator: input.initiator || 'ai', status: 'succeeded', result, kind: 'explain',
      })
      return { ...result, executionId }
    } catch (error) {
      const message = error instanceof Error ? error.message : '解释失败'
      this.#executions?.complete(executionId, 'failed', message)
      this.#executions?.emitWorkbench(session, { type: 'EXECUTION_FAILED', connectionId, executionId, executedSql: input.sql, initiator: input.initiator || 'ai', status: 'failed', message })
      throw error
    } finally {
      this.#releaseRun(connectionId, executionId)
    }
  }
  #emitQueryState(session: string, connectionId: string, previous: SharedQuery, next: SharedQuery): void {
    if (!this.#executions) return
    if (next.sql !== previous.sql || next.schema !== previous.schema) {
      this.#executions.emitWorkbench(session, {
        type: 'QUERY_CHANGED', connectionId, queryRevision: next.revision, sql: next.sql, controller: next.controller, schema: next.schema,
      })
    } else if (next.controller !== previous.controller) {
      this.#executions.emitWorkbench(session, {
        type: 'CONTROL_CHANGED', connectionId, queryRevision: next.revision, sql: next.sql, controller: next.controller, schema: next.schema,
      })
    }
  }
  #acquireRun(connectionId: string): void {
    if (this.#connectionRunning.has(connectionId)) throw new Error('此连接已有查询正在执行。')
    this.#connectionRunning.set(connectionId, 'pending')
  }
  #releaseRun(connectionId: string, executionId?: string): void {
    const current = this.#connectionRunning.get(connectionId)
    if (!current) return
    if (!executionId || current === 'pending' || current === executionId) this.#connectionRunning.delete(connectionId)
  }
  async handleTemplate(session: string, body: Record<string, unknown>): Promise<unknown> {
    if (this.#closed || !this.sessionValid(session)) throw new Error('当前对话已失效。')
    const connectionId = typeof body.connectionId === 'string' ? body.connectionId : ''
    const saved = connectionId ? this.ensure().get(connectionId) : undefined
    if (connectionId && !saved) throw new Error('请提供当前数据源连接。')
    if (saved) return this.knowledge.dispatch(saved.settings.dialect, connectionId, body)
    return this.templates.dispatch(body)
  }

  handleKnowledge(session: string, body: Record<string, unknown>): unknown {
    if (this.#closed || !this.sessionValid(session)) throw new Error('当前对话已失效。')
    const connectionId = typeof body.connectionId === 'string' ? body.connectionId : ''
    const saved = this.ensure().get(connectionId)
    if (!saved) throw new Error('请提供当前数据源连接。')
    const entry = this.#entries.get(connectionId)
    if (typeof body.generation !== 'string' || entry?.connection.generation !== body.generation) throw new Error('连接已变化，请刷新。')
    return this.knowledge.dispatch(saved.settings.dialect, connectionId, body)
  }
  private explorerTarget(session: string, id: string, generation: unknown) {
    if (this.#closed || !this.sessionValid(session)) throw new Error('当前对话已失效。')
    const entry = this.#entries.get(id)
    if (!entry || entry.connection.generation !== generation) throw new Error('连接已变化，请刷新。')
    return entry.connection.dialect
  }
  explorerList(session: string, id: string, generation: unknown, input: ExplorerListInput, signal?: AbortSignal) {
    const sourceId = this.explorerTarget(session, id, generation)
    const transport = {
      catalog: (request: CatalogRequest, requestSignal?: AbortSignal) => this.catalog(session, id, generation, request, requestSignal),
      redis: (action: 'redis-scan' | 'redis-key', request: Record<string, unknown>, requestSignal?: AbortSignal) => this.redisRequest(session, id, generation, action, request, requestSignal),
      source: (action: string, request: Record<string, unknown>, requestSignal?: AbortSignal) => this.sourceRead(session, id, generation, action, request, requestSignal),
    }
    return this.explorer.list(sourceId, transport, input, signal)
  }
  explorerRead(session: string, id: string, generation: unknown, input: ExplorerReadInput, signal?: AbortSignal) {
    const sourceId = this.explorerTarget(session, id, generation)
    const transport = {
      catalog: (request: CatalogRequest, requestSignal?: AbortSignal) => this.catalog(session, id, generation, request, requestSignal),
      redis: (action: 'redis-scan' | 'redis-key', request: Record<string, unknown>, requestSignal?: AbortSignal) => this.redisRequest(session, id, generation, action, request, requestSignal),
      source: (action: string, request: Record<string, unknown>, requestSignal?: AbortSignal) => this.sourceRead(session, id, generation, action, request, requestSignal),
    }
    return this.explorer.read(sourceId, transport, input, signal)
  }
  private sourceRead(session: string, id: string, generation: unknown, action: string, input: Record<string, unknown>, signal?: AbortSignal): Promise<Record<string, unknown>> {
    const entry = this.#entries.get(id)
    if (!entry || !hostModules.get(entry.connection.dialect).explorer.readonlyActions?.includes(action)
      || !getSourceRuntime(entry.connection.dialect).actions.includes(action)) throw new Error('对象请求与数据源不匹配。')
    return this.#withReadonly(id, () => this.#dispatch(session, id, generation, action, input, signal), 'manual') as Promise<Record<string, unknown>>
  }
  private ensure(): Map<string, StoredDatabaseConnection> {
    if (!this.#rows) {
      const loaded = this.store.load()
      this.#lastActiveId = loaded.lastActiveId
      this.#rows = new Map()
      for (const row of loaded.connections) {
        if (row.workbench?.queryTabs?.length || row.workbench?.history?.length) this.#legacyDrafts.set(row.id, sanitizeConversationWorkbench(row.workbench))
        if (row.workbench?.templates?.length) this.#legacyTemplates.set(row.id, row.workbench.templates)
        this.#rows.set(row.id, {
          id: row.id,
          settings: row.settings,
          ...(row.protectedPassword ? { protectedPassword: row.protectedPassword } : {}),
          ...(row.protectedCa ? { protectedCa: row.protectedCa } : {}),
          ...(row.visibleSchemas?.length ? { visibleSchemas: row.visibleSchemas } : {}),
        })
      }
      if (this.#legacyDrafts.size || this.#legacyTemplates.size) this.persist()
      for (const [id, sqls] of this.#legacyTemplates) {
        const dialect = this.#rows.get(id)?.settings.dialect
        if (dialect === 'mysql' || dialect === 'oracle') void this.templates.ingestUnpublished(sqls, dialect)
      }
      this.#legacyTemplates.clear()
    }
    return this.#rows
  }
  private persist(): void {
    const lastActiveId = this.#lastActiveId && this.#rows!.has(this.#lastActiveId) ? this.#lastActiveId : undefined
    this.#lastActiveId = lastActiveId
    this.store.save({ connections: [...this.#rows!.values()], lastActiveId })
  }
  #layout(session: string, rows: Map<string, StoredDatabaseConnection>): ConversationLayout {
    const layout = this.conversations.load(session)
    let changed = false
    if (!this.#migratedOwners.has(session)) {
      this.#migratedOwners.add(session)
      for (const [id, draft] of this.#legacyDrafts) {
        if (!layout.workbenches[id]) { layout.workbenches[id] = draft; changed = true }
      }
    }
    if (changed) this.conversations.save(session, layout, new Set(rows.keys()))
    return layout
  }
  #bump(): void { this.#revision += 1 }
  #busyAdd(worker: Worker): void { this.#busy.set(worker, (this.#busy.get(worker) || 0) + 1) }
  #busyDone(worker: Worker): void {
    const next = (this.#busy.get(worker) || 1) - 1
    if (next <= 0) this.#busy.delete(worker)
    else this.#busy.set(worker, next)
  }
  #dropCache(id: string, generation?: string): void {
    for (const key of [...this.#cache.keys()]) {
      try {
        const parsed = JSON.parse(key) as unknown[]
        if (parsed[0] !== id) continue
        if (generation === undefined || parsed[1] === generation) this.#cache.delete(key)
      } catch { /* keep */ }
    }
  }
  #dropEntry(id: string, entry: Entry, reason: 'disconnect' | 'removed' | 'closed'): void {
    if (this.#entries.get(id) !== entry) return
    this.#clearRevive(id)
    this.#reviveAttempts.delete(id)
    this.#entries.delete(id)
    this.#clearCatalogLock(id)
    this.#dropCache(id, entry.connection.generation)
    this.#connectionRunning.delete(id)
    this.#bump()
    if (entry.connection.generation) this.#executions?.invalidateGeneration(id, entry.connection.generation, reason === 'removed' ? 'removed' : 'disconnect')
  }
  async #waitLifecycle(id: string, op: 'disconnect' | 'remove' | 'update'): Promise<void> {
    if (op === 'update' && this.#maintaining.has(id)) throw fail('维护操作正在执行，请等待结果后再编辑连接。', CONNECTION_ERROR_CODES.busy)
    await waitWhile(
      () => (
        (this.#readonlyActive.get(id) || 0) > 0
        || this.#connectionRunning.has(id)
        || (op !== 'update' && this.#maintaining.has(id))
        || (op !== 'update' && this.#editing.has(id))
      ),
      HOST_TIMEOUTS.queue,
      () => fail('连接正在处理请求，请稍后再试。', CONNECTION_ERROR_CODES.busy),
    )
  }
  #retireGeneration(id: string, entry: Entry, reason: 'disconnect' | 'removed'): void {
    const generation = entry.connection.generation
    entry.connection = { ...entry.connection, live: false, generation: undefined }
    this.#bump()
    if (generation) this.#executions?.invalidateGeneration(id, generation, reason)
  }
  #clearCatalogLock(id: string): void { this.#catalogLocks.delete(id) }
  async #withCatalog<T>(id: string, work: () => Promise<T>): Promise<T> {
    const previous = this.#catalogLocks.get(id) ?? Promise.resolve()
    let release!: () => void
    const held = new Promise<void>(resolve => { release = resolve })
    const chain = previous.then(() => held, () => held)
    this.#catalogLocks.set(id, chain)
    try {
      await previous
      return await work()
    } finally {
      release()
      if (this.#catalogLocks.get(id) === chain) this.#catalogLocks.delete(id)
    }
  }
  async #withReadonly<T>(id: string, work: () => Promise<T>, lane: 'manual' | 'ai' = 'ai'): Promise<T> {
    const started = Date.now()
    const perConnectionLimit = lane === 'ai' ? MAX_AI_READONLY : MAX_READONLY
    const globalLimit = lane === 'ai' ? MAX_GLOBAL_AI_READONLY : MAX_GLOBAL_READONLY
    const queueMessage = lane === 'ai'
      ? '此连接的 AI 查询排队已满（已为人工查询保留通道），请稍后重试。'
      : '连接排队已满，请稍后再试。'
    const blocked = () => (this.#readonlyActive.get(id) || 0) >= perConnectionLimit || this.#globalReadonly >= globalLimit || this.#maintaining.has(id)
    if (lane === 'ai' && blocked() && !this.#maintaining.has(id)) throw new Error(queueMessage)
    const queueMs = await waitWhile(blocked, HOST_TIMEOUTS.queue, () => new Error(queueMessage), started)
    this.#readonlyActive.set(id, (this.#readonlyActive.get(id) || 0) + 1)
    this.#globalReadonly += 1
    try {
      const result = await work()
      if (result && typeof result === 'object' && 'elapsedMs' in result) {
        const timings = { ...('timings' in result && result.timings && typeof result.timings === 'object' ? result.timings : {}), queueMs }
        Object.assign(result, { timings })
      }
      return result
    }
    finally {
      this.#readonlyActive.set(id, Math.max(0, (this.#readonlyActive.get(id) || 1) - 1))
      this.#globalReadonly = Math.max(0, this.#globalReadonly - 1)
    }
  }
  async #withMaintenance<T>(id: string, work: () => Promise<T>): Promise<T> {
    return this.#withCatalog(id, async () => {
      await waitWhile(() => (this.#readonlyActive.get(id) || 0) > 0, HOST_TIMEOUTS.queue, () => new Error('连接排队已满，请稍后再试。'))
      this.#maintaining.add(id)
      try { return await work() }
      finally { this.#maintaining.delete(id) }
    })
  }
  async restoreRemembered(session: string): Promise<void> {
    if (this.#closed || !this.sessionValid(session)) throw fail('当前对话已失效。', CONNECTION_ERROR_CODES.session)
    const run = async () => {
      const rows = [...this.ensure().values()].filter(row => canReuseSavedLogin({ dialect: row.settings.dialect, hasPassword: !!row.protectedPassword }) && !this.#entries.has(row.id))
      for (const row of rows) {
        if (this.#closed) return
        try {
          await this.open(session, { ...row.settings, password: '', useSavedPassword: true, rememberPassword: true }, false, row.id)
        } catch { /* leave offline; operator can log in from the workbench */ }
      }
    }
    while (this.#restoreRunning) await this.#restoreRunning
    const pending = run()
    this.#restoreRunning = pending
    try { await pending }
    finally { if (this.#restoreRunning === pending) this.#restoreRunning = undefined }
  }
  async update(session: string, id: string, raw: unknown): Promise<Connection> {
    if (this.#closed || !this.sessionValid(session) || !this.ensure().has(id)) throw fail('连接不存在或当前对话已失效。', CONNECTION_ERROR_CODES.session)
    await waitWhile(() => this.#editing.has(id), 15000, () => fail('此连接正在保存，请稍后再试。', CONNECTION_ERROR_CODES.busy))
    const originalSaved = this.#rows!.get(id)
    if (!originalSaved) throw fail('连接不存在或当前对话已失效。', CONNECTION_ERROR_CODES.offline)
    const entry = this.#entries.get(id)
    if (entry && this.#maintaining.has(id)) throw fail('维护操作正在执行，请等待结果后再编辑连接。', CONNECTION_ERROR_CODES.busy)
    await this.#waitLifecycle(id, 'update')
    const input = normalizeSourceConnection(raw)
    if (!input.password && !input.caPem && input.useSavedPassword && sameLogin(originalSaved.settings, input)) {
      if (originalSaved.settings.name !== input.name || originalSaved.settings.environment !== input.environment) {
        originalSaved.settings = { ...originalSaved.settings, name: input.name, environment: input.environment }
        if (entry) entry.connection = { ...entry.connection, name: input.name, environment: input.environment }
        this.persist()
        this.#bump()
      }
      if (entry?.connection.health === 'ready') {
        return structuredClone(publicConnection(originalSaved, entry.connection, this.#layout(session, this.#rows!).workbenches[id]))
      }
      if (entry) {
        this.#editing.add(id)
        try { return await this.#recover(session, id) }
        finally { this.#editing.delete(id) }
      }
    }
    this.#editing.add(id)
    try { return await this.open(session, raw, false, id) as Connection }
    finally { this.#editing.delete(id) }
  }
  async open(session: string, raw: unknown, testOnly: boolean, replaceId?: string): Promise<Connection | ConnectionTest> {
    if (this.#closed || !this.sessionValid(session)) throw fail('当前对话已失效。', CONNECTION_ERROR_CODES.session)
    const original = replaceId ? this.#entries.get(replaceId) : undefined
    const originalSaved = replaceId ? this.ensure().get(replaceId) : undefined
    if (replaceId && !originalSaved) throw fail('原连接已失效。', CONNECTION_ERROR_CODES.offline)
    if (original && this.#maintaining.has(replaceId!)) throw fail('维护操作正在执行，请等待结果后再编辑连接。', CONNECTION_ERROR_CODES.busy)
    const input = normalizeSourceConnection(raw)
    const runtime = getSourceRuntime(input.dialect)
    let secret = input.password
    if (!secret && input.useSavedPassword && originalSaved?.protectedPassword) secret = await this.store.resolvePassword(originalSaved)
    if (!secret && (hostModules.get(input.dialect).connection.requiresPassword?.(input) ?? runtime.requiresPassword)) throw new Error('请输入密码。')
    const usesCustomCa = runtime.usesCustomCa(input)
    let caPem = usesCustomCa ? input.caPem || '' : ''
    if (usesCustomCa && !caPem && originalSaved?.protectedCa) caPem = await this.store.resolveCa(originalSaved)
    const savedLogin = !testOnly && original && originalSaved && sameLogin(originalSaved.settings, input)
    if (savedLogin && !input.password && !input.caPem && input.useSavedPassword) {
      if (original.connection.health === 'ready') {
        return structuredClone(publicConnection(originalSaved, original.connection, this.#layout(session, this.#rows!).workbenches[replaceId!]))
      }
      return this.#recover(session, replaceId!)
    }
    // A supplied password may differ even when host/user/database are unchanged.
    // Authenticate it in a new worker before replacing the live connection.
    if (!testOnly && original && originalSaved && !sameLogin(originalSaved.settings, input)) {
      await this.open(session, { ...input, password: secret, caPem }, true)
    }
    const discount = original ? 1 : 0
    let releaseSlot!: () => void
    const previousSlot = this.#slotLock
    this.#slotLock = new Promise(resolve => { releaseSlot = resolve })
    await previousSlot
    let worker: Worker
    try {
      if (this.#entries.size + this.#attempts.size - discount >= MAX_LIVE || this.ensure().size - (replaceId ? 1 : 0) >= 100) {
        throw fail('连接数量已达上限，请先断开不用的连接。', CONNECTION_ERROR_CODES.busy)
      }
      const workerUrl = runtime.workerEntry === 'connection-worker.mjs' ? this.workerUrl : new URL(`./${runtime.workerEntry}`, import.meta.url)
      worker = this.workerFactory(workerUrl)
      this.#attempts.set(worker, session)
    } finally { releaseSlot() }
    let retained = false
    try {
      const payload = { ...input, password: secret, caPem }
      const result = await new Promise<ConnectionTest & { databases: string[] }>((resolve, reject) => {
        const timer = setTimeout(() => { reject(fail(connectTimeoutMessage(testOnly), CONNECTION_ERROR_CODES.timeout)); void worker.terminate() }, testOnly ? HOST_TIMEOUTS.connectTest : HOST_TIMEOUTS.connect)
        const finish = () => clearTimeout(timer)
        worker.once('message', message => { finish(); (message.ready || message.ok) ? resolve(message.result) : reject(new Error(message.error || '连接已中断。')) })
        worker.once('error', err => {
          console.warn('[database] connection worker failed during init', err)
          finish()
          reject(new Error(workerInitFailureMessage(err)))
        })
        worker.once('exit', () => { finish(); reject(fail('连接已关闭。', CONNECTION_ERROR_CODES.closed)) })
        worker.postMessage({ input: payload, testOnly }); payload.password = ''; payload.caPem = ''; input.password = ''
      })
      if (this.#closed || !this.sessionValid(session)) throw fail('当前对话已失效，连接已关闭。', CONNECTION_ERROR_CODES.session)
      if (testOnly) { secret = ''; return { version: result.version, database: result.database, elapsedMs: result.elapsedMs } }
      if (replaceId && (this.#entries.get(replaceId) !== original || this.#rows!.get(replaceId) !== originalSaved)) throw fail('原连接已变化或被删除，请刷新后重试。', CONNECTION_ERROR_CODES.stale)
      const { password: _password, caPem: _caPem, rememberPassword, useSavedPassword: _use, ...baseSettings } = input
      const settings: SourceConnectionSettings = hostModules.get(input.dialect).connection.toSavedSettings?.(input, caPem) || baseSettings
      const id = replaceId || randomUUID()
      let protectedPassword = originalSaved?.protectedPassword
      let protectedCa: string | undefined
      let passwordWarning: string | undefined
      if (rememberPassword && secret) {
        try { protectedPassword = await this.store.protectPassword(id, secret) }
        catch { passwordWarning = '连接已成功，但密码无法加密保存；已只保存连接信息'; protectedPassword = undefined }
      } else {
        protectedPassword = undefined
      }
      if (usesCustomCa && caPem) {
        try { protectedCa = await this.store.protectCa(id, caPem) }
        catch { passwordWarning = '连接已成功，但自定义 CA 无法加密保存；重启后需重新输入 CA。' }
      }
      secret = ''
      const connection: Connection = { id, generation: randomUUID(), name: input.name, dialect: input.dialect, environment: input.environment, database: result.database, version: result.version, live: true, health: 'ready', databases: result.databases?.length ? result.databases : [], settings }
      const stored = keepVisibleSchemas(originalSaved, { id, settings, ...(protectedPassword ? { protectedPassword } : {}), ...(protectedCa ? { protectedCa } : {}) })
      this.#rows!.set(id, stored)
      this.persist()
      this.#entries.set(id, { session, worker, connection, touched: Date.now() }); retained = true
      this.#bump()
      const drop = () => {
        const current = this.#entries.get(id)
        if (current?.worker === worker) {
          current.unexpectedlyClosed = true
          this.#dropEntry(id, current, 'closed')
        }
      }
      worker.on('message', message => {
        const current = this.#entries.get(id)
        if (current?.worker !== worker) return
        if (message.closed) { drop(); void worker.terminate(); return }
        if (message.health) this.#applyHealth(current, message.health)
      })
      worker.on('exit', drop)
      if (original) {
        const previous = original.connection.generation
        await original.worker.terminate()
        if (previous) this.#executions?.invalidateGeneration(id, previous, 'reconnect')
      }
      return structuredClone({ ...publicConnection(stored, connection, this.#layout(session, this.#rows!).workbenches[id]), passwordWarning })
    } finally { input.password = ''; input.caPem = ''; secret = ''; caPem = ''; this.#attempts.delete(worker); if (!retained) await worker.terminate() }
  }
  async remove(session: string, id: string): Promise<void> {
    const entry = this.#entries.get(id)
    if (this.#closed || !this.sessionValid(session) || !this.ensure().has(id)) throw fail('连接不存在或当前对话已失效。', CONNECTION_ERROR_CODES.session)
    if (entry) this.#retireGeneration(id, entry, 'removed')
    try { await this.#waitLifecycle(id, 'remove') } catch { /* still drop the connection */ }
    this.#rows!.delete(id)
    if (this.#lastActiveId === id) this.#lastActiveId = undefined
    this.persist()
    if (entry && this.#entries.get(id) === entry) this.#dropEntry(id, entry, 'removed')
    else this.#bump()
    this.#executions?.invalidateConnection(id, 'removed')
    await entry?.worker.terminate()
  }
  async disconnect(session: string, id: string): Promise<void> {
    if (this.#closed || !this.sessionValid(session) || !this.ensure().has(id)) throw fail('连接不存在或当前对话已失效。', CONNECTION_ERROR_CODES.session)
    const entry = this.#entries.get(id)
    if (!entry) return
    this.#retireGeneration(id, entry, 'disconnect')
    try { await this.#waitLifecycle(id, 'disconnect') } catch { /* still terminate the worker */ }
    if (this.#entries.get(id) === entry) this.#dropEntry(id, entry, 'disconnect')
    await entry.worker.terminate()
  }
  async releaseOwner(session: string): Promise<void> {
    const workers: Worker[] = []
    for (const [worker, attemptSession] of this.#attempts) if (attemptSession === session) workers.push(worker)
    await Promise.allSettled(workers.map(worker => worker.terminate()))
    this.#executions?.cancelConversation(session, '对话已删除。')
  }
  async catalog(session: string, id: string, generation: unknown, input: CatalogRequest, signal?: AbortSignal): Promise<CatalogResult> {
    return this.request(session, id, generation, 'catalog', input, signal)
  }
  async redisRequest(session: string, id: string, generation: unknown, action: 'redis-command' | 'redis-scan' | 'redis-key-suggest' | 'redis-key', raw: unknown, signal?: AbortSignal, initiator: 'user' | 'ai' = 'user', options?: { queryRevision?: number; record?: boolean; context?: Record<string, string> }): Promise<Record<string, unknown>> {
    const entry = this.#entries.get(id)
    if (!entry || !getSourceRuntime(entry.connection.dialect).actions.includes(action)) throw fail('请选择有效的 Redis 连接。', CONNECTION_ERROR_CODES.offline)
    const input = raw && typeof raw === 'object' ? raw as ServiceRequest : {}
    let database = input.database === undefined || input.database === '' ? undefined : String(input.database)
    if (database !== undefined) database = assertRedisDatabaseId(database)
    const mode = entry.connection.settings && 'redisMode' in entry.connection.settings ? entry.connection.settings.redisMode : undefined
    assertRedisClusterDatabase(database, mode)
    if (initiator === 'ai') {
      const current = this.getExecutionDocument(session, id, generation)
      if (action === 'redis-command' && options?.queryRevision !== undefined) redisAiDispatchAllowed(current, options.queryRevision, String(input.command || ''))
      else if (current.controller !== 'ai') throw new Error('用户已接管 AI Query，无法继续操作 Redis。')
      const selected = current.context.database || entry.connection.database
      if (selected) database = assertRedisDatabaseId(selected)
      assertRedisClusterDatabase(database, mode)
    }
    const prepared = redisPreparedInput(action, input, database)
    const capturedDocument = initiator === 'ai' || options?.queryRevision !== undefined
      ? this.getExecutionDocument(session, id, generation) : undefined
    const send = (workSignal?: AbortSignal) => this.#withReadonly(id, () => {
      if (capturedDocument) {
        const current = this.getExecutionDocument(session, id, generation)
        if (current.revision !== (options?.queryRevision ?? capturedDocument.revision)
          || current.controller !== initiator || current.text !== capturedDocument.text
          || JSON.stringify(current.context) !== JSON.stringify(options?.context ?? capturedDocument.context)) {
          throw new Error('AI Query 已被修改、接管或切换目标，操作没有发出。')
        }
      }
      return this.#dispatch(session, id, generation, action, prepared, workSignal ?? signal)
    }, 'manual') as Promise<Record<string, unknown>>
    if (redisCommandRecordsHistory(action, initiator, options?.record)) {
      const commandName = String((prepared.args as string[])[0] || '').toUpperCase()
      return recordUserRedisCommand(this.#executions, {
        owner: session, connectionId: id, generation: entry.connection.generation!, connectionName: entry.connection.name,
        sourceId: 'redis', environment: entry.connection.environment,
      }, commandName, send, signal)
    }
    return send()
  }
  async executeText(session: string, id: string, generation: unknown, text: unknown, signal?: AbortSignal, initiator: 'user' | 'ai' = 'user', callId?: string, queryRevision?: number, rootCallId?: string, context?: unknown): Promise<Record<string, unknown>> {
    const entry = this.#entries.get(id)
    if (!entry || this.#closed || !this.sessionValid(session) || entry.connection.generation !== generation) throw fail('连接已变化或当前对话已失效，请刷新。', CONNECTION_ERROR_CODES.stale)
    const execution = hostModules.get(entry.connection.dialect).execution
    if (execution.mode !== 'standard-text') throw new Error('此数据源尚未接入通用文本执行入口。')
    const normalized = execution.normalizeContext(context, entry.connection)
    const prepared = execution.prepareText(text, normalized)
    execution.authorize(prepared, initiator, entry.connection)
    if (!prepared || !getSourceRuntime(entry.connection.dialect).actions.includes(prepared.action)) throw new Error('此数据源尚未接入通用文本执行入口。')
    const binding = { owner: session, connectionId: id, generation: entry.connection.generation!, connectionName: entry.connection.name,
      sourceId: entry.connection.dialect, environment: entry.connection.environment }
    return runOperation(this.#executions, binding, { operation: prepared.operation, title: prepared.title,
      initiator, callId, queryRevision, rootCallId }, async workSignal => {
      const result = await this.#withReadonly(id, () => {
        if (queryRevision !== undefined) {
          const current = this.getExecutionDocument(session, id, generation)
          if (current.controller !== initiator || current.revision !== queryRevision || current.text !== text
            || JSON.stringify(execution.normalizeContext(current.context, entry.connection)) !== JSON.stringify(normalized)) {
            throw new Error('AI Query 已被人工修改或接管，操作没有发出。')
          }
        }
        return this.#dispatch(session, id, generation, prepared.action, prepared.input, workSignal)
      }, 'manual')
      return result as Record<string, unknown>
    }, prepared.summarize, signal, prepared.classifyResult)
  }
  async request(session: string, id: string, generation: unknown, action: ServiceRequestAction, input: ServiceRequest, signal?: AbortSignal, authorized?: TrustedAuthorization): Promise<CatalogResult> {
    if (!input || (action === 'catalog' && !['schemas', 'schema', 'tables', 'table', 'indexes'].includes(input.kind || ''))) throw new Error('目录请求无效。')
    if (signal?.aborted) throw fail('请求已取消。', CONNECTION_ERROR_CODES.cancelled)
    const run = () => this.#dispatch(session, id, generation, action, input, signal, authorized)
    if (action === 'catalog') return this.#withCatalog(id, run)
    if (action === 'maintenance') return this.#withMaintenance(id, run)
    return this.#withReadonly(id, run, action === 'query' ? 'ai' : 'manual')
  }
  async #dispatch(session: string, id: string, generation: unknown, action: string, input: ServiceRequest, signal?: AbortSignal, authorized?: TrustedAuthorization): Promise<CatalogResult> {
    if (signal?.aborted) throw fail('请求已取消。', CONNECTION_ERROR_CODES.cancelled)
    const entry = this.#entries.get(id)
    if (!entry || this.#closed || !this.sessionValid(session)) throw fail('连接已变化或当前对话已失效，请刷新。', CONNECTION_ERROR_CODES.stale)
    if (entry.connection.health === 'offline' || (!entry.connection.live && entry.connection.health !== 'degraded')) throw fail('请先连接数据库。', CONNECTION_ERROR_CODES.offline)
    if (entry.connection.generation !== generation) throw fail('连接已变化或当前对话已失效，请刷新。', CONNECTION_ERROR_CODES.stale)
    if (!getSourceRuntime(entry.connection.dialect).actions.includes(action)) throw new Error('请求与数据源类型不匹配。')
    if (this.#editing.has(id)) throw fail('连接正在更新，请等待连接保存完成。', CONNECTION_ERROR_CODES.busy)
    if (typeof input.schema === 'string' && input.schema.trim() && !connectionOwnsSchema(entry.connection, input.schema)) {
      throw new Error('当前连接无权访问此数据库。')
    }
    entry.touched = Date.now()
    const key = JSON.stringify([id, generation, { ...input, refresh: false }])
    if (action === 'catalog' && input.refresh) this.#dropCache(id, typeof generation === 'string' ? generation : undefined)
    const cached = this.#cache.get(key)
    if (action === 'catalog' && cached && !input.refresh && Date.now() - cached.time < 60000) return structuredClone(cached.value)
    this.#busyAdd(entry.worker)
    const requestId = randomUUID()
    try {
      const result = await new Promise<CatalogResult>((resolve, reject) => {
        let progress: Record<string, unknown> | undefined
        let settled = false
        const finish = (error?: Error, value?: CatalogResult) => {
          if (settled) return
          settled = true
          clearTimeout(timer)
          signal?.removeEventListener('abort', cancel)
          entry.worker.off('message', message)
          entry.worker.off('exit', exited)
          error ? reject(error) : resolve(value!)
        }
        const terminateWorker = (text: string) => {
          if (progress && !this.#closed && (this.#entries.get(id) === entry || (entry.unexpectedlyClosed && !this.#entries.has(id))) && this.sessionValid(session)) finish(undefined, { ...progress, status: 'unknown', message: text, collectedAt: new Date().toISOString(), source: '插件已接收的 DDL 逐步执行回执' })
          else finish(new Error(text))
          if (this.#entries.get(id) === entry) { this.#dropEntry(id, entry, 'closed') }
          void entry.worker.terminate()
        }
        const cancel = () => {
          try { entry.worker.postMessage({ cancel: true, requestId }) } catch { /* worker already gone */ }
          if (action === 'maintenance') terminateWorker('读取已取消；已开始的维护步骤结果可能未知，请核验。')
          else if (action === 'redis-command' || action === 'redis-key') finish(new Error('Redis 操作已取消，执行结果未知，请核验。'))
          else if (action !== 'catalog') finish(new Error('读取已取消。'))
        }
        const exited = () => {
          if (action === 'maintenance') terminateWorker('连接已关闭；已开始的维护步骤结果可能未知，请重新连接并核验。')
          else finish(action === 'redis-command' || action === 'redis-key' ? new Error('Redis 连接已关闭，执行结果未知，请核验。') : fail('连接已关闭。', CONNECTION_ERROR_CODES.closed))
        }
        const message = (reply: { requestId?: string; error?: string; code?: string; result?: CatalogResult; progress?: Record<string, unknown>; cancelled?: boolean }) => {
          if (reply.requestId !== requestId) return
          if (this.#entries.get(id) !== entry || !this.sessionValid(session)) finish(fail('连接或对话已变化，已丢弃迟到结果。', CONNECTION_ERROR_CODES.stale))
          else if (reply.progress) { progress = reply.progress; return }
          else if (reply.cancelled || signal?.aborted) finish(action === 'redis-command' || action === 'redis-key' ? new Error('Redis 操作已取消，执行结果未知，请核验。') : fail('读取已取消。', CONNECTION_ERROR_CODES.cancelled))
          else finish(reply.error ? workerError(reply.error, reply.code) : undefined, reply.result)
        }
        const timer = setTimeout(() => {
          try { entry.worker.postMessage({ cancel: true, requestId }) } catch { /* ignore */ }
          const deadline = hostDeadlineFor(action)
          if (action === 'maintenance') terminateWorker(hostTimeoutMessage(action, deadline))
          else finish(new Error(action === 'redis-command' || action === 'redis-key' ? 'Redis 操作超时，执行结果未知，请核验。' : hostTimeoutMessage(action, deadline)))
        }, hostDeadlineFor(action))
        entry.worker.on('message', message); entry.worker.once('exit', exited); signal?.addEventListener('abort', cancel, { once: true })
        entry.worker.postMessage({ requestId, action, input: { ...input, conversationId: session }, ...(authorized ? { authorized } : {}) })
      })
      if (this.#cache.size >= 64) this.#cache.delete(this.#cache.keys().next().value!)
      if (action === 'catalog') this.#cache.set(key, { time: Date.now(), value: result })
      if (action === 'catalog' && input.kind === 'schemas' && Array.isArray(result.items)) {
        const names = result.items.map(row => catalogSchemaName(row as Record<string, unknown>)).filter(Boolean).slice(0, 200)
        entry.connection = { ...entry.connection, databases: names }
      }
      if (action === 'maintenance') {
        this.#dropCache(id)
        const executionId = typeof input.executionId === 'string' ? input.executionId : ''
        if (executionId && input.kind === 'execute') this.#executions?.observeMaintenance(session, executionId, { status: typeof result.status === 'string' ? result.status : undefined, message: typeof result.message === 'string' ? result.message : undefined })
      }
      this.#reviveAttempts.delete(id)
      this.#clearRevive(id)
      return action === 'catalog' ? structuredClone(result) : result
    } finally { this.#busyDone(entry.worker) }
  }
  #applyHealth(entry: Entry, health: Connection['health']): void {
    if (!health) return
    const id = entry.connection.id
    if (entry.connection.health === health) {
      if (health === 'ready') { this.#clearRevive(id); this.#reviveAttempts.delete(id) }
      return
    }
    const live = health === 'ready' || health === 'degraded'
    entry.connection = { ...entry.connection, health, live }
    this.#bump()
    if (health === 'ready') {
      this.#clearRevive(id)
      this.#reviveAttempts.delete(id)
    } else if (health === 'degraded' || health === 'offline') {
      this.#scheduleRevive(id, entry)
    }
  }
  #clearRevive(id: string): void {
    const timer = this.#reviveTimers.get(id)
    if (timer) clearTimeout(timer)
    this.#reviveTimers.delete(id)
  }
  #scheduleRevive(id: string, entry: Entry): void {
    if (this.#closed || this.#entries.get(id) !== entry) return
    if (this.#reviveTimers.has(id)) return
    const attempts = this.#reviveAttempts.get(id) || 0
    if (attempts >= MAX_REVIVE_ATTEMPTS) return
    const delay = REVIVE_DELAYS_MS[Math.min(attempts, REVIVE_DELAYS_MS.length - 1)]
    const timer = setTimeout(() => { void this.#runRevive(id, entry) }, delay)
    timer.unref()
    this.#reviveTimers.set(id, timer)
  }
  async #runRevive(id: string, entry: Entry): Promise<void> {
    this.#reviveTimers.delete(id)
    if (this.#closed || this.#entries.get(id) !== entry) return
    if (this.#busy.get(entry.worker) || this.#maintaining.has(id) || this.#editing.has(id)) {
      this.#scheduleRevive(id, entry)
      return
    }
    const attempts = (this.#reviveAttempts.get(id) || 0) + 1
    this.#reviveAttempts.set(id, attempts)
    try {
      await this.#rpc(entry, 'revive', {}, HOST_TIMEOUTS.connect)
    } catch {
      if (this.#entries.get(id) !== entry) return
      if (attempts >= MAX_REVIVE_ATTEMPTS) {
        entry.connection = { ...entry.connection, live: false, health: 'offline' }
        this.#bump()
        this.#clearRevive(id)
        return
      }
      this.#scheduleRevive(id, entry)
    }
  }
  async #rpc(entry: Entry, action: string, input: Record<string, unknown>, timeout: number): Promise<CatalogResult & ConnectionTest & { health?: string }> {
    const requestId = randomUUID()
    this.#busyAdd(entry.worker)
    try {
      return await new Promise((resolve, reject) => {
        let settled = false
        const finish = (error?: Error, value?: CatalogResult & ConnectionTest & { health?: string }) => {
          if (settled) return
          settled = true
          clearTimeout(timer)
          entry.worker.off('message', onMessage)
          entry.worker.off('exit', onExit)
          error ? reject(error) : resolve(value!)
        }
        const onExit = () => finish(fail('连接已关闭。', CONNECTION_ERROR_CODES.closed))
        const onMessage = (reply: { requestId?: string; error?: string; code?: string; result?: CatalogResult & ConnectionTest; health?: Connection['health'] }) => {
          if (reply.requestId !== requestId) return
          if (reply.health) this.#applyHealth(entry, reply.health)
          if (reply.error) finish(workerError(reply.error, reply.code))
          else finish(undefined, reply.result)
        }
        const timer = setTimeout(() => finish(fail(connectTimeoutMessage(false), CONNECTION_ERROR_CODES.timeout)), timeout)
        entry.worker.on('message', onMessage)
        entry.worker.once('exit', onExit)
        entry.worker.postMessage({ requestId, action, input })
      })
    } finally { this.#busyDone(entry.worker) }
  }
  async #recover(session: string, id: string): Promise<Connection> {
    const entry = this.#entries.get(id)
    const stored = this.#rows!.get(id)
    if (!entry || !stored) throw fail('连接不存在或当前对话已失效。', CONNECTION_ERROR_CODES.offline)
    await this.#waitLifecycle(id, 'update')
    try {
      const result = await this.#rpc(entry, 'revive', {}, HOST_TIMEOUTS.connect)
      entry.connection = {
        ...entry.connection,
        live: true,
        health: 'ready',
        version: result.version || entry.connection.version,
        database: result.database || entry.connection.database,
      }
      this.#reviveAttempts.delete(id)
      this.#clearRevive(id)
      this.#bump()
      return structuredClone(publicConnection(stored, entry.connection, this.#layout(session, this.#rows!).workbenches[id]))
    } catch (error) {
      entry.connection = { ...entry.connection, live: false, health: 'offline' }
      this.#clearRevive(id)
      this.#bump()
      throw error
    }
  }
  async dispose(): Promise<void> {
    this.#closed = true
    for (const id of [...this.#reviveTimers.keys()]) this.#clearRevive(id)
    this.#reviveAttempts.clear()
    const workers = [...this.#entries.values()].map(e => e.worker).concat([...this.#attempts.keys()])
    this.#entries.clear(); this.#attempts.clear(); this.#cache.clear(); this.#catalogLocks.clear(); this.#rows = undefined
    await Promise.allSettled(workers.map(worker => worker.terminate()))
    await this.#executions?.dispose()
  }
}

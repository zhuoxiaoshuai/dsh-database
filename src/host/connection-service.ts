import { Worker } from 'node:worker_threads'
import { randomUUID } from 'node:crypto'
import type { Connection, ConnectionTest, CatalogRequest, CatalogResult, ConnectionWorkbench, DatabaseWorkspaceSnapshot, QueryEditSource, Result, SharedQuery, SourceConnectionInput, SourceConnectionSettings } from '../shared/workbench.ts'
import type { DataSourceId } from '../shared/data-sources/types.ts'
import { connectionFingerprint, validateConnection, canReuseSavedLogin } from '../shared/connection-input.ts'
import { publicConnection, SavedDatabaseConnections, uniqueCopyName, type StoredDatabaseConnection } from './saved-connections.ts'
import { ConversationWorkbenchStore, sanitizeConversationWorkbench, type ConversationLayout } from './conversation-workbench-store.ts'
import { SqlTemplateStore } from './sql-template-store.ts'
import { KnowledgeService } from './knowledge-service.ts'
import { ExplorerService } from './explorer-service.ts'
import type { ExplorerListInput, ExplorerReadInput } from '../shared/explorer.ts'
import type { PasswordProtector } from '../password-protector.ts'
import type { ExecutionStore } from './execution-store.ts'
import { authorizeStatement, splitStatements } from './query-policy.mjs'
import { catalogSchemaName, coerceVisibleSchemas, connectionOwnsSchema, sharedQuerySurface } from '../shared/workbench.ts'
import { inferExecutionType } from '../shared/execution.ts'
import { HOST_TIMEOUTS, connectTimeoutMessage, hostDeadlineFor, hostTimeoutMessage } from './request-timeouts.mjs'
import { nativeErrorText } from './connect-error.mjs'
import { CONNECTION_ERROR_CODES, ServiceError, type ConnectionErrorCode } from '../shared/connection-errors.ts'
import type { ServiceRequestAction } from '../shared/database-actions.ts'
import { DEFAULT_QUERY_PAGE_SIZE } from '../shared/limits.ts'
import { controlExecutionDocument, emptyExecutionDocument, updateExecutionDocument, type ExecutionDocument } from '../shared/execution-document.ts'
import { getSourceRuntime } from './data-sources/runtime-registry.mjs'
import { runOperation } from './operation-runtime.ts'
import { assertRedisClusterDatabase, assertRedisDatabaseId, redisPreparedInput } from './redis-request.ts'
import { prepareTextOperation, authorizeTextOperation } from './text-execution.ts'
import type { TextEntryOptions } from './data-sources/module-types.ts'
import type { DocumentExecutionIdentity, ExecutionType } from '../shared/execution.ts'
import { sqlOperationBinding, sqlOperationMetadata, sqlCompletion, sqlModel, sqlFailureMessage } from './sql-operation.ts'
import { prepareCatalogTool, catalogToolFailure, type CatalogToolInput } from './sql-catalog-operation.ts'
import { prepareRedisReadOperation, type RedisReadTool } from './data-sources/redis/read-operation.ts'
import { unwrapExplainSql } from '../shared/sql-text.ts'
import { parseBrowserQueryUpdate, validateBrowserFormat } from './sql-browser-request.ts'
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
  lane?: 'manual' | 'query'
}

async function waitWhile(blocked: () => boolean, timeoutMs: number, timeoutError: () => Error, started = Date.now()): Promise<number> {
  while (blocked()) {
    if (Date.now() - started > timeoutMs) throw timeoutError()
    await new Promise(resolve => setTimeout(resolve, 20))
  }
  return Date.now() - started
}

function workerInitFailureMessage(error: unknown): string {
  const detail = nativeErrorText(error)
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
        if (['password', 'caPem', 'rememberPassword', 'useSavedPassword'].some(key => raw[key] !== undefined && raw[key] !== '' && raw[key] !== false)) throw new Error('导入不接收密码或凭据，请在连接时输入。')
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
  get storageDegraded(): boolean { return this.conversations.storageDegraded }
  getSharedQuery(session: string, id: string): SharedQuery {
    const d = this.getExecutionDocument(session, id)
    const record = this.#executions?.list(session).find(r => r.connectionId === id && r.generation === this.#entries.get(id)?.connection.generation
      && r.queryRevision === d.revision && r.documentText === d.text && r.schema === (d.context.schema || '')
      && ['query', 'write', 'explain'].includes(r.type || '') && !(r.initiator === 'ai' && d.controller === 'user'))
    const result = record && this.#executions?.get(session, record.executionId, true)?.result
    return { sql: d.text, schema: d.context.schema || '', revision: d.revision, controller: d.controller, controllerReason: d.controllerReason,
      ...(record ? { lastExecutionId: record.executionId, lastRun: { executionId: record.executionId, columns: result?.columns || [], rowCount: result?.rows.length || 0,
        truncated: result?.truncated || false, elapsedMs: result?.elapsedMs || 0, message: record.message || result?.message, at: record.updatedAt } } : {}) }

  }
  getExecutionDocument(session: string, id: string, generation?: unknown): ExecutionDocument {
    if (this.#closed || !this.sessionValid(session)) throw new Error('当前对话已失效。')
    const saved = this.ensure().get(id)
    if (!saved) throw new Error('连接不存在。')
    if (generation !== undefined && this.#entries.get(id)?.connection.generation !== generation) throw new Error('连接已变化，请刷新。')
    const workbench = this.#layout(session, this.#rows!).workbenches[id]
    if (workbench?.aiDocument?.sourceId === saved.settings.dialect) return workbench.aiDocument
    const old = workbench?.sharedQuery
    return old && getSourceRuntime(saved.settings.dialect).documentKind === 'sql'
      ? { sourceId: saved.settings.dialect, text: old.sql, context: { schema: old.schema || ('database' in saved.settings ? saved.settings.database : '') }, revision: old.revision, controller: old.controller, controllerReason: old.controllerReason }
      : emptyExecutionDocument(saved.settings.dialect, getSourceRuntime(saved.settings.dialect).documentKind === 'sql' ? { schema: 'database' in saved.settings ? saved.settings.database : '' } : saved.settings.dialect === 'redis' ? { database: saved.settings.database } : {})
  }
  #saveDocument(session: string, id: string, document: ExecutionDocument): ExecutionDocument {
    const layout = this.#layout(session, this.#rows!)
    layout.workbenches[id] = sanitizeConversationWorkbench({ ...layout.workbenches[id], aiDocument: document })
    this.conversations.save(session, layout, new Set(this.#rows!.keys()))
    this.#executions?.emitWorkbench(session, { type: 'EXECUTION_DOCUMENT_CHANGED', connectionId: id, generation: this.#entries.get(id)?.connection.generation, document })
    return document
  }
  updateExecutionDocument(session: string, id: string, text: string, source: 'ai' | 'user' | 'system', expectedRevision?: number, generation?: unknown, context?: unknown): ExecutionDocument {
    if (!Number.isSafeInteger(expectedRevision) || !expectedRevision) throw new Error('缺少有效文档修订，请刷新。')
    const previous = this.getExecutionDocument(session, id, generation)
    const binding = this.#entries.get(id)?.connection || this.list(session).find(item => item.id === id)!
    const normalized = context === undefined ? undefined : hostModules.get(previous.sourceId).execution.normalizeContext(context, binding)
    const next = updateExecutionDocument(previous, text, source, expectedRevision, normalized)
    return next === previous ? previous : this.#saveDocument(session, id, next)
  }
  assertBrowserDocumentRequest(session: string, id: string, generation: unknown, revision: unknown): void {
    if (!Number.isSafeInteger(revision) || (revision as number) < 1) throw new Error('缺少有效文档修订，请刷新。')
    const document = this.getExecutionDocument(session, id, generation)
    if (document.revision !== revision) throw new Error('AI Query 已变化，请刷新后再试。')
    if (this.#entries.has(id) && typeof generation !== 'string') throw new Error('缺少连接代次，请刷新。')
  }
  updateExecutionDocumentFromBrowser(session: string, id: string, input: Record<string, unknown>): ExecutionDocument {
    this.assertBrowserDocumentRequest(session, id, input.generation, input.revision)
    if (typeof input.text !== 'string' || !['user', 'format'].includes(String(input.source ?? 'user'))) throw new Error('浏览器不能使用此文档更新来源。')
    const previous = this.getExecutionDocument(session, id)
    if (input.source === 'format') {
      if (getSourceRuntime(previous.sourceId).documentKind !== 'sql') throw new Error('此数据源不支持 SQL 格式化。')
      validateBrowserFormat(this.getSharedQuery(session, id), { sql: input.text, schema: (input.context as {schema?: string})?.schema }, previous.sourceId, input.revision as number)
    }
    return this.updateExecutionDocument(session, id, input.text, input.source === 'format' ? 'system' : 'user', input.revision as number, input.generation, input.context)
  }
  updateSharedQueryFromBrowser(session: string, id: string, input: Record<string, unknown>): SharedQuery {
    const update = parseBrowserQueryUpdate(input)
    const current = this.getSharedQuery(session, id)
    // Old offline callers carry a revision without a live generation.
    if (this.#entries.has(id)) this.assertBrowserDocumentRequest(session, id, input.generation, update.revision)
    if (update.source === 'format') validateBrowserFormat(current, update.patch, this.getExecutionDocument(session, id).sourceId, update.revision)
    return this.updateSharedQuery(session, id, update.patch, update.source === 'format' ? 'system' : 'user', update.revision)
  }
  patchExecutionDocumentContext(session: string, id: string, context: string | Record<string, unknown>, generation?: unknown, expectedRevision?: number): ExecutionDocument {
    const previous = this.getExecutionDocument(session, id, generation)
    return this.updateExecutionDocument(session, id, previous.text, 'system', expectedRevision, generation, typeof context === 'string' ? { database: context } : context)
  }
  controlExecutionDocument(session: string, id: string, controller: 'ai' | 'user', reason = 'user-takeover', generation?: unknown, revision?: number): ExecutionDocument {
    if (!Number.isSafeInteger(revision) || !revision) throw new Error('缺少有效文档修订，请刷新。')
    const previous = this.getExecutionDocument(session, id, generation)
    if (revision !== undefined && revision !== previous.revision) throw new Error('AI Query 已变化，请刷新后再试。')
    const next = controlExecutionDocument(previous, controller, reason)
    return next === previous ? previous : this.#saveDocument(session, id, next)
  }
  async runExecutionDocument(session: string, id: string, generation: unknown, revision: number, signal?: AbortSignal, text?: string): Promise<Record<string, unknown>> {
    this.assertBrowserDocumentRequest(session, id, generation, revision)
    const document = this.getExecutionDocument(session, id, generation)
    if (document.controller !== 'user') throw new Error('请先接管 AI Query。')
    if (getSourceRuntime(document.sourceId).documentKind === 'sql' && text !== undefined && !document.text.includes(unwrapExplainSql(text))) throw new Error('执行文本不属于当前文档。')
    if (getSourceRuntime(document.sourceId).documentKind === 'sql') return this.runSharedQuery(session, {
      connectionId: id, generation, schema: document.context.schema || '', sql: text ?? document.text, revision, initiator: 'user', purpose: 'result',
    }, signal)
    return this.executeText(session, id, generation, text ?? document.text, signal, 'user', undefined, revision, undefined, document.context)
  }
  updateSharedQuery(session: string, id: string, patch: Partial<SharedQuery>, source: QueryEditSource, revision?: number): SharedQuery {
    const previous = this.getExecutionDocument(session, id)
    this.updateExecutionDocument(session, id, patch.sql ?? previous.text, source === 'format' ? 'system' : source, revision, undefined,
      patch.schema === undefined ? undefined : { schema: patch.schema })
    return this.getSharedQuery(session, id)
  }
  takeSharedQuery(session: string, id: string, reason = 'user-takeover', revision?: number): SharedQuery {
    this.controlExecutionDocument(session, id, 'user', reason, undefined, revision)
    return this.getSharedQuery(session, id)
  }
  returnSharedQuery(session: string, id: string, revision?: number): SharedQuery {
    this.controlExecutionDocument(session, id, 'ai', 'return-ai', undefined, revision)
    return this.getSharedQuery(session, id)
  }
  async runSharedQuery(session: string, input: { connectionId: string; generation: unknown; schema: string; sql: string; revision?: number; initiator: 'ai' | 'user'; callId?: string; rootCallId?: string; limit?: number; purpose?: string }, signal?: AbortSignal): Promise<Record<string, unknown>> {
    const id = input.connectionId, document = this.getExecutionDocument(session, id, input.generation)
    const connection = this.#entries.get(id)?.connection
    if (!connection?.live || getSourceRuntime(document.sourceId).documentKind !== 'sql') throw new Error('请先连接数据库。')
    if (input.revision !== undefined && input.revision !== document.revision) throw new Error('AI Query 已变化，请重新读取后再试。')
    if (document.controller !== input.initiator) throw new Error(input.initiator === 'ai' ? '用户已接管 AI Query。' : '请先接管 AI Query。')
    const sql = input.sql || document.text, schema = input.schema || document.context.schema || connection.database
    if (input.initiator === 'user' && !document.text.includes(unwrapExplainSql(sql))) throw new Error('执行文本不属于当前文档。')
    if (input.initiator === 'ai' && splitStatements(sql, connection.dialect).length > MAX_AI_STATEMENTS) throw new Error(`一次最多执行 ${MAX_AI_STATEMENTS} 条 SQL。`)
    const surface = input.initiator === 'user' ? 'result' : sharedQuerySurface(sql, input.purpose)
    if (input.initiator === 'ai' && surface === 'result') this.updateExecutionDocument(session, id, sql, 'ai', document.revision, input.generation, { schema })
    else if (input.initiator === 'user' && schema !== document.context.schema) throw new Error('AI Query 执行目标已变化。')
    const published = this.getExecutionDocument(session, id)
    return this.executeText(session, id, input.generation, sql, signal, input.initiator, input.callId, published.revision, input.rootCallId, { schema },
      { type: inferExecutionType(input.initiator === 'ai' ? 'database_execute_sql' : 'workbench_shared_query', surface),
        sql: { sourceKind: 'sql', entry: 'shared-query', input: { sql, schema, limit: input.limit ?? DEFAULT_QUERY_PAGE_SIZE } } })
  }
  async explainPlan(session: string, id: string, generation: unknown, input: { schema: string; sql: string; revision?: number; initiator?: 'ai' | 'user'; callId?: string; rootCallId?: string }, signal?: AbortSignal): Promise<Result & { executionId?: string }> {
    const d = this.getExecutionDocument(session, id, generation)
    if (input.revision !== undefined && input.revision !== d.revision) throw new Error('AI Query 已变化，请刷新。')
    const result = await this.executeText(session, id, generation, input.sql, signal, input.initiator || 'ai', input.callId, d.revision, input.rootCallId, { schema: input.schema },
      { type: 'explain', sql: { sourceKind: 'sql', entry: 'explain', input: { sql: input.sql, schema: input.schema, limit: DEFAULT_QUERY_PAGE_SIZE } } })
    return { ...(result.result as Result), executionId: result.executionId as string }
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
    for (const [id, workbench] of Object.entries(layout.workbenches)) {
      const saved = rows.get(id), old = workbench.sharedQuery
      if (!saved || workbench.aiDocument || !old) continue
      layout.workbenches[id] = sanitizeConversationWorkbench({ ...workbench, aiDocument: { sourceId: saved.settings.dialect, text: old.sql,
        context: { schema: old.schema || ('database' in saved.settings ? saved.settings.database : '') }, revision: Math.max(1, old.revision), controller: old.controller, controllerReason: old.controllerReason } })
      changed = true
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
  async catalog(session: string, id: string, generation: unknown, input: CatalogRequest, signal?: AbortSignal, hooks?: { onDispatched?(): void }): Promise<CatalogResult> {
    return this.request(session, id, generation, 'catalog', input, signal, undefined, hooks)
  }
  async redisRequest(session: string, id: string, generation: unknown, action: 'redis-command' | 'redis-scan' | 'redis-key-suggest' | 'redis-key', raw: unknown, signal?: AbortSignal, initiator: 'user' | 'ai' = 'user', options?: { queryRevision?: number; record?: boolean; context?: Record<string, string> }): Promise<Record<string, unknown>> {
    const entry = this.#entries.get(id)
    if (!entry || !getSourceRuntime(entry.connection.dialect).actions.includes(action)) throw fail('请选择有效的 Redis 连接。', CONNECTION_ERROR_CODES.offline)
    const input = raw && typeof raw === 'object' ? raw as ServiceRequest : {}
    let database = input.database === undefined || input.database === '' ? undefined : String(input.database)
    if (database !== undefined) database = assertRedisDatabaseId(database)
    const mode = entry.connection.settings && 'redisMode' in entry.connection.settings ? entry.connection.settings.redisMode : undefined
    assertRedisClusterDatabase(database, mode)
    if (action === 'redis-command') return this.executeText(session, id, generation, input.command, signal, initiator, undefined, options?.queryRevision, undefined, { database: database ?? entry.connection.database })
    if (initiator === 'ai' && this.getExecutionDocument(session, id, generation).controller !== 'ai') throw new Error('用户已接管 AI Query，无法继续操作 Redis。')
    const prepared = redisPreparedInput(action, input, database)
    return this.#withReadonly(id, () => this.#dispatch(session, id, generation, action, prepared, signal), 'manual') as Promise<Record<string, unknown>>
  }
  async executeCatalogTool(session: string, id: string, generation: unknown, input: CatalogToolInput, signal?: AbortSignal, callId?: string, rootCallId?: string): Promise<Record<string, unknown>> {
    const connection = this.#entries.get(id)?.connection
    if (!connection || connection.generation !== generation || (connection.dialect !== 'mysql' && connection.dialect !== 'oracle')) throw new Error('连接已变化，请刷新。')
    const prepared = prepareCatalogTool(connection as Connection & {dialect: 'mysql' | 'oracle'}, input)
    let result
    try { result = await runOperation(this.#executions, sqlOperationBinding(session, connection), { ...prepared.metadata, callId, rootCallId },
      async (workSignal, onDispatched, context) => prepared.read(args => this.catalog(session, id, generation, args, workSignal, { onDispatched }),
        patch => { if (context.executionId) this.#executions?.annotate(context.executionId, patch) }),
      result => result.conclusion, signal, result => result.status, { classifyInterruption: (error, lifecycle) => catalogToolFailure(error, lifecycle).status,
        projectCompletion: result => ({ message: result.message, conclusion: result.conclusion }), summarizeFailure: (error, lifecycle, status) => status === 'unknown' ? `目录读取结果未知。${error instanceof Error ? error.message : ''}` : catalogToolFailure(error, lifecycle).message }) } catch (error) {
      if (error instanceof Error && (error as Error & {executionId?: string}).executionId) error.message = this.#executions?.get(session, (error as Error & {executionId: string}).executionId)?.message || error.message
      throw error
    }
    return { ...result.value, executionId: result.executionId }
  }
  async executeRedisReadTool(session: string, id: string, generation: unknown, operation: RedisReadTool, input: Record<string, unknown>, signal?: AbortSignal, callId?: string, rootCallId?: string): Promise<Record<string, unknown>> {
    const connection = this.#entries.get(id)?.connection, document = this.getExecutionDocument(session, id, generation)
    if (!connection || connection.dialect !== 'redis' || document.controller !== 'ai') throw new Error('Redis 连接或控制权已变化。')
    const prepared = prepareRedisReadOperation(operation, input, document.context, connection)
    const response = await runOperation(this.#executions, sqlOperationBinding(session, connection), { operation, title: prepared.title, initiator: 'ai', callId, rootCallId, type: 'tool' },
      (workSignal, onDispatched) => this.#withReadonly(id, () => this.#dispatch(session, id, generation, prepared.action, prepared.input as ServiceRequest, workSignal, undefined, {
        beforeDispatch: () => { const current = this.getExecutionDocument(session, id, generation); if (current.controller !== 'ai' || current.revision !== document.revision) throw new Error('AI Query 已变化。') }, onDispatched,
      }), 'ai') as Promise<Record<string, unknown>>, prepared.summarize, signal, prepared.classifyResult,
      { classifyInterruption: (_error, lifecycle) => lifecycle.aborted ? 'cancelled' : 'failed', summarizeFailure: prepared.summarizeFailure })
    const { executionStatus: _status, ...result } = response
    return result
  }
  async executeText(session: string, id: string, generation: unknown, text: unknown, signal?: AbortSignal, initiator: 'user' | 'ai' = 'user', callId?: string, queryRevision?: number, rootCallId?: string, context?: unknown, options?: { type?: ExecutionType; sql?: TextEntryOptions }): Promise<Record<string, unknown>> {
    const entry = this.#entries.get(id)
    if (!entry || this.#closed || !this.sessionValid(session) || entry.connection.generation !== generation) throw fail('连接已变化或当前对话已失效，请刷新。', CONNECTION_ERROR_CODES.stale)
    const execution = hostModules.get(entry.connection.dialect).execution
    const normalized = execution.normalizeContext(context, entry.connection)
    const document = queryRevision === undefined ? undefined : this.getExecutionDocument(session, id, generation)
    const prepared = await prepareTextOperation(execution, text, normalized, options?.sql, signal)
    const sql = prepared.sourceKind === 'sql'
    const identity: DocumentExecutionIdentity | undefined = document ? { conversationId: session, connectionId: id, generation: entry.connection.generation!, sourceId: entry.connection.dialect,
      context: { ...normalized }, queryRevision: document.revision, documentText: document.text, executedSql: prepared.text, initiator } : undefined
    const validate = () => {
      if (!document) return
      const now = this.getExecutionDocument(session, id, generation)
      if (now.revision !== queryRevision || now.controller !== initiator || now.text !== document.text || JSON.stringify(now.context) !== JSON.stringify(document.context)) throw new Error('AI Query 已被修改、接管或切换目标，操作没有发出。')
    }
    const send = (workSignal?: AbortSignal, onDispatched?: () => void) => this.#withReadonly(id, () => this.#dispatch(session, id, generation, prepared.action, prepared.input, workSignal,
      prepared.sourceKind === 'sql' ? prepared.authorized as TrustedAuthorization : undefined, { beforeDispatch: validate, onDispatched }), prepared.queue ?? 'manual') as Promise<Record<string, unknown>>
    if (prepared.recordPolicy === 'none') {
      await authorizeTextOperation(execution, prepared, initiator, entry.connection, options?.sql, signal)
      return send(signal)
    }
    let kind: 'query' | 'write' | 'explain' = options?.type === 'explain' ? 'explain' : 'query'
    const show = options?.type !== 'verify'
    const metadata = sql ? sqlOperationMetadata({ schema: normalized.schema, sql: prepared.text, revision: queryRevision!, initiator, type: options?.type || 'query', callId, rootCallId, documentText: document?.text, explain: options?.type === 'explain' })
      : { operation: prepared.operation, title: prepared.title, initiator, callId, queryRevision, rootCallId, type: options?.type }
    if (sql && options?.type !== 'verify') this.#acquireRun(id)
    try {
      const response = await runOperation(this.#executions, sqlOperationBinding(session, entry.connection), { ...metadata, identity, context: normalized }, async (workSignal, onDispatched, operation) => {
        const authorization = await authorizeTextOperation(execution, prepared, initiator, entry.connection, options?.sql, workSignal)
        if (sql && authorization) {
          kind = authorization.kind === 'write' ? 'write' : authorization.kind === 'explain' ? 'explain' : kind
          if (identity) identity.executedSql = prepared.text
          if (operation.executionId) this.#executions?.annotate(operation.executionId, { identity, sql: prepared.text, executedSql: prepared.text, tables: authorization.tables, type: kind === 'query' ? options?.type || 'query' : kind })
        }
        operation.markChecked()
        validate()
        if (identity && show) this.#executions?.emitWorkbench(session, { type: 'EXECUTION_STARTED', ...identity, identity, executionId: operation.executionId })
        return send(workSignal, onDispatched)
      }, prepared.summarize, signal, prepared.classifyResult, {
        deferCheckPassed: true, classifyInterruption: (error, lifecycle) => prepared.classifyInterruption?.(error, lifecycle) ?? (lifecycle.dispatched ? 'unknown' : lifecycle.aborted ? 'cancelled' : 'failed'),
        completedResultIsDefinitive: prepared.completedResultIsDefinitive,
        summarizeFailure: sql ? sqlFailureMessage : (_error, _state, status) => status === 'unknown' ? (entry.connection.dialect === 'kafka' ? '执行结果未知，请核对目标 Topic，勿重复提交。' : 'Redis 执行结果未知，请核验，勿重复提交。') : _error instanceof Error ? _error.message : '执行失败。',
        projectCompletion: sql ? result => sqlCompletion(result as unknown as Result, kind, options?.type === 'explain') : undefined,
        onFinished: (executionId, status, result, message) => {
          if (!identity || !show || !executionId) return
          try { validate() } catch { return }
          const stored = this.#executions?.get(session, executionId, true)
          this.#executions?.emitWorkbench(session, { type: !sql || status === 'succeeded' ? 'EXECUTION_FINISHED' : 'EXECUTION_FAILED', ...identity, identity, executionId, status, kind, message,
            ...(sql ? { result: status === 'unknown' ? (stored?.result || { columns: [], rows: [], elapsedMs: 0, truncated: false, message }) : (stored?.result || result) as Result } : { sourceResult: result && prepared.projectLiveResult ? prepared.projectLiveResult({ ...result, executionStatus: status }) : { kind: 'error', message, executionStatus: status } }) })
        },
      })
      const { executionStatus: status, ...result } = response
      if (status === 'unknown') throw Object.assign(new Error(this.#executions?.get(session, result.executionId as string)?.message || '执行结果未知，请核验，勿重复提交。'), { effect: 'unknown', phase: 'receipt', executionId: result.executionId, executionStatus: status, steps: result.steps, batch: result.batch })
      if (!sql) return { ...(prepared.projectLiveResult ? prepared.projectLiveResult(response) : response), ...(identity ? { ...identity, identity, result: prepared.projectLiveResult ? prepared.projectLiveResult(response) : response } : {}) }
      return { ...(identity || {}), ...(identity ? { identity } : {}), schema: normalized.schema, ...(identity && this.getExecutionDocument(session, id).revision !== identity.queryRevision ? { controlLost: true } : {}), executionId: result.executionId, status, kind, sql: prepared.text, result, model: sqlModel(result as unknown as Result, result.executionId as string, !!document && this.getExecutionDocument(session, id).revision !== document.revision) }
    } catch (error) {
      if (error && typeof error === 'object') Object.assign(error, { ...(identity || {}), ...(identity ? { identity } : {}), kind, schema: normalized.schema })
      if (error instanceof Error && (error as {executionId?: string}).executionId) { const message = this.#executions?.get(session, (error as Error & {executionId: string}).executionId)?.message; if (message) error.message = message }
      throw error
    } finally { if (sql && options?.type !== 'verify') this.#releaseRun(id) }
  }
  async request(session: string, id: string, generation: unknown, action: ServiceRequestAction, input: ServiceRequest, signal?: AbortSignal, authorized?: TrustedAuthorization, hooks?: { beforeDispatch?(): void; onDispatched?(): void }): Promise<CatalogResult> {
    if (!input || (action === 'catalog' && !['schemas', 'schema', 'tables', 'table', 'indexes'].includes(input.kind || ''))) throw new Error('目录请求无效。')
    if (signal?.aborted) throw fail('请求已取消。', CONNECTION_ERROR_CODES.cancelled)
    const run = () => this.#dispatch(session, id, generation, action, input, signal, authorized, hooks)
    if ((action === 'query' || action === 'manual-query') && !authorized && !hooks) {
      return await this.executeText(session, id, generation, input.sql, signal, 'user', undefined, undefined, undefined, { schema: input.schema ?? this.#entries.get(id)?.connection.database ?? '' }, { sql: { sourceKind: 'sql', entry: action, input: input as Record<string, unknown> } }) as CatalogResult
    }
    if (action === 'catalog') return this.#withCatalog(id, run)
    if (action === 'maintenance') return this.#withMaintenance(id, run)
    return this.#withReadonly(id, run, action === 'query' ? 'ai' : 'manual')
  }
  async #dispatch(session: string, id: string, generation: unknown, action: string, input: ServiceRequest, signal?: AbortSignal, authorized?: TrustedAuthorization, hooks?: { beforeDispatch?(): void; onDispatched?(): void }): Promise<CatalogResult> {
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
          if (error && progress && (action === 'query' || action === 'manual-query')) Object.assign(error, { effect: (error as {effect?: string}).effect || 'unknown', phase: (error as {phase?: string}).phase || 'receipt', steps: (error as {steps?: unknown}).steps || progress.steps, batch: (error as {batch?: unknown}).batch || progress.batch })
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
        const message = (reply: { requestId?: string; error?: string; code?: string; result?: CatalogResult; progress?: Record<string, unknown>; sqlProgress?: Record<string, unknown>; effect?: string; phase?: string; category?: string; databaseCode?: string; steps?: unknown; batch?: unknown; cancelled?: boolean }) => {
          if (reply.requestId !== requestId) return
          if (this.#entries.get(id) !== entry || !this.sessionValid(session)) finish(fail('连接或对话已变化，已丢弃迟到结果。', CONNECTION_ERROR_CODES.stale))
          else if (reply.progress || reply.sqlProgress) { progress = reply.progress || reply.sqlProgress; return }
          else if (!reply.error && (reply.cancelled || signal?.aborted)) finish(action === 'redis-command' || action === 'redis-key' ? new Error('Redis 操作已取消，执行结果未知，请核验。') : fail('读取已取消。', CONNECTION_ERROR_CODES.cancelled))
          else if (reply.error) finish(Object.assign(workerError(reply.error, reply.code), { effect: reply.effect, phase: reply.phase, category: reply.category, databaseCode: reply.databaseCode, steps: reply.steps, batch: reply.batch }))
          else if (reply.result === undefined) finish(Object.assign(new Error('缺少有效执行回执，结果未知。'), { effect: 'unknown', phase: 'receipt' }))
          else finish(undefined, reply.result)
        }
        const timer = setTimeout(() => {
          try { entry.worker.postMessage({ cancel: true, requestId }) } catch { /* ignore */ }
          const deadline = hostDeadlineFor(action)
          if (action === 'maintenance') terminateWorker(hostTimeoutMessage(action, deadline))
          else finish(Object.assign(new Error(authorized?.kind === 'write' ? `写入超过 ${Math.round(deadline / 1000)} 秒，结果未知，请核验，勿重复提交。` : action === 'redis-command' || action === 'redis-key' ? 'Redis 操作超时，执行结果未知，请核验。' : hostTimeoutMessage(action, deadline)), { effect: 'unknown', phase: 'receipt' }))
        }, hostDeadlineFor(action))
        entry.worker.on('message', message); entry.worker.once('exit', exited); signal?.addEventListener('abort', cancel, { once: true })
        try { hooks?.beforeDispatch?.() } catch (error) { finish(error as Error); return }
        if (signal?.aborted) { finish(fail('请求已取消。', CONNECTION_ERROR_CODES.cancelled)); return }
        try {
          entry.worker.postMessage({ requestId, action, input: { ...input, conversationId: session }, ...(authorized ? { authorized, lane: input.lane === 'manual' ? 'manual' : 'query' } : {}) })
          hooks?.onDispatched?.()
        } catch (error) { finish(error as Error) }
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
      if (entry.connection.health === 'ready') {
        this.#reviveAttempts.delete(id)
        this.#clearRevive(id)
      }
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

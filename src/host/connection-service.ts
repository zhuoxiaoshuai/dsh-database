import {workerExchange} from './worker-exchange.ts'
import { workerReplyHeaderValid } from '../shared/worker-protocol.ts'
import { ConnectionRuntime, type ConnectionEntry as Entry, type ConnectionAttempt, type ConnectionRuntimeState } from './connection-runtime.ts'
import { ConnectionScheduler } from './connection-scheduler.ts'
import { connectionFailure, recoveryDelay } from './connection-failure.mjs'
import type { ConnectionLifecycle, ConnectionStart, ConnectionFailureCategory } from '../shared/connection-lifecycle.ts'
import { NacosService } from './nacos-service.ts'
import { Worker } from 'node:worker_threads'
import { randomUUID, createHash } from 'node:crypto'
import type { Connection, ConnectionTest, CatalogRequest, CatalogResult, ConnectionWorkbench, DatabaseWorkspaceSnapshot, QueryEditSource, Result, SharedQuery, SharedQueryLastRun, SourceConnectionInput, SourceConnectionSettings } from '../shared/workbench.ts'
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
import { catalogSchemaName, coerceVisibleSchemas, connectionOwnsSchema, legacySharedQueryDocument, sharedQuerySurface } from '../shared/workbench.ts'
import { inferExecutionType, isUserVisibleQueryType } from '../shared/execution.ts'
import { HOST_TIMEOUTS, connectTimeoutMessage, hostDeadlineFor, hostTimeoutMessage } from './request-timeouts.mjs'
import { nativeErrorText } from './connect-error.mjs'
import { CONNECTION_ERROR_CODES, ServiceError, type ConnectionErrorCode } from '../shared/connection-errors.ts'
import type { ServiceRequestAction } from '../shared/database-actions.ts'
import { DEFAULT_QUERY_PAGE_SIZE } from '../shared/limits.ts'
import { assertDocumentRevision, isDocumentRevision, sameStringMap, type ExecutionDocument } from '../shared/execution-document.ts'
import { ExecutionDocumentService } from './execution-document-service.ts'
import { runOperation } from './operation-runtime.ts'
import { assertRedisClusterDatabase, assertRedisDatabaseId, redisPreparedInput } from './redis-request.ts'
import { TextOperationRunner } from './text-operation-runner.ts'
import type { TextEntryOptions } from './data-sources/module-types.ts'
import type { DocumentExecutionIdentity, ExecutionRecord, ExecutionType } from '../shared/execution.ts'
import { sqlOperationBinding, sqlOperationMetadata, sqlCompletion, sqlModel, sqlFailureMessage } from './sql-operation.ts'
import { prepareCatalogTool, catalogToolFailure, type CatalogToolInput } from './sql-catalog-operation.ts'
import { prepareRedisReadOperation, type RedisReadTool } from './data-sources/redis/read-operation.ts'
import { unwrapExplainSql } from '../shared/sql-text.ts'
import { parseBrowserQueryUpdate, validateBrowserFormat } from './sql-browser-request.ts'
import { hostModules, getSourceRuntime } from './data-sources/modules.ts'
export { connectionFingerprint, validateConnection } from '../shared/connection-input.ts'

const MAX_LIVE = 20
const MAX_AI_STATEMENTS = 8
const MAX_READONLY = 3
const MAX_GLOBAL_READONLY = 16
const MAX_AI_READONLY = MAX_READONLY - 1
const MAX_GLOBAL_AI_READONLY = MAX_GLOBAL_READONLY - 2
const fail = (message: string, code: typeof CONNECTION_ERROR_CODES[keyof typeof CONNECTION_ERROR_CODES]) => new ServiceError(message, code)
const publicErrorCodes = new Set<string>(Object.values(CONNECTION_ERROR_CODES))
const workerError = (message: string, code?: string): Error =>
  code && publicErrorCodes.has(code) ? new ServiceError(message, code as ConnectionErrorCode) : new Error(message)

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
export type LastRunMatch = { connectionId: string; generation?: string; revision: number; text: string; schema: string; controller: 'ai' | 'user' }
/**
 * lastRun 的唯一算法：按当前执行文档（revision/text/schema/controller）在执行记录里找最近一次用户可见执行，再取结果摘要。
 * getSharedQuery 与快照公共投影都走这里，两处 lastRun 完全同源；只现算，不落盘、不新造来源。
 */
export function lastRunFromExecutions(records: readonly ExecutionRecord[], match: LastRunMatch, readResult: (executionId: string) => Result | undefined): { lastExecutionId: string; lastRun: SharedQueryLastRun } | undefined {
  const record = records.find(r => r.connectionId === match.connectionId && r.generation === match.generation
    && r.queryRevision === match.revision && r.documentText === match.text && r.schema === match.schema
    && isUserVisibleQueryType(r.type || '') && !(r.initiator === 'ai' && match.controller === 'user'))
  if (!record) return
  const result = readResult(record.executionId)
  return { lastExecutionId: record.executionId, lastRun: { executionId: record.executionId, columns: result?.columns || [], rowCount: result?.rows.length || 0,
    truncated: result?.truncated || false, elapsedMs: result?.elapsedMs || 0, message: record.message || result?.message, at: record.updatedAt } }
}
type ServiceRequest = {
  background?: boolean
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
  private readonly connectionRuntime = new ConnectionRuntime()
  #runtime = this.connectionRuntime.records
  #operations = this.connectionRuntime.operations
  #tests = new Map<Worker, { session: string; controller: AbortController }>()
  #closed = false
  #connectSlots = new ConnectionScheduler(1, 6, 1, 4, HOST_TIMEOUTS.queue, undefined, true)
  #readSlots = new ConnectionScheduler(MAX_READONLY, MAX_GLOBAL_READONLY, MAX_AI_READONLY, MAX_GLOBAL_AI_READONLY, HOST_TIMEOUTS.queue, id => this.#maintaining.has(id) || !!this.#entry(id)?.cancelling)
  #catalogSlots = new ConnectionScheduler(1, MAX_LIVE, 1, 4, HOST_TIMEOUTS.queue, id => !!this.#entry(id)?.cancelling, true)
  #cache = new Map<string, { time: number; value: CatalogResult }>()
  #revision = 0
  #connectionRunning = new Map<string, string>()
  #executions?: ExecutionStore
  #rows?: Map<string, StoredDatabaseConnection>
  #lastActiveId?: string
  #legacyDrafts = new Map<string, ConnectionWorkbench>()
  #legacyTemplates = new Map<string, string[]>()
  #migratedOwners = new Set<string>()
  #maintaining = new Set<string>()
  readonly templates: SqlTemplateStore
  private readonly knowledge: KnowledgeService
  private readonly explorer = new ExplorerService()
  private sessionValid: (session: string) => boolean
  private readonly store: SavedDatabaseConnections
  private readonly conversations: ConversationWorkbenchStore
  private readonly documents: ExecutionDocumentService
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
    this.documents = new ExecutionDocumentService({
      binding: (owner, id, generation) => {
        if (this.#closed || !this.sessionValid(owner)) throw new Error('当前对话已失效。')
        const saved = this.ensure().get(id)
        if (!saved) throw new Error('连接不存在。')
        if (generation !== undefined && this.#entry(id)?.connection.generation !== generation) throw new Error('连接已变化，请刷新。')
        return publicConnection(saved, this.#entry(id)?.connection)
      },
      layout: owner => this.#layout(owner, this.ensure()),
      save: (owner, layout) => this.conversations.save(owner, layout, new Set(this.ensure().keys())),
      changed: (owner, id, document) => this.#executions?.emitWorkbench(owner, { type: 'EXECUTION_DOCUMENT_CHANGED', connectionId: id, generation: this.#entry(id)?.connection.generation, document }),
    })
    this.workerUrl = workerUrl
  }
  list(session: string): Connection[] {
    return this.snapshot(session).connections
  }
  snapshot(session: string): DatabaseWorkspaceSnapshot {
    if (this.#closed || !this.sessionValid(session)) throw new Error('当前对话已失效。')
    const rows = this.ensure()
    const layout = this.#layout(session, rows)
    // lastRun 由执行记录现算后补进公共投影：与 getSharedQuery 同源，一次快照只列一次执行记录。
    const records = this.#executions?.list(session) || []
    return {
      connections: [...rows.values()].map(row => { const projection = this.#runtime.get(row.id)?.attempt?.projection; return { ...publicConnection(row, this.#entry(row.id)?.connection, layout.workbenches[row.id], this.#lastRunForView(session, row.id, records)), lifecycle: projection ? { ...projection } : undefined } }),
      lastActiveId: layout.lastActiveId && rows.has(layout.lastActiveId) ? layout.lastActiveId : undefined,
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
    const rows = new Map(structuredClone([...this.ensure()]))
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
        const stored: StoredDatabaseConnection = { id, settings, desiredState: 'offline' }
        rows.set(id, stored)
        created.push(publicConnection(stored))
      } catch (error) {
        skipped.push(summarize(raw, { reason: 'invalid', message: error instanceof Error ? error.message : '连接字段无效。' }))
      }
    }
    if (created.length) { this.commitConnections(rows); this.#bump() }
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
      desiredState: 'offline',
      settings: { ...original.settings, name },
      ...(protectedPassword ? { protectedPassword } : {}),
      ...(protectedCa ? { protectedCa } : {}),
      ...(original.visibleSchemas?.length ? { visibleSchemas: [...original.visibleSchemas] } : {}),
    }
    const candidate = new Map(this.ensure())
    if (candidate.size >= 100) throw fail('保存的数据库连接数量已达上限。', CONNECTION_ERROR_CODES.busy)
    candidate.set(copyId, stored)
    this.commitConnections(candidate)
    this.#bump()
    return structuredClone(publicConnection(stored, undefined, this.#layout(session, rows).workbenches[copyId]))
  }
  activate(session: string, id?: string): void {
    if (this.#closed || !this.sessionValid(session)) throw new Error('当前对话已失效。')
    const rows = this.ensure()
    if (id && !rows.has(id)) throw new Error('连接不存在或当前对话已失效。')
    const layout = this.#layout(session, rows)
    layout.lastActiveId = id || null
    this.conversations.save(session, layout, new Set(rows.keys()))
    this.#bump()
  }
  saveWorkbench(session: string, id: string, patch: unknown): ConnectionWorkbench {
    if (this.#closed || !this.sessionValid(session) || !this.ensure().has(id)) throw new Error('连接不存在或当前对话已失效。')
    const rows = this.#rows!
    const row = rows.get(id)!
    const incoming = patch && typeof patch === 'object' ? patch as ConnectionWorkbench : {}
    if (Object.hasOwn(incoming, 'visibleSchemas')) {
      const visible = coerceVisibleSchemas(incoming.visibleSchemas)
      const candidate = new Map(rows)
      const next = { ...row }
      if (visible.length) next.visibleSchemas = visible
      else delete next.visibleSchemas
      candidate.set(id, next)
      this.commitConnections(candidate)
    }
    const { sharedQuery: _ignored, aiDocument: _document, aiCollab: _legacy, visibleSchemas: _visible, ...rest } = incoming
    const current = this.#layout(session, rows)
    // 浏览器不能覆盖文档与旧模型字段；旧字段随 spread 原样保留。
    const workbench = sanitizeConversationWorkbench({ ...current.workbenches[id], ...rest })
    current.workbenches[id] = workbench
    this.conversations.save(session, current, new Set(rows.keys()))
    return publicConnection(this.#rows!.get(id)!, undefined, workbench).workbench || workbench
  }
  get storageDegraded(): boolean { return this.conversations.storageDegraded }
  getSharedQuery(session: string, id: string): SharedQuery {
    const d = this.getExecutionDocument(session, id)
    const run = this.#lastRun(session, id, d, this.#executions?.list(session) || [])
    return { sql: d.text, schema: d.context.schema || '', revision: d.revision, controller: d.controller, controllerReason: d.controllerReason,
      ...(run ? { lastExecutionId: run.lastExecutionId, lastRun: run.lastRun } : {}) }
  }
  /** 与 getSharedQuery 同源的 lastRun 现算：同一套执行记录匹配规则，快照投影用它补数据。 */
  #lastRun(session: string, id: string, document: ExecutionDocument, records: readonly ExecutionRecord[]): { lastExecutionId: string; lastRun: SharedQueryLastRun } | undefined {
    return lastRunFromExecutions(records, { connectionId: id, generation: this.#entry(id)?.connection.generation,
      revision: document.revision, text: document.text, schema: document.context.schema || '', controller: document.controller },
      executionId => this.#executions?.get(session, executionId, true)?.result)
  }
  /** 编辑器视图的 lastRun 数据源：没有文档能力的连接读不到文档，也就没有 lastRun。 */
  #lastRunForView(session: string, id: string, records: readonly ExecutionRecord[]): SharedQueryLastRun | undefined {
    try { return this.#lastRun(session, id, this.getExecutionDocument(session, id), records)?.lastRun } catch { return undefined }
  }
  getExecutionDocument(session: string, id: string, generation?: unknown): ExecutionDocument {
    return this.documents.read(session, id, generation)
  }
  updateExecutionDocument(session: string, id: string, text: string, source: 'ai' | 'user' | 'system', expectedRevision?: number, generation?: unknown, context?: unknown): ExecutionDocument {
    return this.documents.update(session, id, text, source, expectedRevision, generation, context)
  }
  assertBrowserDocumentRequest(session: string, id: string, generation: unknown, revision: unknown): void {
    if (!isDocumentRevision(revision)) throw new Error('缺少有效文档修订，请刷新。')
    const document = this.getExecutionDocument(session, id, generation)
    assertDocumentRevision(document, revision, 'AI Query 已变化，请刷新后再试。')
    if (this.#hasEntry(id) && typeof generation !== 'string') throw new Error('缺少连接代次，请刷新。')
  }
  updateExecutionDocumentFromBrowser(session: string, id: string, input: Record<string, unknown>): ExecutionDocument {
    this.assertBrowserDocumentRequest(session, id, input.generation, input.revision)
    if (typeof input.text !== 'string' || !['user', 'format'].includes(String(input.source ?? 'user'))) throw new Error('浏览器不能使用此文档更新来源。')
    const previous = this.getExecutionDocument(session, id)
    let source: 'system' | 'user' = 'user'
    if (input.source === 'format') {
      if (getSourceRuntime(previous.sourceId).documentKind !== 'sql') throw new Error('此数据源不支持 SQL 格式化。')
      if (input.context !== undefined) {
        const binding = this.#entry(id)?.connection || this.list(session).find(item => item.id === id)!
        const context = hostModules.get(previous.sourceId).execution!.normalizeContext(input.context, binding)
        if (!sameStringMap(context, previous.context)) throw new Error('格式化不能改变执行目标。')
      }
      const kind = validateBrowserFormat(this.getSharedQuery(session, id), { sql: input.text }, previous.sourceId, input.revision as number, input.formatRange)
      source = kind === 'values' ? 'user' : 'system'
    } else if (input.formatRange !== undefined) throw new Error('选区只能用于格式化请求。')
    return this.updateExecutionDocument(session, id, input.text, source, input.revision as number, input.generation, input.context)
  }
  updateSharedQueryFromBrowser(session: string, id: string, input: Record<string, unknown>): SharedQuery {
    const update = parseBrowserQueryUpdate(input)
    const current = this.getSharedQuery(session, id)
    // Old offline callers carry a revision without a live generation.
    if (this.#hasEntry(id)) this.assertBrowserDocumentRequest(session, id, input.generation, update.revision)
    const kind = update.source === 'format' ? validateBrowserFormat(current, update.patch, this.getExecutionDocument(session, id).sourceId, update.revision, update.formatRange) : undefined
    return this.updateSharedQuery(session, id, update.patch, update.source === 'format' && kind !== 'values' ? 'system' : 'user', update.revision)
  }
  patchExecutionDocumentContext(session: string, id: string, context: string | Record<string, unknown>, generation?: unknown, expectedRevision?: number): ExecutionDocument {
    const previous = this.getExecutionDocument(session, id, generation)
    return this.updateExecutionDocument(session, id, previous.text, 'system', expectedRevision, generation, typeof context === 'string' ? { database: context } : context)
  }
  controlExecutionDocument(session: string, id: string, controller: 'ai' | 'user', reason = 'user-takeover', generation?: unknown, revision?: number): ExecutionDocument {
    return this.documents.control(session, id, controller, reason, generation, revision)
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
    const connection = this.#entry(id)?.connection
    if (!connection?.live || getSourceRuntime(document.sourceId).documentKind !== 'sql') throw new Error('请先连接数据库。')
    assertDocumentRevision(document, input.revision, 'AI Query 已变化，请重新读取后再试。')
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
    assertDocumentRevision(d, input.revision, 'AI Query 已变化，请刷新。')
    const result = await this.executeText(session, id, generation, input.sql, signal, input.initiator || 'ai', input.callId, d.revision, input.rootCallId, { schema: input.schema },
      { type: 'explain', sql: { sourceKind: 'sql', entry: 'explain', input: { sql: input.sql, schema: input.schema, limit: DEFAULT_QUERY_PAGE_SIZE } } })
    return { ...(result.result as Result), executionId: result.executionId as string }
  }
  #acquireRun(connectionId: string): string {
    if (this.#connectionRunning.has(connectionId)) throw new Error('此连接已有查询正在执行。')
    const lease = randomUUID()
    this.#connectionRunning.set(connectionId, lease)
    return lease
  }
  #releaseRun(connectionId: string, lease: string): void {
    const current = this.#connectionRunning.get(connectionId)
    if (!current) return
    if (current === lease) this.#connectionRunning.delete(connectionId)
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
    const entry = this.#entry(connectionId)
    if (typeof body.generation !== 'string' || entry?.connection.generation !== body.generation) throw new Error('连接已变化，请刷新。')
    return this.knowledge.dispatch(saved.settings.dialect, connectionId, body)
  }
  private nacosService?: NacosService
  nacosRequest(session: string, id: string, generation: unknown, action: string, input: Record<string, unknown>, actor: 'user' | 'ai', signal?: AbortSignal, callId?: string, rootCallId?: string) {
    const validate = () => {
      if (this.explorerTarget(session, id, generation) !== 'nacos') throw new Error('此工具仅支持 Nacos。')
    }
    validate()
    const connection = this.#entry(id)!.connection
    this.nacosService ??= new NacosService(this.#executions)
    return this.nacosService.request(session, connection, action, input, actor,
      (operation, request, workSignal, dispatched) => this.#withReadonly(id, () => this.#dispatch(session, id, generation, operation, request,
        workSignal, undefined, {beforeDispatch: validate, onDispatched: dispatched}), actor === 'ai' ? 'ai' : 'manual', workSignal) as Promise<Record<string, unknown>>,
      validate, signal, callId, rootCallId)
  }
  private explorerTarget(session: string, id: string, generation: unknown) {
    if (this.#closed || !this.sessionValid(session)) throw new Error('当前对话已失效。')
    const entry = this.#entry(id)
    if (!entry || entry.connection.generation !== generation) throw new Error('连接已变化，请刷新。')
    return entry.connection.dialect
  }
  explorerList(session: string, id: string, generation: unknown, input: ExplorerListInput, signal?: AbortSignal) {
    const sourceId = this.explorerTarget(session, id, generation)
    const transport = { request: (action: string, request: Record<string, unknown>, requestSignal?: AbortSignal) => {
      if (action === 'catalog') return this.catalog(session, id, generation, request as unknown as CatalogRequest, requestSignal) as Promise<Record<string, any>>
      if (action === 'redis-scan' || action === 'redis-key') return this.redisRequest(session, id, generation, action, request, requestSignal)
      return this.sourceRead(session, id, generation, action, request, requestSignal)
    } }
    return this.explorer.list(sourceId, transport, input, signal)
  }
  explorerRead(session: string, id: string, generation: unknown, input: ExplorerReadInput, signal?: AbortSignal) {
    const sourceId = this.explorerTarget(session, id, generation)
    const transport = { request: (action: string, request: Record<string, unknown>, requestSignal?: AbortSignal) => {
      if (action === 'catalog') return this.catalog(session, id, generation, request as unknown as CatalogRequest, requestSignal) as Promise<Record<string, any>>
      if (action === 'redis-scan' || action === 'redis-key') return this.redisRequest(session, id, generation, action, request, requestSignal)
      return this.sourceRead(session, id, generation, action, request, requestSignal)
    } }
    return this.explorer.read(sourceId, transport, input, signal)
  }
  private sourceRead(session: string, id: string, generation: unknown, action: string, input: Record<string, unknown>, signal?: AbortSignal): Promise<Record<string, unknown>> {
    const entry = this.#entry(id)
    if (!entry || !hostModules.get(entry.connection.dialect).explorer?.readonlyActions?.includes(action)
      || !getSourceRuntime(entry.connection.dialect).actions.includes(action)) throw new Error('对象请求与数据源不匹配。')
    return this.#withReadonly(id, () => this.#dispatch(session, id, generation, action, input, signal), 'manual', signal) as Promise<Record<string, unknown>>
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
          desiredState: row.desiredState ?? (canReuseSavedLogin({ dialect: row.settings.dialect, hasPassword: !!row.protectedPassword }) ? 'online' : 'offline'),
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
  private commitConnections(rows: Map<string, StoredDatabaseConnection>): void {
    const lastActiveId = this.#lastActiveId && rows.has(this.#lastActiveId) ? this.#lastActiveId : undefined
    this.store.save({ connections: [...rows.values()], lastActiveId })
    this.#rows = rows
    this.#lastActiveId = lastActiveId
  }
  private setDesiredState(id: string, desiredState: 'online' | 'offline'): void {
    const candidate = new Map(this.ensure())
    const row = candidate.get(id)
    if (!row) return
    candidate.set(id, { ...row, desiredState })
    this.commitConnections(candidate)
  }
  #layout(session: string, rows: Map<string, StoredDatabaseConnection>): ConversationLayout {
    const layout = this.conversations.load(session)
    let changed = false
    if (layout.lastActiveId === undefined) {
      layout.lastActiveId = this.#lastActiveId && rows.has(this.#lastActiveId) ? this.#lastActiveId : null
      changed = true
    }
    if (!this.#migratedOwners.has(session)) {
      for (const [id, draft] of this.#legacyDrafts) {
        if (!layout.workbenches[id]) { layout.workbenches[id] = draft; changed = true }
      }
    }
    for (const [id, workbench] of Object.entries(layout.workbenches)) {
      const saved = rows.get(id)
      if (!saved || workbench.aiDocument) continue
      // 旧持久化 SharedQuery 只是迁移输入：没有权威文档时才推导，lastRun 等旧字段随迁移丢弃。
      const legacy = legacySharedQueryDocument(workbench, saved.settings.dialect, 'database' in saved.settings ? saved.settings.database : '')
      if (!legacy) continue
      layout.workbenches[id] = sanitizeConversationWorkbench({ ...workbench, aiDocument: { ...legacy, revision: Math.max(1, legacy.revision) } })
      changed = true
    }
    if (changed) this.conversations.save(session, layout, new Set(rows.keys()))
    this.#migratedOwners.add(session)
    return layout
  }
  #bump(): void { this.#revision += 1 }
  #record(id: string): ConnectionRuntimeState { return this.connectionRuntime.record(id) }
  #entry(id: string): Entry | undefined { return this.#runtime.get(id)?.entry }
  #hasEntry(id: string): boolean { return !!this.#entry(id) }
  #isChanging(id: string): boolean { const state = this.#runtime.get(id)?.attempt?.projection.status; return state === 'queued' || state === 'running' }
  #busyAdd(worker: Worker): void { for (const runtime of this.#runtime.values()) if (runtime.entry?.worker === worker) { runtime.entry.busy++; break } }
  #busyDone(worker: Worker): void { for (const runtime of this.#runtime.values()) if (runtime.entry?.worker === worker) { runtime.entry.busy = Math.max(0, runtime.entry.busy - 1); break } }
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
    if (this.#entry(id) !== entry) return
    this.#clearRevive(id)
    this.#record(id).entry = undefined
    this.#catalogSlots.cancel(id)
    this.#dropCache(id, entry.connection.generation)
    this.#connectionRunning.delete(id)
    this.#bump()
    if (entry.connection.generation) this.#executions?.invalidateGeneration(id, entry.connection.generation, reason === 'removed' ? 'removed' : 'disconnect')
    this.#readSlots.cancel(id)
    if (reason === 'closed' && this.#record(id).everReady) this.#scheduleRevive(id)
  }
  async #waitLifecycle(id: string, op: 'disconnect' | 'remove' | 'update', signal?: AbortSignal): Promise<void> {
    if (op === 'update' && this.#maintaining.has(id)) throw fail('维护操作正在执行，请等待结果后再编辑连接。', CONNECTION_ERROR_CODES.busy)
    await waitWhile(
      () => { if (signal?.aborted) throw fail('连接操作已取消。', CONNECTION_ERROR_CODES.cancelled); return (
        (this.#readSlots.active(id)) > 0
        || !!this.#entry(id)?.cancelling
        || this.#connectionRunning.has(id)
        || (op !== 'update' && this.#maintaining.has(id))
        || (op !== 'update' && this.#isChanging(id))
      ) },
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
  async #withCatalog<T>(id: string, work: () => Promise<T>, signal?: AbortSignal, background = false): Promise<T> {
    const permit = await this.#catalogSlots.acquire(id, background ? 'background' : 'manual', signal)
    try { return await work() } finally { permit.release() }
  }
  async #withReadonly<T>(id: string, work: () => Promise<T>, lane: 'manual' | 'ai' = 'ai', signal?: AbortSignal): Promise<T> {
    const permit = await this.#readSlots.acquire(id, lane === 'ai' ? 'background' : 'manual', signal)
    try {
      const result = await work()
      if (result && typeof result === 'object' && 'elapsedMs' in result) {
        const timings = { ...('timings' in result && result.timings && typeof result.timings === 'object' ? result.timings : {}), queueMs: permit.queueMs }
        Object.assign(result, { timings })
      }
      return result
    } finally { permit.release() }
  }
  async #withMaintenance<T>(id: string, work: () => Promise<T>): Promise<T> {
    return this.#withCatalog(id, async () => {
      this.#maintaining.add(id)
      try {
        await waitWhile(() => this.#readSlots.active(id) > 0, HOST_TIMEOUTS.queue, () => new Error('连接排队已满，请稍后再试。'))
        return await work()
      } finally { this.#maintaining.delete(id); this.#readSlots.drain() }
    })
  }
  restoreRemembered(session: string): Promise<void> {
    if (this.#closed || !this.sessionValid(session)) return Promise.reject(fail('当前对话已失效。', CONNECTION_ERROR_CODES.session))
    for (const row of this.ensure().values()) {
      const runtime = this.#record(row.id)
      if (row.desiredState !== 'online' || runtime.entry || runtime.timer || runtime.recoveryBlocked || this.#isChanging(row.id)) continue
      if (!canReuseSavedLogin({ dialect: row.settings.dialect, hasPassword: !!row.protectedPassword })) continue
      runtime.everReady = true // Legacy/saved online profiles represent a previously accepted login.
      try { this.#beginConnection(session, { ...row.settings, password: '', useSavedPassword: true, rememberPassword: true }, randomUUID(), row.id, true, 'recover') }
      catch { this.#scheduleRevive(row.id) }
    }
    return Promise.resolve()
  }
  startConnection(session: string, raw: unknown, operationId: string, id?: string): ConnectionStart {
    return this.#beginConnection(session, raw, operationId, id, true).started
  }
  async cancelConnection(session: string, id: string, operationId: string): Promise<void> {
    if (this.#closed || !this.sessionValid(session) || !this.ensure().has(id)) throw fail('连接不存在或当前对话已失效。', CONNECTION_ERROR_CODES.stale)
    const runtime = this.#record(id)
    if (runtime.attempt?.projection.operationId !== operationId) throw fail('连接操作已变化，请刷新。', CONNECTION_ERROR_CODES.stale)
    if (runtime.timer || runtime.attempt.projection.kind === 'recover') { await this.disconnect(session, id); return }
    await this.#cancelAttempt(id)
    runtime.recoveryBlocked = true
    this.#clearRevive(id)
    if (!runtime.entry?.connection.live) this.setDesiredState(id, 'offline')
  }
  async #cancelAttempt(id: string): Promise<void> {
    const runtime = this.#runtime.get(id), attempt = runtime?.attempt
    if (!runtime || !attempt) return
    if (attempt.projection.status === 'queued' || attempt.projection.status === 'running') {
      attempt.projection.status = 'cancelled'; attempt.projection.category = 'cancelled'; attempt.projection.message = '连接操作已取消。'
      runtime.epoch++
      attempt.controller.abort()
      this.#connectSlots.cancel(id)
      this.#bump()
      if (attempt.worker && attempt.worker !== runtime.entry?.worker) await attempt.worker.terminate()
    }
  }
  #assertAttempt(id: string, attempt: ConnectionAttempt, epoch: number): void {
    if (this.#closed || attempt.controller.signal.aborted || this.#runtime.get(id)?.attempt !== attempt || this.#record(id).epoch !== epoch
      || !this.sessionValid(attempt.session) || this.#rows?.get(id)?.desiredState === 'offline') throw fail('连接操作已取消或连接已变化。', CONNECTION_ERROR_CODES.cancelled)
  }
  #beginConnection(session: string, raw: unknown, operationId: string, replaceId?: string, background = false, kind?: ConnectionLifecycle['kind']): { started: ConnectionStart; promise: Promise<Connection> } {
    if (this.#closed || !this.sessionValid(session)) throw fail('当前对话已失效。', CONNECTION_ERROR_CODES.session)
    if (typeof operationId !== 'string' || !operationId.trim() || operationId.length > 160) throw new Error('连接操作标识无效。')
    const input = normalizeSourceConnection(raw)
    const signature = createHash('sha256').update(JSON.stringify([input, replaceId || ''])).digest('hex')
    const known = this.#operations.get(operationId)
    if (known) {
      if (known.attempt.session !== session || known.attempt.signature !== signature) throw fail('连接操作标识已被使用。', CONNECTION_ERROR_CODES.stale)
      return { started: { connectionId: known.id, operationId }, promise: known.attempt.promise }
    }
    const rows = this.ensure(), originalSaved = replaceId ? rows.get(replaceId) : undefined
    if (replaceId && !originalSaved) throw fail('原连接已失效。', CONNECTION_ERROR_CODES.offline)
    const id = replaceId || randomUUID(), runtime = this.#record(id)
    if (this.#isChanging(id)) throw fail('此连接正在处理连接请求，请等待或取消后再试。', CONNECTION_ERROR_CODES.busy)
    if (this.#maintaining.has(id)) throw fail('维护操作正在执行，请等待结果后再编辑连接。', CONNECTION_ERROR_CODES.busy)
    const reserved = [...this.#runtime.entries()].filter(([key, value]) => key !== id && (value.entry || ['queued', 'running'].includes(value.attempt?.projection.status || ''))).length
    if (reserved >= MAX_LIVE || (!replaceId && rows.size >= 100)) throw fail('连接数量已达上限，请先断开不用的连接。', CONNECTION_ERROR_CODES.busy)
    const previousDesired = originalSaved?.desiredState
    this.#clearRevive(id)
    runtime.recoveryBlocked = false
    const epoch = ++runtime.epoch
    const projection: ConnectionLifecycle = { operationId, kind: kind || (replaceId ? 'update' : 'connect'), status: 'queued' }
    const attempt: ConnectionAttempt = { session, projection, controller: new AbortController(), signature, promise: undefined! }
    runtime.attempt = attempt
    // Store coordinates before accepting a detached start, never transient credentials.
    const candidate = new Map(rows)
    if (!originalSaved && background) {
      const { password: _password, caPem: _ca, rememberPassword: _remember, useSavedPassword: _reuse, ...base } = input
      const settings = hostModules.get(input.dialect).connection.toSavedSettings?.(input, input.caPem || '') || base
      candidate.set(id, { id, settings, desiredState: 'online' })
    } else if (originalSaved) candidate.set(id, { ...originalSaved, desiredState: 'online' })
    try { if (background || originalSaved) this.commitConnections(candidate) }
    catch (error) { runtime.attempt = undefined; throw error }
    this.#bump()
    const perform = async () => {
      let permit: Awaited<ReturnType<ConnectionScheduler['acquire']>> | undefined
      try {
        permit = await this.#connectSlots.acquire(id, kind === 'recover' ? 'background' : 'manual', attempt.controller.signal)
        this.#assertAttempt(id, attempt, epoch)
        projection.status = 'running'; this.#bump()
        await this.#waitLifecycle(id, 'update', attempt.controller.signal)
        this.#assertAttempt(id, attempt, epoch)
        const result = await this.#openCandidate(session, input, false, id, attempt, epoch) as Connection
        this.#assertAttempt(id, attempt, epoch)
        projection.status = 'succeeded'; projection.message = result.passwordWarning
        runtime.everReady = true; runtime.retryAttempts = 0; this.#clearRevive(id); this.#bump()
        return { ...result, lifecycle: { ...projection }, desiredState: 'online' as const }
      } finally { permit?.release(); input.password = ''; input.caPem = '' }
    }
    attempt.promise = Promise.resolve().then(perform).catch(error => {
      if (projection.status !== 'cancelled') {
        projection.status = 'failed'; projection.category = connectionFailure(error) as ConnectionFailureCategory
        projection.message = error instanceof Error ? error.message : '连接失败。'
        if (runtime.entry && projection.kind === 'recover') runtime.entry.connection = { ...runtime.entry.connection, live: false, health: 'offline' }
        if (!replaceId && this.#rows!.has(id)) this.setDesiredState(id, 'offline')
        // Editing an existing online login must not damage its persisted configuration.
        if (originalSaved && runtime.entry?.connection.live && this.#rows!.has(id)) this.setDesiredState(id, previousDesired || 'online')
        runtime.recoveryBlocked = projection.category !== 'network'
        this.#bump()
        if (projection.category === 'network' && runtime.everReady) this.#scheduleRevive(id)
      }
      throw error
    })
    void attempt.promise.catch(() => {})
    this.connectionRuntime.rememberOperation(operationId, id, attempt)
    return { started: { connectionId: id, operationId }, promise: attempt.promise }
  }
  async update(session: string, id: string, raw: unknown): Promise<Connection> {
    return this.#beginConnection(session, raw, randomUUID(), id).promise
  }
  async open(session: string, raw: unknown, testOnly: boolean, replaceId?: string, signal?: AbortSignal): Promise<Connection | ConnectionTest> {
    if (!testOnly) return this.#beginConnection(session, raw, randomUUID(), replaceId).promise
    const permit = await this.#connectSlots.acquire(`test:${randomUUID()}`, 'manual', signal)
    try { return await this.#openCandidate(session, raw, true, replaceId, undefined, undefined, signal) }
    finally { permit.release() }
  }
  async #openCandidate(session: string, raw: unknown, testOnly: boolean, replaceId?: string, attempt?: ConnectionAttempt, epoch?: number, testSignal?: AbortSignal): Promise<Connection | ConnectionTest> {
    if (this.#closed || !this.sessionValid(session)) throw fail('当前对话已失效。', CONNECTION_ERROR_CODES.session)
    const original = replaceId ? this.#entry(replaceId) : undefined
    const originalSaved = replaceId ? this.ensure().get(replaceId) : undefined
    if (replaceId && !originalSaved && !attempt) throw fail('原连接已失效。', CONNECTION_ERROR_CODES.offline)
    if (original && this.#maintaining.has(replaceId!)) throw fail('维护操作正在执行，请等待结果后再编辑连接。', CONNECTION_ERROR_CODES.busy)
    const input = normalizeSourceConnection(raw)
    const runtime = getSourceRuntime(input.dialect)
    const savedLogin = !testOnly && original && originalSaved && sameLogin(originalSaved.settings, input)
    if (savedLogin && !input.password && !input.caPem && input.useSavedPassword) {
      if (original.connection.health !== 'ready') await this.#recover(session, replaceId!, attempt, epoch)
      if (attempt) this.#assertAttempt(replaceId!, attempt, epoch!)
      const updated = { ...originalSaved, settings: { ...originalSaved.settings, name: input.name, environment: input.environment } }
      const candidate = new Map(this.#rows!); candidate.set(replaceId!, updated)
      this.commitConnections(candidate)
      original.connection = { ...original.connection, name: input.name, environment: input.environment }
      this.#bump()
      return structuredClone(publicConnection(updated, original.connection, this.#layout(session, this.#rows!).workbenches[replaceId!]))
    }
    let secret = input.password
    if (!secret && input.useSavedPassword && originalSaved?.protectedPassword) secret = await this.store.resolvePassword(originalSaved)
    if (!secret && (hostModules.get(input.dialect).connection.requiresPassword?.(input) ?? runtime.requiresPassword)) throw new Error('请输入密码。')
    const usesCustomCa = runtime.usesCustomCa(input)
    let caPem = usesCustomCa ? input.caPem || '' : ''
    if (usesCustomCa && !caPem && originalSaved?.protectedCa) caPem = await this.store.resolveCa(originalSaved)
    const workerUrl = runtime.workerEntry === 'connection-worker.mjs' ? this.workerUrl : new URL(`./${runtime.workerEntry}`, import.meta.url)
    const worker = this.workerFactory(workerUrl)
    const controller = attempt?.controller || new AbortController()
    if (testOnly) this.#tests.set(worker, { session, controller })
    if (attempt) attempt.worker = worker
    let dead = false
    const dropped = () => {
      dead = true
      const current = replaceId ? this.#entry(replaceId) : undefined
      if (current?.worker === worker) { current.unexpectedlyClosed = true; this.#dropEntry(replaceId!, current, 'closed') }
    }
    worker.on('error', dropped)
    worker.on('exit', dropped)
    const abortTest = () => controller.abort()
    testSignal?.addEventListener('abort', abortTest, { once: true })
    if (testSignal?.aborted) controller.abort()
    let retained = false
    try {
      const payload = { ...input, password: secret, caPem }
      const result = await workerExchange<ConnectionTest & {databases:string[]}>(worker,undefined,testOnly?HOST_TIMEOUTS.connectTest:HOST_TIMEOUTS.connect,controller.signal,finish=>({
        message:message=>(message.ready||message.ok)?finish(undefined,message.result):finish(Object.assign(new Error(message.error || '连接已中断。'), { category: message.category || connectionFailure(message.error), databaseCode: message.databaseCode })),
        error:err=>{console.warn('[database] connection worker failed during init',err);finish(new Error(workerInitFailureMessage(err)))},
        exit:()=>finish(fail('连接已关闭。',CONNECTION_ERROR_CODES.closed)),
        timeout:()=>{finish(fail(connectTimeoutMessage(testOnly),CONNECTION_ERROR_CODES.timeout));void worker.terminate()},
        abort:()=>{finish(fail('连接操作已取消。',CONNECTION_ERROR_CODES.cancelled));void worker.terminate()},
        send:()=>{worker.postMessage({input:payload,testOnly});payload.password='';payload.caPem='';input.password=''},
      }))
      if (this.#closed || !this.sessionValid(session) || dead) throw fail('当前对话已失效或连接已关闭。', CONNECTION_ERROR_CODES.session)
      if (attempt) this.#assertAttempt(replaceId!, attempt, epoch!)
      if (testOnly) { secret = ''; return { version: result.version, database: result.database, elapsedMs: result.elapsedMs } }
      if (replaceId && (this.#entry(replaceId) !== original || this.#rows!.get(replaceId) !== originalSaved)) throw fail('原连接已变化或被删除，请刷新后重试。', CONNECTION_ERROR_CODES.stale)
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
      if (attempt) this.#assertAttempt(id, attempt, epoch!)
      stored.desiredState = 'online'
      const candidate = new Map(this.#rows!); candidate.set(id, stored)
      this.commitConnections(candidate)
      this.#record(id).entry = { session, worker, connection, touched: Date.now(), busy: 0 }; retained = true
      this.#bump()
      worker.on('message', message => {
        if (!workerReplyHeaderValid(message)) return
        const current = this.#entry(id)
        if (current?.worker !== worker || this.#rows?.get(id)?.desiredState !== 'online') return
        if (message.closed || message.health === 'closed') { dropped(); void worker.terminate(); return }
        if ((message.connectionCategory || message.category) === 'authentication' || (message.connectionCategory || message.category) === 'configuration') {
          this.#record(id).recoveryBlocked = true; this.#clearRevive(id)
        }
        if (message.health) this.#applyHealth(current, message.health,
          message.connectionCategory || message.category ? connectionFailure({ category: message.connectionCategory || message.category }) : undefined, message.requestId !== undefined)
      })
      if (original) {
        const previous = original.connection.generation
        void original.worker.terminate().catch(() => {})
        if (previous) this.#executions?.invalidateGeneration(id, previous, 'reconnect')
      }
      return structuredClone({ ...publicConnection(stored, connection, this.#layout(session, this.#rows!).workbenches[id]), passwordWarning })
    } finally { input.password = ''; input.caPem = ''; secret = ''; caPem = ''; testSignal?.removeEventListener('abort', abortTest); this.#tests.delete(worker); if (!retained) await worker.terminate() }
  }
  async remove(session: string, id: string): Promise<void> {
    const entry = this.#entry(id)
    if (this.#closed || !this.sessionValid(session) || !this.ensure().has(id)) throw fail('连接不存在或当前对话已失效。', CONNECTION_ERROR_CODES.session)
    const candidate = new Map(this.#rows!)
    candidate.delete(id)
    this.commitConnections(candidate)
    this.#clearRevive(id)
    await this.#cancelAttempt(id)
    if (entry) this.#retireGeneration(id, entry, 'removed')
    try { await this.#waitLifecycle(id, 'remove') } catch { /* still drop the connection */ }
    if (entry && this.#entry(id) === entry) this.#dropEntry(id, entry, 'removed')
    else this.#bump()
    this.#executions?.invalidateConnection(id, 'removed')
    await entry?.worker.terminate()
  }
  async disconnect(session: string, id: string): Promise<void> {
    if (this.#closed || !this.sessionValid(session) || !this.ensure().has(id)) throw fail('连接不存在或当前对话已失效。', CONNECTION_ERROR_CODES.session)
    const candidate = new Map(this.#rows!)
    candidate.set(id, { ...candidate.get(id)!, desiredState: 'offline' })
    this.commitConnections(candidate); this.#bump()
    this.#record(id).recoveryBlocked = true
    this.#clearRevive(id)
    await this.#cancelAttempt(id)
    const entry = this.#entry(id)
    if (!entry) return
    this.#retireGeneration(id, entry, 'disconnect')
    try { await this.#waitLifecycle(id, 'disconnect') } catch { /* still terminate the worker */ }
    if (this.#entry(id) === entry) this.#dropEntry(id, entry, 'disconnect')
    await entry.worker.terminate()
  }
  async releaseOwner(session: string): Promise<void> {
    const pending: Promise<unknown>[] = []
    for (const [id, runtime] of this.#runtime) if (runtime.attempt?.session === session && this.#isChanging(id)) pending.push(this.#cancelAttempt(id))
    for (const [worker, test] of this.#tests) if (test.session === session) { test.controller.abort(); pending.push(worker.terminate()) }
    await Promise.allSettled(pending)
    this.#executions?.releaseConversation(session)
    this.#migratedOwners.delete(session)
    this.connectionRuntime.releaseOwner(session)
    this.conversations.archive(session)
  }
  async catalog(session: string, id: string, generation: unknown, input: CatalogRequest, signal?: AbortSignal, hooks?: { onDispatched?(): void }): Promise<CatalogResult> {
    return this.request(session, id, generation, 'catalog', input, signal, undefined, hooks)
  }
  async redisRequest(session: string, id: string, generation: unknown, action: 'redis-command' | 'redis-scan' | 'redis-key-suggest' | 'redis-key', raw: unknown, signal?: AbortSignal, initiator: 'user' | 'ai' = 'user', options?: { queryRevision?: number; record?: boolean; context?: Record<string, string> }): Promise<Record<string, unknown>> {
    const entry = this.#entry(id)
    if (!entry || !getSourceRuntime(entry.connection.dialect).actions.includes(action)) throw fail('请选择有效的 Redis 连接。', CONNECTION_ERROR_CODES.offline)
    const input = raw && typeof raw === 'object' ? raw as ServiceRequest : {}
    let database = input.database === undefined || input.database === '' ? undefined : String(input.database)
    if (database !== undefined) database = assertRedisDatabaseId(database)
    const mode = entry.connection.settings && 'redisMode' in entry.connection.settings ? entry.connection.settings.redisMode : undefined
    assertRedisClusterDatabase(database, mode)
    if (action === 'redis-command') return this.executeText(session, id, generation, input.command, signal, initiator, undefined, options?.queryRevision, undefined, { database: database ?? entry.connection.database })
    if (initiator === 'ai' && this.getExecutionDocument(session, id, generation).controller !== 'ai') throw new Error('用户已接管 AI Query，无法继续操作 Redis。')
    const prepared = redisPreparedInput(action, input, database)
    return this.#withReadonly(id, () => this.#dispatch(session, id, generation, action, prepared, signal), 'manual', signal) as Promise<Record<string, unknown>>
  }
  async executeCatalogTool(session: string, id: string, generation: unknown, input: CatalogToolInput, signal?: AbortSignal, callId?: string, rootCallId?: string): Promise<Record<string, unknown>> {
    const connection = this.#entry(id)?.connection
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
    const connection = this.#entry(id)?.connection, document = this.getExecutionDocument(session, id, generation)
    if (!connection || connection.dialect !== 'redis' || document.controller !== 'ai') throw new Error('Redis 连接或控制权已变化。')
    const prepared = prepareRedisReadOperation(operation, input, document.context, connection)
    const response = await runOperation(this.#executions, sqlOperationBinding(session, connection), { operation, title: prepared.title, initiator: 'ai', callId, rootCallId, type: 'tool' },
      (workSignal, onDispatched) => this.#withReadonly(id, () => this.#dispatch(session, id, generation, prepared.action, prepared.input as ServiceRequest, workSignal, undefined, {
        beforeDispatch: () => { const current = this.getExecutionDocument(session, id, generation); assertDocumentRevision(current, document.revision, 'AI Query 已变化。'); if (current.controller !== 'ai') throw new Error('AI Query 已变化。') }, onDispatched,
      }), 'ai', workSignal) as Promise<Record<string, unknown>>, prepared.summarize, signal, prepared.classifyResult,
      { classifyInterruption: (_error, lifecycle) => lifecycle.aborted ? 'cancelled' : 'failed', summarizeFailure: prepared.summarizeFailure })
    const { executionStatus: _status, ...result } = response
    return result
  }
  async executeText(session: string, id: string, generation: unknown, text: unknown, signal?: AbortSignal, initiator: 'user' | 'ai' = 'user', callId?: string, queryRevision?: number, rootCallId?: string, context?: unknown, options?: { type?: ExecutionType; sql?: TextEntryOptions; onCreated?(executionId: string): void }): Promise<Record<string, unknown>> {
    return new TextOperationRunner({
      executions: this.#executions, valid: owner => !this.#closed && this.sessionValid(owner),
      connection: key => this.#entry(key)?.connection,
      document: (owner, key, gen) => this.getExecutionDocument(owner, key, gen),
      acquireRun: key => this.#acquireRun(key), releaseRun: (key, lease) => this.#releaseRun(key, lease),
      send: (owner, key, gen, prepared, workSignal, hooks) => this.#withReadonly(key,
        () => this.#dispatch(owner, key, gen, prepared.action, prepared.input, workSignal,
          prepared.sourceKind === 'sql' ? prepared.authorized as TrustedAuthorization : undefined, hooks),
        prepared.queue ?? 'manual', workSignal) as Promise<Record<string, unknown>>,
    }).run(session, id, generation, text, signal, initiator, callId, queryRevision, rootCallId, context, options)
  }
  async request(session: string, id: string, generation: unknown, action: ServiceRequestAction, input: ServiceRequest, signal?: AbortSignal, authorized?: TrustedAuthorization, hooks?: { beforeDispatch?(): void; onDispatched?(): void }): Promise<CatalogResult> {
    if (!input || (action === 'catalog' && !['schemas', 'schema', 'tables', 'table', 'indexes'].includes(input.kind || ''))) throw new Error('目录请求无效。')
    if (signal?.aborted) throw fail('请求已取消。', CONNECTION_ERROR_CODES.cancelled)
    const run = () => this.#dispatch(session, id, generation, action, input, signal, authorized, hooks)
    if ((action === 'query' || action === 'manual-query') && !authorized && !hooks) {
      return await this.executeText(session, id, generation, input.sql, signal, 'user', undefined, undefined, undefined, { schema: input.schema ?? this.#entry(id)?.connection.database ?? '' }, { sql: { sourceKind: 'sql', entry: action, input: input as Record<string, unknown> } }) as CatalogResult
    }
    if (action === 'catalog') return this.#withCatalog(id, run, signal, input.background === true)
    if (action === 'maintenance') return this.#withMaintenance(id, run)
    return this.#withReadonly(id, run, action === 'query' ? 'ai' : 'manual', signal)
  }
  async #dispatch(session: string, id: string, generation: unknown, action: string, input: ServiceRequest, signal?: AbortSignal, authorized?: TrustedAuthorization, hooks?: { beforeDispatch?(): void; onDispatched?(): void }): Promise<CatalogResult> {
    if (signal?.aborted) throw fail('请求已取消。', CONNECTION_ERROR_CODES.cancelled)
    const entry = this.#entry(id)
    if (!entry || this.#closed || !this.sessionValid(session)) throw fail('连接已变化或当前对话已失效，请刷新。', CONNECTION_ERROR_CODES.stale)
    if (entry.connection.health === 'offline' || (!entry.connection.live && entry.connection.health !== 'degraded')) throw fail('请先连接数据库。', CONNECTION_ERROR_CODES.offline)
    if (entry.connection.generation !== generation) throw fail('连接已变化或当前对话已失效，请刷新。', CONNECTION_ERROR_CODES.stale)
    if (!getSourceRuntime(entry.connection.dialect).actions.includes(action)) throw new Error('请求与数据源类型不匹配。')
    if (this.#isChanging(id)) throw fail('连接正在更新，请等待连接保存完成。', CONNECTION_ERROR_CODES.busy)
    if (entry.cancelling) throw fail('连接正在取消底层请求，请稍后再试。', CONNECTION_ERROR_CODES.busy)
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
    let progress: Record<string, unknown> | undefined
    const preserveReceipt = (error: Error) => {
      if (progress && (action === 'query' || action === 'manual-query')) Object.assign(error, { effect: (error as {effect?: string}).effect || 'unknown', phase: (error as {phase?: string}).phase || 'receipt', steps: (error as {steps?: unknown}).steps || progress.steps, batch: (error as {batch?: unknown}).batch || progress.batch })
      if (progress?.kind === 'produce-batch' && action === 'kafka-produce-batch') Object.assign(error, { effect: 'unknown', phase: 'receipt', sourceResult: { ...progress, status: 'unknown' } })
      return error
    }
    try {
      const result = await workerExchange<CatalogResult>(entry.worker,requestId,hostDeadlineFor(action),signal, settle => {
        const finish = (error?: Error, value?: CatalogResult) => {
          settle(error ? preserveReceipt(error) : undefined,value)
        }
        const terminateWorker = (text: string) => {
          if (progress && !this.#closed && (this.#entry(id) === entry || (entry.unexpectedlyClosed && !this.#hasEntry(id))) && this.sessionValid(session)) finish(undefined, { ...progress, status: 'unknown', message: text, collectedAt: new Date().toISOString(), source: '插件已接收的 DDL 逐步执行回执' })
          else finish(new Error(text))
          if (this.#entry(id) === entry) { this.#dropEntry(id, entry, 'closed') }
          void entry.worker.terminate()
        }
        const quarantineCancellation = () => {
          entry.cancelling = (entry.cancelling || 0) + 1
          this.#busyAdd(entry.worker)
          let cleared = false
          const clear = () => { if (cleared) return; cleared = true; clearTimeout(timer); entry.worker.off('message', receipt); entry.worker.off('exit', clear); entry.worker.off('error', clear); entry.cancelling = Math.max(0, (entry.cancelling || 0) - 1); this.#busyDone(entry.worker); this.#readSlots.drain(); this.#catalogSlots.drain() }
          const receipt = (reply: unknown) => { if (workerReplyHeaderValid(reply) && reply.requestId === requestId && !reply.progress && !reply.sqlProgress) clear() }
          const timer = setTimeout(() => { clear(); if (this.#entry(id) === entry) this.#dropEntry(id, entry, 'closed'); void entry.worker.terminate() }, 1000)
          timer.unref()
          entry.worker.on('message', receipt); entry.worker.once('exit', clear); entry.worker.once('error', clear)
        }
        const cancel = () => {
          quarantineCancellation()
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
          if (this.#entry(id) !== entry || !this.sessionValid(session)) finish(fail('连接或对话已变化，已丢弃迟到结果。', CONNECTION_ERROR_CODES.stale))
          else if (reply.progress || reply.sqlProgress) { progress = reply.progress || reply.sqlProgress; return }
          else if (!reply.error && (reply.cancelled || signal?.aborted)) finish(action === 'redis-command' || action === 'redis-key' ? new Error('Redis 操作已取消，执行结果未知，请核验。') : fail('读取已取消。', CONNECTION_ERROR_CODES.cancelled))
          else if (reply.error) finish(Object.assign(workerError(reply.error, reply.code), { effect: reply.effect, phase: reply.phase, category: reply.category, databaseCode: reply.databaseCode, steps: reply.steps, batch: reply.batch }))
          else if (reply.result === undefined) finish(Object.assign(new Error('缺少有效执行回执，结果未知。'), { effect: 'unknown', phase: 'receipt' }))
          else finish(undefined, reply.result)
        }
        const timeout = () => {
          try { entry.worker.postMessage({ cancel: true, requestId }) } catch { /* ignore */ }
          const deadline = hostDeadlineFor(action)
          if (action === 'maintenance') terminateWorker(hostTimeoutMessage(action, deadline))
          else {
            finish(Object.assign(new Error(authorized?.kind === 'write' ? `写入超过 ${Math.round(deadline / 1000)} 秒，结果未知，请核验，勿重复提交。` : action === 'redis-command' || action === 'redis-key' ? 'Redis 操作超时，执行结果未知，请核验。' : hostTimeoutMessage(action, deadline)), { effect: 'unknown', phase: 'receipt' }))
            if (this.#entry(id) === entry) this.#dropEntry(id, entry, 'closed')
            void entry.worker.terminate()
          }
        }
        const send = () => {
        try { hooks?.beforeDispatch?.() } catch (error) { finish(error as Error); return }
        if (signal?.aborted) { finish(fail('请求已取消。', CONNECTION_ERROR_CODES.cancelled)); return }
        try {
          entry.worker.postMessage({ requestId, action, input: { ...input, conversationId: session }, ...(authorized ? { authorized, lane: input.lane === 'manual' ? 'manual' : 'query' } : {}) })
          hooks?.onDispatched?.()
        } catch (error) { finish(error as Error) }
        }
        return {message,exit:exited,abort:cancel,timeout,send}
      }).catch(error => { throw preserveReceipt(error) })
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
        this.#record(id).retryAttempts = 0
        this.#clearRevive(id)
      }
      return action === 'catalog' ? structuredClone(result) : result
    } finally { this.#busyDone(entry.worker) }
  }
  #applyHealth(entry: Entry, health: Connection['health'], category?: ConnectionFailureCategory, fromRequest = false): void {
    const id = entry.connection.id, runtime = this.#record(id)
    if (!health || runtime.entry !== entry || this.#rows?.get(id)?.desiredState !== 'online') return
    // A successful query is not proof that the catalog/control transport recovered.
    if (health === 'ready' && fromRequest && entry.connection.health !== 'ready') return
    if (category === 'authentication' || category === 'configuration') { runtime.recoveryBlocked = true; this.#clearRevive(id) }
    if (entry.connection.health !== health) { entry.connection = { ...entry.connection, health, live: health === 'ready' || health === 'degraded' }; this.#bump() }
    if (health === 'ready') { this.#clearRevive(id); runtime.retryAttempts = 0 }
    else if (!runtime.recoveryBlocked && (health === 'degraded' || health === 'offline')) this.#scheduleRevive(id)
  }
  #clearRevive(id: string): void { if (this.connectionRuntime.clearRetry(id)) this.#bump() }
  #scheduleRevive(id: string): void {
    const runtime = this.#record(id), row = this.#rows?.get(id)
    if (this.#closed || !row || row.desiredState !== 'online' || !runtime.everReady || runtime.recoveryBlocked || runtime.timer || this.#isChanging(id) || runtime.entry?.connection.health === 'ready') return
    if (!runtime.entry && !canReuseSavedLogin({ dialect: row.settings.dialect, hasPassword: !!row.protectedPassword })) {
      if (runtime.attempt) { runtime.attempt.projection.category = 'authentication'; runtime.attempt.projection.message = '连接已关闭，请重新输入密码连接。'; this.#bump() }
      runtime.recoveryBlocked = true
      return
    }
    const delay = recoveryDelay(runtime.retryAttempts)
    if (runtime.attempt) runtime.attempt.projection.nextRetryAt = Date.now() + delay
    runtime.timer = setTimeout(() => { runtime.timer = undefined; this.#runRevive(id) }, delay)
    runtime.timer.unref(); this.#bump()
  }
  #runRevive(id: string): void {
    const runtime = this.#record(id), row = this.#rows?.get(id)
    if (this.#closed || !row || row.desiredState !== 'online' || runtime.recoveryBlocked || this.#isChanging(id)) return
    if (runtime.entry?.busy || this.#maintaining.has(id) || this.#readSlots.active(id) || this.#catalogSlots.active(id)) { this.#scheduleRevive(id); return }
    runtime.retryAttempts++
    const session = runtime.entry?.session || runtime.attempt?.session
    if (!session || !this.sessionValid(session)) return
    try { this.#beginConnection(session, { ...row.settings, password: '', useSavedPassword: true, rememberPassword: true }, randomUUID(), id, true, 'recover') }
    catch (error) { runtime.recoveryBlocked = connectionFailure(error) !== 'network'; this.#scheduleRevive(id) }
  }
  async #rpc(entry: Entry, action: string, input: Record<string, unknown>, timeout: number, signal?: AbortSignal): Promise<CatalogResult & ConnectionTest & { health?: string }> {
    const requestId = randomUUID()
    this.#busyAdd(entry.worker)
    try {
      return await workerExchange<CatalogResult & ConnectionTest & {health?:string}>(entry.worker,requestId,timeout,signal,finish=>({
        exit:()=>finish(fail('连接已关闭。',CONNECTION_ERROR_CODES.closed)),
        message:reply=>{
          if (this.#entry(entry.connection.id) !== entry || signal?.aborted) { finish(fail('连接已变化。', CONNECTION_ERROR_CODES.stale)); return }
          if(reply.health)this.#applyHealth(entry,reply.health === 'closed' ? 'offline' : reply.health,
            reply.connectionCategory || reply.category ? connectionFailure({ category: reply.connectionCategory || reply.category }) : undefined)
          reply.error?finish(Object.assign(workerError(reply.error,reply.code), { category: reply.connectionCategory || reply.category || connectionFailure(reply.error) })):finish(undefined,reply.result)
        },
        timeout:()=>{finish(fail(connectTimeoutMessage(false),CONNECTION_ERROR_CODES.timeout));this.#dropEntry(entry.connection.id,entry,'closed');void entry.worker.terminate()},
        abort:()=>{finish(fail('连接操作已取消。',CONNECTION_ERROR_CODES.cancelled));this.#dropEntry(entry.connection.id,entry,'closed');void entry.worker.terminate()},
        send:()=>entry.worker.postMessage({requestId,action,input}),
      }))
    } finally { this.#busyDone(entry.worker) }
  }
  async #recover(session: string, id: string, attempt?: ConnectionAttempt, epoch?: number): Promise<Connection> {
    const entry = this.#entry(id)
    const stored = this.#rows!.get(id)
    if (!entry || !stored) throw fail('连接不存在或当前对话已失效。', CONNECTION_ERROR_CODES.offline)
    if (attempt) { attempt.worker = entry.worker; this.#assertAttempt(id, attempt, epoch!) }
    try {
      const result = await this.#rpc(entry, 'revive', {}, HOST_TIMEOUTS.connect, attempt?.controller.signal)
      if (attempt) this.#assertAttempt(id, attempt, epoch!)
      entry.connection = {
        ...entry.connection,
        live: true,
        health: 'ready',
        version: result.version || entry.connection.version,
        database: result.database || entry.connection.database,
      }
      this.#record(id).retryAttempts = 0
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
    this.#connectSlots.close(); this.#readSlots.close(); this.#catalogSlots.close()
    const workers = new Set<Worker>()
    for (const [id, runtime] of this.#runtime) {
      this.#clearRevive(id)
      runtime.attempt?.controller.abort()
      if (runtime.entry) workers.add(runtime.entry.worker)
      if (runtime.attempt?.worker) workers.add(runtime.attempt.worker)
    }
    for (const [worker, test] of this.#tests) { test.controller.abort(); workers.add(worker) }
    await Promise.allSettled([...workers].map(worker => worker.terminate()))
    await Promise.allSettled([...this.#runtime.values()].flatMap(runtime => runtime.attempt ? [runtime.attempt.promise] : []))
    this.connectionRuntime.clear(); this.#tests.clear(); this.#cache.clear(); this.#rows = undefined
    await this.#executions?.dispose()
  }
}

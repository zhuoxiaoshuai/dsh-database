import { randomUUID } from 'node:crypto'
import { existsSync, mkdirSync, readFileSync, renameSync, rmSync, writeFileSync } from 'node:fs'
import { rename, rm, writeFile, mkdir } from 'node:fs/promises'
import { dirname, join } from 'node:path'
import { databaseWorkspaceRoot } from './dsh-home.ts'
import type { Result } from '../shared/workbench.ts'
import {
  canTransition, clipSql, clipResultPreview, clipNarrative, EXECUTION_REASON_MAX, EXECUTION_TITLE_MAX, inferExecutionType, isTerminalStatus, publicExecution, summarizeParams,
  type ExecutionEventKind, type ExecutionRecord, type ExecutionStatus, type ExecutionType, type WorkbenchEvent,
} from '../shared/execution.ts'

const CONVERSATION_CAP = 100
const GLOBAL_CAP = 2000
const FILE_BUDGET = 2 * 1024 * 1024

export class ExecutionStore {
  #records = new Map<string, ExecutionRecord>()
  #results = new Map<string, Result>()
  #controllers = new Map<string, AbortController>()
  #waiters = new Set<() => void>()
  #clock = new Map<string, number>()
  #eventLog = new Map<string, { seq: number; event: WorkbenchEvent }[]>()
  #path: string
  #closed = false
  readonly #persistMode: 'sync' | 'async'
  /** 异步写链：同刻至多一个写在飞；写前取 #lastText（最新快照），中间态合并不落盘 */
  #flushChain: Promise<void> = Promise.resolve()
  #flushScheduled = false
  #lastText = ''

  constructor(directory?: string, persistMode: 'sync' | 'async' = 'sync') {
    const root = databaseWorkspaceRoot(directory)
    this.#path = join(root, 'ai-executions.json')
    this.#persistMode = persistMode
    this.#load()
  }

  create(input: {
    conversationId: string
    callId?: string
    rootCallId?: string
    connectionId?: string
    generation?: string
    connectionName?: string
    dialect?: string
    environment?: string
    schema?: string
    operation: string
    tables?: string[]
    columns?: string[]
    sql?: string
    params?: unknown
    draft?: Record<string, unknown>
    initiator?: 'ai' | 'user'
    title?: string
    reason?: string
    conclusion?: string
    type?: ExecutionType
    queryRevision?: number
    executedSql?: string
    historyVisible?: boolean
  }): ExecutionRecord {
    if (this.#closed) throw new Error('插件已释放。')
    const now = new Date().toISOString()
    const record: ExecutionRecord = {
      executionId: randomUUID(),
      conversationId: input.conversationId,
      callId: typeof input.callId === 'string' ? input.callId : '',
      rootCallId: typeof input.rootCallId === 'string' ? input.rootCallId : (typeof input.callId === 'string' ? input.callId : ''),
      connectionId: input.connectionId,
      generation: input.generation,
      connectionName: input.connectionName,
      dialect: input.dialect,
      environment: input.environment,
      schema: input.schema,
      operation: input.operation,
      tables: (input.tables || []).slice(0, 32),
      columns: input.columns,
      status: 'preparing',
      createdAt: now,
      updatedAt: now,
      sql: clipSql(input.sql),
      paramSummary: summarizeParams(input.params),
      resultPersisted: false,
      events: [{ kind: 'created', at: now, elapsedMs: 0 }],
      draft: input.draft,
      initiator: input.initiator,
      title: clipNarrative(input.title, EXECUTION_TITLE_MAX),
      reason: clipNarrative(input.reason, EXECUTION_REASON_MAX),
      conclusion: clipNarrative(input.conclusion, 200),
      type: input.type || inferExecutionType(input.operation),
      queryRevision: input.queryRevision,
      executedSql: clipSql(input.executedSql || input.sql),
      historyVisible: input.historyVisible === true,
      revision: 1,
    }
    this.#records.set(record.executionId, record)
    this.#trim()
    this.#persist()
    this.#notifyConversation(record.conversationId)
    return this.get(record.conversationId, record.executionId)!
  }

  attachAbort(executionId: string, controller: AbortController): void {
    this.#controllers.set(executionId, controller)
  }

  list(conversationId: string): ExecutionRecord[] {
    return [...this.#records.values()]
      .filter(row => row.conversationId === conversationId)
      .sort((a, b) => b.updatedAt.localeCompare(a.updatedAt))
      .map(row => publicExecution(row))
  }

  get(conversationId: string, executionId: string, includeResult = false): (ExecutionRecord & { result?: Result; resultMissing?: boolean }) | undefined {
    const record = this.#records.get(executionId)
    if (!record || record.conversationId !== conversationId) return undefined
    const result = includeResult ? this.#results.get(executionId) || record.resultPreview : undefined
    return publicExecution({ ...record, resultPersisted: !!(result || record.resultPreview) }, result)
  }

  revision(conversationId: string): number {
    return this.clock(conversationId)
  }

  clock(conversationId: string): number {
    return this.#clock.get(conversationId) || this.list(conversationId).reduce((max, row) => Math.max(max, row.revision), 0)
  }

  emitWorkbench(conversationId: string, event: WorkbenchEvent): void {
    this.#notifyConversation(conversationId, event)
  }

  latestDisplay(conversationId: string, connectionId: string): (ExecutionRecord & { result?: Result; resultMissing?: boolean }) | undefined {
    const match = this.list(conversationId).find(row => {
      const type = row.type || inferExecutionType(row.operation)
      return row.connectionId === connectionId
        && (type === 'query' || type === 'write' || type === 'explain')
        && row.status === 'succeeded'
        && (row.resultPersisted || !!row.resultMeta)
    })
    return match ? this.get(conversationId, match.executionId, true) : undefined
  }

  async wait(conversationId: string, revision: number, ms = 10000, signal?: AbortSignal): Promise<{ revision: number; items: ExecutionRecord[]; events: WorkbenchEvent[]; gap: boolean }> {
    const current = this.clock(conversationId)
    if (current !== revision) return this.#page(conversationId, revision)
    await new Promise<void>(resolve => {
      let timer: ReturnType<typeof setTimeout>
      const finish = () => { clearTimeout(timer); signal?.removeEventListener('abort', finish); this.#waiters.delete(finish); resolve() }
      timer = setTimeout(finish, Math.min(Math.max(ms, 0), 10000))
      this.#waiters.add(finish)
      signal?.addEventListener('abort', finish, { once: true })
    })
    return this.#page(conversationId, revision)
  }

  event(executionId: string, kind: ExecutionEventKind, message?: string): void {
    const record = this.#records.get(executionId)
    if (!record) return
    const at = new Date().toISOString()
    record.events.push({ kind, at, elapsedMs: Date.parse(at) - Date.parse(record.createdAt), message })
    record.updatedAt = at
    record.revision += 1
    this.#persist()
    this.#notifyConversation(record.conversationId)
  }

  transition(executionId: string, status: ExecutionStatus, message?: string): ExecutionRecord | undefined {
    const record = this.#records.get(executionId)
    if (!record || !canTransition(record.status, status)) return record
    record.status = status
    if (message) record.message = message.slice(0, 500)
    record.updatedAt = new Date().toISOString()
    record.revision += 1
    if (isTerminalStatus(status)) this.#controllers.delete(executionId)
    this.#persist()
    this.#notifyConversation(record.conversationId)
    return record
  }

  annotate(executionId: string, patch: { sql?: string; params?: unknown; draft?: Record<string, unknown>; tables?: string[]; title?: string; reason?: string; conclusion?: string; type?: ExecutionType; executedSql?: string }): void {
    const record = this.#records.get(executionId)
    if (!record) return
    if (patch.sql !== undefined) record.sql = clipSql(patch.sql)
    if (patch.executedSql !== undefined) record.executedSql = clipSql(patch.executedSql)
    if (patch.params !== undefined) record.paramSummary = summarizeParams(patch.params)
    if (patch.draft !== undefined) record.draft = patch.draft
    if (patch.tables !== undefined) record.tables = patch.tables.slice(0, 32)
    if (patch.title !== undefined) record.title = clipNarrative(patch.title, EXECUTION_TITLE_MAX)
    if (patch.reason !== undefined) record.reason = clipNarrative(patch.reason, EXECUTION_REASON_MAX)
    if (patch.conclusion !== undefined) record.conclusion = clipNarrative(patch.conclusion, 200)
    if (patch.type !== undefined) record.type = patch.type
    record.updatedAt = new Date().toISOString()
    record.revision += 1
    this.#persist()
    this.#notifyConversation(record.conversationId)
  }

  complete(executionId: string, status: ExecutionStatus, message?: string, result?: Result, conclusion?: string): void {
    const record = this.#records.get(executionId)
    if (!record) return
    if (isTerminalStatus(record.status)) {
      this.event(executionId, 'late-result', '迟到结果已丢弃，未改写终态。')
      return
    }
    if (result) {
      const preview = clipResultPreview(result)
      if (preview) this.#results.set(executionId, preview)
      record.resultPreview = preview
      record.resultMeta = { columns: result.columns, rowCount: result.rows.length, truncated: result.truncated, elapsedMs: result.elapsedMs }
      record.resultPersisted = !!preview
    }
    const nextConclusion = clipNarrative(conclusion, 200) || record.conclusion || clipNarrative(
      status === 'succeeded' && result ? `返回 ${result.rows.length} 行${result.truncated ? '（已截断）' : ''}` : message, 200,
    )
    if (nextConclusion) record.conclusion = nextConclusion
    this.event(executionId, 'result', message)
    this.transition(executionId, status, message)
  }

  cancel(conversationId: string, executionId: string, dispatched: boolean): ExecutionRecord | undefined {
    const record = this.#records.get(executionId)
    if (!record || record.conversationId !== conversationId) return undefined
    if (isTerminalStatus(record.status)) return record
    this.#controllers.get(executionId)?.abort()
    this.event(executionId, 'cancel', dispatched ? '取消时请求已发往数据库。' : '请求尚未发往数据库。')
    const status = dispatched && record.status === 'running' ? 'unknown' : 'cancelled'
    record.conclusion = clipNarrative(status === 'unknown' ? '已请求取消，结果未知。' : '已取消', 200)
    this.transition(executionId, status, dispatched ? '已请求取消，无法确认数据库是否已中止，结果未知。' : '已取消。')
    return this.get(conversationId, executionId)
  }

  observeMaintenance(conversationId: string, executionId: string, result: { status?: string; message?: string }): void {
    const record = this.#records.get(executionId)
    if (!record || record.conversationId !== conversationId) return
    if (record.status === 'awaiting_confirmation') this.transition(executionId, 'running')
    const status = result.status === 'success' ? 'succeeded' : result.status === 'unknown' ? 'unknown' : 'failed'
    this.complete(executionId, status, result.message)
  }

  invalidateGeneration(connectionId: string, generation: string, reason: string): void {
    for (const record of this.#records.values()) {
      if (record.connectionId !== connectionId || record.generation !== generation || isTerminalStatus(record.status)) continue
      this.#controllers.get(record.executionId)?.abort()
      this.event(record.executionId, 'disconnect', reason)
      record.conclusion = clipNarrative('连接已失效，结果未知。', 200)
      this.transition(record.executionId, record.status === 'running' ? 'unknown' : 'cancelled', '连接代次已失效，迟到结果不会进入新连接。')
    }
  }

  invalidateConnection(connectionId: string, reason: string): void {
    for (const record of this.#records.values()) {
      if (record.connectionId !== connectionId || isTerminalStatus(record.status)) continue
      this.invalidateGeneration(connectionId, record.generation || '', reason)
    }
  }

  cancelConversation(conversationId: string, reason: string): void {
    for (const record of this.#records.values()) {
      if (record.conversationId !== conversationId || isTerminalStatus(record.status)) continue
      this.#controllers.get(record.executionId)?.abort()
      this.event(record.executionId, 'cancel', reason)
      this.transition(record.executionId, record.status === 'running' ? 'unknown' : 'cancelled', reason)
    }
  }

  dispatched(executionId: string): boolean {
    const record = this.#records.get(executionId)
    return !!record?.events.some(event => event.kind === 'dispatched')
  }

  async dispose(): Promise<void> {
    this.#closed = true
    for (const record of this.#records.values()) {
      if (isTerminalStatus(record.status)) continue
      this.#controllers.get(record.executionId)?.abort()
      this.transition(record.executionId, record.status === 'running' ? 'unknown' : 'cancelled', '插件已释放。')
    }
    this.#controllers.clear()
    this.#results.clear()
    this.#persist()
    this.#waiters.forEach(fn => fn())
    this.#waiters.clear()
    // 异步模式下等待最后一次落盘收敛，保证 dispose 后磁盘即最新
    await this.#flushChain
  }

  #notifyConversation(conversationId: string, event?: WorkbenchEvent): void {
    const next = this.clock(conversationId) + 1
    this.#clock.set(conversationId, next)
    if (event) {
      const log = this.#eventLog.get(conversationId) || []
      log.push({ seq: next, event })
      this.#eventLog.set(conversationId, log.slice(-80))
    }
    this.#notify()
  }

  #page(conversationId: string, seen: number): { revision: number; items: ExecutionRecord[]; events: WorkbenchEvent[]; gap: boolean } {
    const revision = this.clock(conversationId)
    const log = this.#eventLog.get(conversationId) || []
    const events = log.filter(item => item.seq > seen).map(item => item.event)
    const oldest = log[0]?.seq
    const gap = seen > 0 && (
      (log.length === 0 && revision > seen)
      || (oldest != null && oldest > seen + 1 && !log.some(item => item.seq === seen + 1))
    )
    return { revision, items: this.list(conversationId), events, gap }
  }

  #notify(): void {
    for (const fn of [...this.#waiters]) fn()
  }

  #bucketKey(row: ExecutionRecord): string {
    return `${row.conversationId}\x00${row.connectionId || ''}`
  }

  #trimBucket(rows: ExecutionRecord[]): string[] {
    if (rows.length <= CONVERSATION_CAP) return rows.map(row => row.executionId)
    const sorted = [...rows].sort((a, b) => b.updatedAt.localeCompare(a.updatedAt))
    const keep = sorted.slice(0, CONVERSATION_CAP)
    const drop = sorted.slice(CONVERSATION_CAP)
    for (const active of drop.filter(row => !isTerminalStatus(row.status))) {
      let victimIdx = -1
      let victimTime = ''
      for (let i = 0; i < keep.length; i++) {
        if (!isTerminalStatus(keep[i].status)) continue
        if (victimIdx < 0 || keep[i].updatedAt.localeCompare(victimTime) < 0) {
          victimIdx = i
          victimTime = keep[i].updatedAt
        }
      }
      if (victimIdx < 0) break
      keep[victimIdx] = active
    }
    return keep.map(row => row.executionId)
  }

  #trim(): void {
    const buckets = new Map<string, ExecutionRecord[]>()
    for (const row of this.#records.values()) {
      const key = this.#bucketKey(row)
      const list = buckets.get(key) || []
      list.push(row)
      buckets.set(key, list)
    }
    const keep = new Set<string>()
    for (const rows of buckets.values()) {
      for (const id of this.#trimBucket(rows)) keep.add(id)
    }
    if (keep.size > GLOBAL_CAP) {
      const victims = [...keep]
        .map(id => this.#records.get(id))
        .filter((row): row is ExecutionRecord => !!row)
        .sort((a, b) => {
          const terminal = Number(isTerminalStatus(b.status)) - Number(isTerminalStatus(a.status))
          return terminal || a.updatedAt.localeCompare(b.updatedAt)
        })
        .slice(0, keep.size - GLOBAL_CAP)
      for (const row of victims) keep.delete(row.executionId)
    }
    for (const id of [...this.#records.keys()]) {
      if (keep.has(id)) continue
      this.#records.delete(id)
      this.#results.delete(id)
    }
  }

  #load(): void {
    if (!existsSync(this.#path)) return
    try {
      const parsed = JSON.parse(readFileSync(this.#path, 'utf8'))
      if (!Array.isArray(parsed.records)) return
      for (const row of parsed.records) {
        if (!row || typeof row.executionId !== 'string' || typeof row.conversationId !== 'string') continue
        this.#records.set(row.executionId, {
          ...row,
          sql: clipSql(row.sql),
          events: Array.isArray(row.events) ? row.events.slice(-50) : [],
          resultPreview: clipResultPreview(row.resultPreview),
          resultPersisted: !!row.resultPreview,
          historyVisible: row.historyVisible === true,
          title: clipNarrative(row.title, EXECUTION_TITLE_MAX),
          reason: clipNarrative(row.reason, EXECUTION_REASON_MAX),
          conclusion: clipNarrative(row.conclusion, 200),
        })
        if (row.resultPreview) this.#results.set(row.executionId, clipResultPreview(row.resultPreview)!)
      }
      this.#trim()
    } catch { /* unreadable ledger is ignored */ }
  }

  #persist(): void {
    // 序列化（含预算裁剪）在调用线程完成；实际写盘按 persistMode 同步执行或排队异步执行
    const text = this.#serialize()
    if (this.#persistMode === 'sync') {
      this.#writeTempSync(text)
      return
    }
    // 循环写：写前取最新 text，同刻高频调用只落盘最终状态
    this.#lastText = text
    if (this.#flushScheduled) return
    this.#flushScheduled = true
    this.#flushChain = this.#flushChain.then(() => this.#flushAsync())
  }

  #serialize(): string {
    const ordered = [...this.#records.values()].sort((a, b) => a.updatedAt.localeCompare(b.updatedAt))
    const dropPreview = new Set<string>()
    const serialize = () => JSON.stringify({
      version: 2,
      records: ordered.map(row => ({
        executionId: row.executionId,
        conversationId: row.conversationId,
        callId: row.callId,
        rootCallId: row.rootCallId,
        connectionId: row.connectionId,
        generation: row.generation,
        connectionName: row.connectionName,
        dialect: row.dialect,
        environment: row.environment,
        schema: row.schema,
        operation: row.operation,
        tables: row.tables,
        columns: row.columns,
        status: row.status,
        createdAt: row.createdAt,
        updatedAt: row.updatedAt,
        sql: row.sql,
        paramSummary: row.paramSummary,
        message: row.message,
        resultMeta: row.resultMeta,
        resultPersisted: !dropPreview.has(row.executionId) && !!row.resultPreview,
        events: row.events,
        draft: row.draft && { kind: row.draft.kind, schema: row.draft.schema, table: row.draft.table, sql: clipSql(row.draft.sql) },
        revision: row.revision,
        initiator: row.initiator,
        type: row.type,
        historyVisible: row.historyVisible === true,
        queryRevision: row.queryRevision,
        executedSql: row.executedSql,
        title: row.title,
        reason: row.reason,
        conclusion: row.conclusion,
        resultPreview: dropPreview.has(row.executionId) ? undefined : row.resultPreview,
      })),
    })
    let text = serialize()
    if (Buffer.byteLength(text) > FILE_BUDGET) {
      for (const row of ordered) {
        if (!row.resultPreview) continue
        dropPreview.add(row.executionId)
        const current = this.#records.get(row.executionId)
        if (current) {
          current.resultPreview = undefined
          current.resultPersisted = false
        }
        this.#results.delete(row.executionId)
        text = serialize()
        if (Buffer.byteLength(text) <= FILE_BUDGET) break
      }
    }
    while (Buffer.byteLength(text) > FILE_BUDGET && ordered.length) {
      const oldest = ordered.shift()
      if (!oldest) break
      this.#records.delete(oldest.executionId)
      this.#results.delete(oldest.executionId)
      text = serialize()
    }
    if (/protectedPassword|"password"\s*:|dpapi/i.test(text)) throw new Error('执行记录拒绝写入敏感字段。')
    return text
  }

  #writeTempSync(text: string): void {
    mkdirSync(dirname(this.#path), { recursive: true })
    const temp = `${this.#path}.${randomUUID()}.tmp`
    try {
      writeFileSync(temp, text, { mode: 0o600, flag: 'wx' })
      renameSync(temp, this.#path)
    } finally { rmSync(temp, { force: true }) }
  }

  /** 异步落盘：失败不阻塞工具链路（内存仍是权威状态），下轮 flush 会重试 */
  async #flushAsync(): Promise<void> {
    this.#flushScheduled = false
    const text = this.#lastText
    this.#lastText = ''
    try {
      await mkdir(dirname(this.#path), { recursive: true })
      const temp = `${this.#path}.${randomUUID()}.tmp`
      try {
        await writeFile(temp, text, { mode: 0o600, flag: 'wx' })
        await rename(temp, this.#path)
      } finally { await rm(temp, { force: true }) }
    } catch { /* 磁盘异常时丢弃本次落盘，内存状态不受影响 */ }
  }
}

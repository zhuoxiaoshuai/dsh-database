import { isAbortError, isCatalogView, type CatalogResult, type Connection, type WorkspaceBridge } from '../../shared/workbench.ts'
import { resolvePrimaryKeys } from '../../shared/primary-keys.ts'

export type CachedTable = {
  name: string
  kind: 'table' | 'view'
  comment: string
  record: Record<string, unknown>
}

export type CachedDetail = CatalogResult & { primaryKeys: string[] }

type LoadState<T> = { status: 'loading' | 'ready' | 'error'; value?: T; error?: string; epoch: number; promise?: Promise<void>; failedAt?: number }

export type SchemaCacheOptions = {
  now?(): number
  errorBackoffMs?: number
  prefetchConcurrency?: number
  prewarmTableLimit?: number
  emitCoalesceMs?: number
  schedule?(task: () => void): void
}

const DEFAULT_ERROR_BACKOFF_MS = 8000
const DEFAULT_PREFETCH_CONCURRENCY = 4
const DEFAULT_PREWARM_TABLE_LIMIT = 300
const DEFAULT_EMIT_COALESCE_MS = 120

function unrefTimer(timer: ReturnType<typeof setTimeout>): void {
  if (typeof timer === 'object' && timer && 'unref' in timer) (timer as NodeJS.Timeout).unref()
}

function defaultSchedule(task: () => void): void {
  const idle = (globalThis as { requestIdleCallback?(cb: () => void, options?: { timeout: number }): unknown }).requestIdleCallback
  if (typeof idle === 'function') idle(() => task(), { timeout: 200 })
  else unrefTimer(setTimeout(task, 0))
}

export class SchemaCache {
  #schemas = new Map<string, LoadState<Record<string, unknown>[]>>()
  #summaries = new Map<string, LoadState<CatalogResult>>()
  #tables = new Map<string, LoadState<CachedTable[]>>()
  #details = new Map<string, LoadState<CachedDetail>>()
  #listeners = new Set<() => void>()
  #catalog: NonNullable<WorkspaceBridge['catalog']>
  #now: () => number
  #errorBackoffMs: number
  #prefetchConcurrency: number
  #prewarmTableLimit: number
  #emitCoalesceMs: number
  #schedule: (task: () => void) => void
  #active = 0
  #highQueue: Array<() => void> = []
  #lowQueue: Array<() => void> = []
  #prewarmed = new Set<string>()
  #emitTimer: ReturnType<typeof setTimeout> | undefined
  constructor(catalog: NonNullable<WorkspaceBridge['catalog']>, options: SchemaCacheOptions = {}) {
    this.#catalog = catalog
    this.#now = options.now || Date.now
    this.#errorBackoffMs = options.errorBackoffMs ?? DEFAULT_ERROR_BACKOFF_MS
    this.#prefetchConcurrency = Math.max(1, options.prefetchConcurrency ?? DEFAULT_PREFETCH_CONCURRENCY)
    this.#prewarmTableLimit = Math.max(0, options.prewarmTableLimit ?? DEFAULT_PREWARM_TABLE_LIMIT)
    this.#emitCoalesceMs = options.emitCoalesceMs ?? DEFAULT_EMIT_COALESCE_MS
    this.#schedule = options.schedule || defaultSchedule
  }
  subscribe(listener: () => void): () => void {
    this.#listeners.add(listener)
    return () => { this.#listeners.delete(listener) }
  }
  #emit(): void { for (const listener of this.#listeners) listener() }
  #emitSoon(): void {
    if (this.#emitCoalesceMs <= 0) { this.#emit(); return }
    if (this.#emitTimer) return
    this.#emitTimer = setTimeout(() => { this.#emitTimer = undefined; this.#emit() }, this.#emitCoalesceMs)
    unrefTimer(this.#emitTimer)
  }
  #generationKey(connection: Connection): string {
    return `${connection.id}\0${connection.generation || ''}`
  }
  #tablesKey(connection: Connection, schema: string): string {
    return `${this.#generationKey(connection)}\0${connection.dialect}\0${schema}`
  }
  #detailKey(connection: Connection, schema: string, table: string): string {
    return `${this.#tablesKey(connection, schema)}\0${table}`
  }
  #summaryKey(connection: Connection, schema: string): string {
    return `${this.#generationKey(connection)}\0${schema}`
  }
  #prune(connection: Connection): void {
    const prefix = `${connection.id}\0`
    const gen = this.#generationKey(connection)
    for (const map of [this.#schemas, this.#summaries, this.#tables, this.#details] as const) {
      for (const key of [...map.keys()]) {
        if (key.startsWith(prefix) && key !== gen && !key.startsWith(gen + '\0')) map.delete(key)
      }
    }
    for (const key of [...this.#prewarmed]) {
      if (key.startsWith(prefix) && key !== gen && !key.startsWith(gen + '\0')) this.#prewarmed.delete(key)
    }
  }
  #inBackoff(state: LoadState<unknown> | undefined): boolean {
    return state?.status === 'error' && this.#now() - (state.failedAt || 0) < this.#errorBackoffMs
  }
  schemasSnapshot(connection: Connection): Record<string, unknown>[] | undefined {
    return this.#schemas.get(this.#generationKey(connection))?.value
  }
  schemasStatus(connection: Connection): LoadState<Record<string, unknown>[]> | undefined {
    return this.#schemas.get(this.#generationKey(connection))
  }
  schemaInfoSnapshot(connection: Connection, schema: string): CatalogResult | undefined {
    return this.#summaries.get(this.#summaryKey(connection, schema))?.value
  }
  schemaInfoStatus(connection: Connection, schema: string): LoadState<CatalogResult> | undefined {
    return this.#summaries.get(this.#summaryKey(connection, schema))
  }
  tablesSnapshot(connection: Connection, schema: string): CachedTable[] | undefined {
    return this.#tables.get(this.#tablesKey(connection, schema))?.value
  }
  tablesStatus(connection: Connection, schema: string): LoadState<CachedTable[]> | undefined {
    return this.#tables.get(this.#tablesKey(connection, schema))
  }
  detailSnapshot(connection: Connection, schema: string, table: string): CachedDetail | undefined {
    return this.#details.get(this.#detailKey(connection, schema, table))?.value
  }
  detailStatus(connection: Connection, schema: string, table: string): LoadState<CachedDetail> | undefined {
    return this.#details.get(this.#detailKey(connection, schema, table))
  }
  warmSchema(connection: Connection, schema: string): void {
    if (!schema) return
    this.#prune(connection)
    void this.loadTables(connection, schema).catch(() => {})
  }
  prefetchColumns(connection: Connection, schema: string, tables: string[]): void {
    if (!schema || !tables.length) return
    this.warmSchema(connection, schema)
    const listed = this.tablesSnapshot(connection, schema) || []
    const seen = new Set<string>()
    for (const raw of tables) {
      const name = listed.find(item => item.name.toLowerCase() === raw.toLowerCase())?.name || raw
      if (!name || seen.has(name.toLowerCase())) continue
      seen.add(name.toLowerCase())
      const current = this.#details.get(this.#detailKey(connection, schema, name))
      if (current?.status === 'ready' || current?.status === 'loading' || this.#inBackoff(current)) continue
      this.#enqueue(() => this.loadTable(connection, schema, name, { batched: true }).then(() => {}).catch(() => {}), 'high')
    }
  }
  prewarmSchema(connection: Connection, schema: string): void {
    if (!schema) return
    const key = this.#tablesKey(connection, schema)
    if (this.#prewarmed.has(key)) return
    this.#prewarmed.add(key)
    void this.loadTables(connection, schema)
      .then(() => {
        const ordered = [...this.tablesSnapshot(connection, schema) || []]
          .sort((a, b) => a.kind === b.kind ? 0 : a.kind === 'table' ? -1 : 1)
          .slice(0, this.#prewarmTableLimit)
          .map(item => item.name)
        this.#schedule(() => this.#prewarmStep(connection, schema, ordered, 0))
      })
      .catch(() => { this.#prewarmed.delete(key) })
  }
  #prewarmStep(connection: Connection, schema: string, ordered: string[], index: number): void {
    const end = Math.min(index + this.#prefetchConcurrency, ordered.length)
    for (let i = index; i < end; i++) {
      const current = this.#details.get(this.#detailKey(connection, schema, ordered[i]))
      if (current?.status === 'ready' || current?.status === 'loading' || this.#inBackoff(current)) continue
      this.#enqueue(() => this.loadTable(connection, schema, ordered[i], { batched: true }).then(() => {}).catch(() => {}), 'low')
    }
    if (end < ordered.length) this.#schedule(() => this.#prewarmStep(connection, schema, ordered, end))
  }
  readiness(connection: Connection, schema: string): {
    tables: 'unknown' | 'loading' | 'ready' | 'error'
    columnsReady: number
    columnsTotal: number
    prewarmComplete: boolean
  } {
    const state = this.#tables.get(this.#tablesKey(connection, schema))
    const listed = state?.value || []
    const prefix = this.#tablesKey(connection, schema) + '\0'
    let columnsReady = 0
    for (const [key, entry] of this.#details) {
      if (key.startsWith(prefix) && entry.status === 'ready') columnsReady += 1
    }
    const columnsTotal = Math.min(listed.length, this.#prewarmTableLimit)
    return {
      tables: state ? state.status : 'unknown',
      columnsReady,
      columnsTotal,
      prewarmComplete: state?.status === 'ready' && columnsReady >= columnsTotal,
    }
  }
  #enqueue(work: () => Promise<void>, priority: 'high' | 'low' = 'high'): void {
    const run = () => {
      this.#active += 1
      void work().finally(() => {
        this.#active -= 1
        const next = this.#highQueue.shift() || this.#lowQueue.shift()
        if (next) next()
      })
    }
    if (this.#active < this.#prefetchConcurrency) run()
    else if (priority === 'high') this.#highQueue.push(run)
    else this.#lowQueue.push(run)
  }
  #aborted(error: unknown, signal?: AbortSignal): boolean {
    return isAbortError(error, signal)
  }
  #throwIfAborted(signal?: AbortSignal): void {
    if (!signal?.aborted) return
    throw Object.assign(new Error('请求已取消。'), { name: 'AbortError' })
  }
  async #fetchCatalog(connection: Connection, input: Parameters<NonNullable<WorkspaceBridge['catalog']>>[1], signal?: AbortSignal): Promise<CatalogResult> {
    this.#throwIfAborted(signal)
    return this.#catalog(connection, input, signal)
  }
  async #waitPeer<T>(map: Map<string, LoadState<T>>, key: string, signal: AbortSignal | undefined, fallback: string): Promise<T | undefined> {
    const current = map.get(key)
    if (current?.status !== 'loading' || !current.promise) return undefined
    try { await current.promise } catch (error) {
      if (signal?.aborted) throw error
    }
    const ready = map.get(key)
    if (ready?.value) return ready.value
    if (this.#inBackoff(ready)) throw new Error(ready?.error || fallback)
    return undefined
  }
  async loadSchemas(connection: Connection, options: { refresh?: boolean; signal?: AbortSignal } = {}): Promise<Record<string, unknown>[]> {
    this.#prune(connection)
    const key = this.#generationKey(connection)
    let current = this.#schemas.get(key)
    if (!options.refresh && current?.status === 'ready' && current.value) return current.value
    if (!options.refresh && this.#inBackoff(current)) throw new Error(current?.error || '无法读取数据库列表')
    if (!options.refresh) {
      if (current?.status === 'loading' && current.promise) {
        const joined = await this.#waitPeer(this.#schemas, key, options.signal, '无法读取数据库列表')
        if (joined) return joined
        current = this.#schemas.get(key)
        if (current?.status === 'ready' && current.value) return current.value
        if (this.#inBackoff(current)) throw new Error(current?.error || '无法读取数据库列表')
      }
    }
    const epoch = (current?.epoch || 0) + 1
    const run = (async () => {
      const items: Record<string, unknown>[] = []
      let offset = 0
      for (;;) {
        const page = await this.#fetchCatalog(connection, { kind: 'schemas', offset, refresh: options.refresh && offset === 0 }, options.signal)
        items.push(...(page.items || []))
        if (!page.more) break
        offset += 100
        if (offset > 100000) break
      }
      const entry = this.#schemas.get(key)
      if (!entry || entry.epoch !== epoch) return
      this.#schemas.set(key, { status: 'ready', value: items, epoch })
      this.#emit()
    })().catch(error => {
      const entry = this.#schemas.get(key)
      if (!entry || entry.epoch !== epoch) return
      if (this.#aborted(error, options.signal)) {
        if (current?.value) this.#schemas.set(key, { status: 'ready', value: current.value, epoch: current.epoch })
        else this.#schemas.delete(key)
        this.#emit()
        throw error
      }
      this.#schemas.set(key, { status: 'error', error: error instanceof Error ? error.message : '无法读取数据库列表', epoch, failedAt: this.#now() })
      this.#emit()
      throw error
    })
    this.#schemas.set(key, { status: 'loading', value: current?.value, epoch, promise: run })
    this.#emit()
    await run
    return this.#schemas.get(key)?.value || []
  }
  async loadSchemaInfo(connection: Connection, schema: string, options: { refresh?: boolean; signal?: AbortSignal } = {}): Promise<CatalogResult> {
    this.#prune(connection)
    const key = this.#summaryKey(connection, schema)
    const current = this.#summaries.get(key)
    if (!options.refresh && current?.status === 'ready' && current.value) return current.value
    if (!options.refresh && this.#inBackoff(current)) throw new Error(current?.error || '无法读取数据库信息')
    if (!options.refresh) {
      if (current?.status === 'loading' && current.promise) {
        const joined = await this.#waitPeer(this.#summaries, key, options.signal, '无法读取数据库信息')
        if (joined) return joined
      }
    }
    const epoch = (current?.epoch || 0) + 1
    const run = (async () => {
      const info = await this.#fetchCatalog(connection, { kind: 'schema', schema, refresh: options.refresh }, options.signal)
      const entry = this.#summaries.get(key)
      if (!entry || entry.epoch !== epoch) return
      this.#summaries.set(key, { status: 'ready', value: info, epoch })
      this.#emit()
    })().catch(error => {
      const entry = this.#summaries.get(key)
      if (!entry || entry.epoch !== epoch) return
      if (this.#aborted(error, options.signal)) {
        if (current?.value) this.#summaries.set(key, { status: 'ready', value: current.value, epoch: current.epoch })
        else this.#summaries.delete(key)
        this.#emit()
        throw error
      }
      this.#summaries.set(key, { status: 'error', error: error instanceof Error ? error.message : '无法读取数据库信息', epoch, failedAt: this.#now() })
      this.#emit()
      throw error
    })
    this.#summaries.set(key, { status: 'loading', value: current?.value, epoch, promise: run })
    this.#emit()
    await run
    const ready = this.#summaries.get(key)
    if (ready?.value) return ready.value
    throw new Error(ready?.error || '无法读取数据库信息')
  }
  async loadTables(connection: Connection, schema: string, options: { refresh?: boolean; signal?: AbortSignal; batched?: boolean; quiet?: boolean } = {}): Promise<CachedTable[]> {
    this.#prune(connection)
    const notify = () => options.batched ? this.#emitSoon() : this.#emit()
    const quiet = !!options.quiet && !options.refresh
    const key = this.#tablesKey(connection, schema)
    let current = this.#tables.get(key)
    if (!options.refresh && current?.status === 'ready' && current.value) return current.value
    if (!options.refresh && this.#inBackoff(current)) throw new Error(current?.error || '无法读取对象')
    if (!options.refresh) {
      if (current?.status === 'loading' && current.promise) {
        const joined = await this.#waitPeer(this.#tables, key, options.signal, '无法读取对象')
        if (joined) return joined
        current = this.#tables.get(key)
        if (current?.status === 'ready' && current.value) return current.value
        if (this.#inBackoff(current)) throw new Error(current?.error || '无法读取对象')
      }
    }
    const epoch = (current?.epoch || 0) + 1
    const run = (async () => {
      const items: CachedTable[] = []
      let offset = 0
      for (;;) {
        const page = await this.#fetchCatalog(connection, { kind: 'tables', schema, offset, refresh: options.refresh && offset === 0 }, options.signal)
        for (const row of page.items || []) {
          const name = String(row.name || '')
          if (!name) continue
          items.push({ name, kind: isCatalogView(row.kind) ? 'view' : 'table', comment: String(row.comment || ''), record: row })
        }
        if (!page.more) break
        offset += 100
        if (offset > 100000) break
      }
      const entry = this.#tables.get(key)
      if (!entry || entry.epoch !== epoch) return
      this.#tables.set(key, { status: 'ready', value: items, epoch })
      notify()
    })().catch(error => {
      const entry = this.#tables.get(key)
      if (!entry || entry.epoch !== epoch) return
      if (this.#aborted(error, options.signal)) {
        if (current?.value) this.#tables.set(key, { status: 'ready', value: current.value, epoch: current.epoch })
        else this.#tables.delete(key)
        notify()
        throw error
      }
      this.#tables.set(key, { status: 'error', error: error instanceof Error ? error.message : '无法读取对象', epoch, failedAt: this.#now() })
      notify()
      throw error
    })
    this.#tables.set(key, { status: 'loading', value: current?.value, epoch, promise: run })
    if (!quiet) notify()
    await run
    return this.#tables.get(key)?.value || []
  }
  async loadTable(connection: Connection, schema: string, table: string, options: { refresh?: boolean; signal?: AbortSignal; batched?: boolean } = {}): Promise<CachedDetail> {
    this.#prune(connection)
    const notify = () => options.batched ? this.#emitSoon() : this.#emit()
    const key = this.#detailKey(connection, schema, table)
    const current = this.#details.get(key)
    if (!options.refresh && current?.status === 'ready' && current.value) return current.value
    if (!options.refresh && this.#inBackoff(current)) throw new Error(current?.error || '无法读取结构')
    if (!options.refresh) {
      if (current?.status === 'loading' && current.promise) {
        const joined = await this.#waitPeer(this.#details, key, options.signal, '无法读取结构')
        if (joined) return joined
      }
    }
    const epoch = (current?.epoch || 0) + 1
    const run = (async () => {
      const detail = await this.#fetchCatalog(connection, { kind: 'table', schema, table, refresh: options.refresh }, options.signal)
      const primaryKeys = Array.isArray(detail.primaryKeys) ? detail.primaryKeys.map(String) : resolvePrimaryKeys(connection.dialect, {
        columns: detail.columns,
        indexes: detail.indexes as { values?: Record<string, unknown>[] },
        constraints: detail.constraints as { values?: Record<string, unknown>[] },
      })
      const entry = this.#details.get(key)
      if (!entry || entry.epoch !== epoch) return
      this.#details.set(key, { status: 'ready', value: { ...detail, primaryKeys }, epoch })
      notify()
    })().catch(error => {
      const entry = this.#details.get(key)
      if (!entry || entry.epoch !== epoch) return
      if (this.#aborted(error, options.signal)) {
        if (current?.value) this.#details.set(key, { status: 'ready', value: current.value, epoch: current.epoch })
        else this.#details.delete(key)
        notify()
        throw error
      }
      this.#details.set(key, { status: 'error', error: error instanceof Error ? error.message : '无法读取结构', epoch, failedAt: this.#now() })
      notify()
      throw error
    })
    this.#details.set(key, { status: 'loading', value: current?.value, epoch, promise: run })
    notify()
    await run
    const ready = this.#details.get(key)
    if (ready?.value) return ready.value
    throw new Error(ready?.error || '无法读取结构')
  }
  async loadIndexes(connection: Connection, schema: string, table: string, options: { refresh?: boolean; signal?: AbortSignal } = {}): Promise<CachedDetail> {
    const key = this.#detailKey(connection, schema, table)
    const current = this.#details.get(key)
    const existing = current?.value
    if (!options.refresh && existing && (existing.indexes as { status?: string } | undefined)?.status === 'actual') return existing
    const epoch = (current?.epoch || 0) + 1
    this.#details.set(key, { status: existing ? 'ready' : 'loading', value: existing, epoch })
    this.#emit()
    try {
      const page = await this.#fetchCatalog(connection, { kind: 'indexes', schema, table, refresh: options.refresh }, options.signal)
      const currentAfter = this.#details.get(key)
      if (currentAfter && currentAfter.epoch > epoch) {
        if (currentAfter.value) return currentAfter.value
        throw new Error('无法读取索引')
      }
      const merged: CachedDetail = {
        ...(existing || { columns: [], collectedAt: page.collectedAt, source: page.source, primaryKeys: [] }),
        indexes: page.indexes,
        collectedAt: page.collectedAt || existing?.collectedAt || '',
        source: page.source || existing?.source || '',
        primaryKeys: existing?.primaryKeys || resolvePrimaryKeys(connection.dialect, { columns: existing?.columns, indexes: page.indexes as { values?: Record<string, unknown>[] } }),
      }
      this.#details.set(key, { status: 'ready', value: merged, epoch })
      this.#emit()
      return merged
    } catch (error) {
      const currentAfter = this.#details.get(key)
      if (currentAfter && currentAfter.epoch > epoch) throw error
      if (this.#aborted(error, options.signal)) {
        if (existing) this.#details.set(key, { status: 'ready', value: existing, epoch: current?.epoch || epoch })
        this.#emit()
        throw error
      }
      this.#details.set(key, { status: existing ? 'ready' : 'error', value: existing, error: error instanceof Error ? error.message : '无法读取索引', epoch, failedAt: this.#now() })
      this.#emit()
      throw error
    }
  }
  invalidateConnection(connection: Connection): void {
    const prefix = `${connection.id}\0`
    for (const map of [this.#schemas, this.#summaries, this.#tables, this.#details] as const) {
      for (const key of [...map.keys()]) if (key.startsWith(prefix) || key === connection.id) map.delete(key)
    }
    for (const key of [...this.#prewarmed]) if (key.startsWith(prefix) || key === connection.id) this.#prewarmed.delete(key)
    this.#emit()
  }
  invalidateSchema(connection: Connection, schema: string): void {
    const prefix = this.#tablesKey(connection, schema)
    this.#tables.delete(prefix)
    this.#summaries.delete(this.#summaryKey(connection, schema))
    this.#prewarmed.delete(prefix)
    for (const key of [...this.#details.keys()]) if (key.startsWith(prefix + '\0')) this.#details.delete(key)
    this.#emit()
  }
  invalidateTable(connection: Connection, schema: string, table: string): void {
    this.#details.delete(this.#detailKey(connection, schema, table))
    this.#emit()
  }
}

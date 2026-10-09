import { cancelledError, createReadonlyQueryPool, isFatalSessionError } from './query-pool.mjs'
import { getDataSource } from './data-sources/sql-registry.mjs'

export const SESSION_QUOTA = Object.freeze({
  catalog: 1,
  query: 3,
  maintenance: 1,
  profile: 5,
})

export { cancelledError, isFatalSessionError }

/** Compatibility export for existing callers; running sessions use their own Provider. */
export function isFatalCatalogSessionError(error, dialect = 'mysql') {
  return getDataSource(dialect).recovery.isFatalCatalog(error)
}

export function createQueryPool(options = {}) {
  return createReadonlyQueryPool({ size: SESSION_QUOTA.query, ...options })
}

export function startIdleCatalogProbe(sessions, exclusive, busy, interval = 30_000) {
  let probing = false, stopped = false
  const timer = setInterval(() => {
    if (stopped || probing || busy() || sessions.health !== 'ready') return
    probing = true
    void exclusive(async () => {
      if (!stopped && !busy()) await sessions.probeCatalog()
    }).catch(() => { if (!stopped) sessions.markDegraded() }).finally(() => { probing = false })
  }, interval)
  timer.unref()
  return () => { stopped = true; clearInterval(timer) }
}

export function createSessionManager({
  dialect,
  recovery,
  createCatalog,
  createMaintenance,
  destroy,
  cancel,
  probe,
  createQueryPool: createPool,
  onHealth,
  watchConnection,
} = {}) {
  const source = getDataSource(dialect)
  const recoveryPolicy = recovery || source.recovery
  const fatal = error => recoveryPolicy.isFatalCatalog(error)
  let catalog
  let catalogId = 0
  let health = 'connecting'
  const setHealth = next => { if (health !== next) { health = next; onHealth?.(next) } }
  let detachCatalog
  let closed = false
  let version = ''
  let database = ''
  let identity
  let queryPool = typeof createPool === 'function' ? createPool() : undefined
  let maintenance
  let maintenanceLive = 0
  const created = { catalog: 0, query: 0, maintenance: 0 }

  function assertOpen() {
    if (closed) throw new Error('连接已关闭。')
  }

  async function destroyOne(conn) {
    if (!conn) return
    try { await destroy(conn) } catch { /* ignore */ }
  }

  async function destroyCatalog() {
    const conn = catalog
    catalog = undefined
    detachCatalog?.(); detachCatalog = undefined
    await destroyOne(conn)
  }

  function adoptCatalog(conn, probed) {
    catalog = conn
    detachCatalog = watchConnection?.(conn, () => {
      if (catalog !== conn || closed) return
      catalog = undefined
      detachCatalog?.(); detachCatalog = undefined
      setHealth('degraded')
      void destroyOne(conn)
    })
    catalogId += 1
    version = String(probed?.version || version || '').slice(0, 120)
    database = String(probed?.database || database || '').slice(0, 128)
    identity = probed?.identity
    setHealth('ready')
    return catalog
  }

  async function ensureCatalog() {
    assertOpen()
    if (catalog) return catalog
    const conn = await createCatalog()
    created.catalog += 1
    try {
      return adoptCatalog(conn, await probe(conn))
    } catch (error) {
      await destroyOne(conn)
      throw error
    }
  }

  async function recoverCatalog() {
    assertOpen()
    if (catalog) {
      try {
        const probed = await probe(catalog)
        version = String(probed?.version || version || '').slice(0, 120)
        database = String(probed?.database || database || '').slice(0, 128)
        identity = probed?.identity
        setHealth('ready')
        return catalog
      } catch {
        await destroyCatalog()
      }
    }
    try {
      return await ensureCatalog()
    } catch (error) {
      if (health !== 'offline') setHealth('degraded')
      throw error
    }
  }

  function attachAbort(signal) {
    if (!signal) return () => {}
    const onAbort = () => {
      try {
        if (typeof cancel === 'function') cancel(catalog)
        else source.driver.cancel(catalog)
      } catch { /* best-effort interrupt */ }
    }
    if (signal.aborted) onAbort()
    else signal.addEventListener('abort', onAbort, { once: true })
    return () => signal.removeEventListener('abort', onAbort)
  }

  return {
    get health() { return health },
    get version() { return version },
    get database() { return database },
    get identity() { return identity },
    catalogConnection() { return catalog },
    stats() {
      const query = queryPool?.stats?.() || { live: 0 }
      return {
        catalog: catalog ? 1 : 0,
        query: query.live || 0,
        maintenance: maintenanceLive,
        total: (catalog ? 1 : 0) + (query.live || 0) + maintenanceLive,
        created: { ...created },
        health,
        catalogId,
        quota: SESSION_QUOTA,
      }
    },
    queryPool() { return queryPool },
    async ensureCatalog() {
      return ensureCatalog()
    },
    async recoverCatalog() {
      return recoverCatalog()
    },
    async probeCatalog() {
      return this.withCatalog(conn => probe(conn), undefined, { retryFatal: false })
    },
    async withCatalog(work, signal, { retryFatal = true } = {}) {
      assertOpen()
      if (signal?.aborted) throw cancelledError()
      await ensureCatalog()
      const detach = attachAbort(signal)
      try {
        return await work(catalog)
      } catch (error) {
        const aborted = !!(signal?.aborted || error?.cancelled)
        if (aborted) {
          if (recoveryPolicy.discardOnCancel) await destroyCatalog()
          throw cancelledError()
        }
        if (recoveryPolicy.discardOnTimeout(error)) {
          await destroyCatalog()
          throw error
        }
        if (!fatal(error)) throw error
        await destroyCatalog()
        if (!retryFatal) {
          setHealth('degraded')
          throw error
        }
        try {
          await ensureCatalog()
          return await work(catalog)
        } catch (retryError) {
          if (signal?.aborted || retryError?.cancelled) {
            if (recoveryPolicy.discardOnCancel) await destroyCatalog()
            throw cancelledError()
          }
          if (fatal(retryError) || recoveryPolicy.discardOnTimeout(retryError)) {
            await destroyCatalog()
            setHealth('degraded')
          }
          throw retryError
        }
      } finally {
        detach()
      }
    },
    async acquireMaintenance() {
      assertOpen()
      if (maintenanceLive >= SESSION_QUOTA.maintenance) throw new Error('维护会话忙，请稍后再试。')
      const conn = await createMaintenance()
      created.maintenance += 1
      maintenance = conn
      maintenanceLive = 1
      return conn
    },
    async releaseMaintenance(destroySession = true) {
      const conn = maintenance
      maintenance = undefined
      maintenanceLive = 0
      if (destroySession) await destroyOne(conn)
    },
    async reconnect() {
      assertOpen()
      setHealth('connecting')
      await destroyCatalog()
      if (queryPool) await queryPool.close()
      await this.releaseMaintenance(true)
      queryPool = typeof createPool === 'function' ? createPool() : undefined
      try {
        await ensureCatalog()
        setHealth('ready')
        return { version, database, identity }
      } catch (error) {
        setHealth('offline')
        throw error
      }
    },
    markDegraded() {
      if (health !== 'offline') setHealth('degraded')
      return health
    },
    async close() {
      closed = true
      setHealth('offline')
      await destroyCatalog()
      if (queryPool) await queryPool.close()
      await this.releaseMaintenance(true)
    },
  }
}

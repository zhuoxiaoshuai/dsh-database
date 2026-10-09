export function cancelledError(message = '读取已取消。') {
  return Object.assign(new Error(message), { cancelled: true })
}

export function isFatalSessionError(error, flags = {}) {
  if (flags.aborted || flags.truncated || flags.cancelled || error?.cancelled) return true
  const text = `${error?.code || ''} ${error?.message || error || ''}`
  return /PROTOCOL|ECONNRESET|EPIPE|ECONNREFUSED|not connected|closed|Connection lost|NJS-|DPI-|实例或账号/i.test(text)
}

export function shouldRetryReadonlySelect(error, flags = {}) {
  if (flags.aborted || flags.cancelled || error?.cancelled) return false
  const text = `${error?.code || ''} ${error?.message || error || ''}`
  if (/timeout|timed out|ETIMEDOUT|PROTOCOL_SEQUENCE_TIMEOUT/i.test(text)) return false
  return isFatalSessionError(error, {})
}

export function createReadonlyQueryPool({
  size = 3,
  create,
  prepare,
  reset,
  destroy,
  watchConnection,
  isFatal = (error, flags) => isFatalSessionError(error, flags),
} = {}) {
  const idle = []
  const waiters = []
  let live = 0
  let creating = 0
  let closed = false
  const tracked = new Map()

  const failWaiters = error => {
    while (waiters.length) waiters.shift().reject(error)
  }

  async function retire(conn) {
    const state = tracked.get(conn)
    if (!state) return
    tracked.delete(conn)
    state.detach?.()
    live = Math.max(0, live - 1)
    try { await destroy(conn) } catch { /* ignore */ }
    while (!closed && waiters.length && live + creating < size) {
      const waiter = waiters.shift()
      void take().then(waiter.resolve, waiter.reject)
    }
  }

  function give(conn) {
    if (closed || tracked.get(conn)?.lost) return void retire(conn)
    if (waiters.length) waiters.shift().resolve(conn)
    else idle.push(conn)
  }

  async function take(signal) {
    if (closed) throw new Error('连接池已关闭。')
    if (signal?.aborted) throw cancelledError()
    if (idle.length) return idle.pop()
    if (live + creating < size) {
      creating += 1
      try {
        const conn = await create()
        if (closed || signal?.aborted) {
          await destroy(conn).catch(() => {})
          throw closed ? new Error('连接池已关闭。') : cancelledError()
        }
        live += 1
        const state = { lost: false, detach: undefined }
        tracked.set(conn, state)
        state.detach = watchConnection?.(conn, () => {
          state.lost = true
          const index = idle.indexOf(conn)
          if (index >= 0) { idle.splice(index, 1); void retire(conn) }
        })
        return conn
      } finally {
        creating -= 1
      }
    }
    return await new Promise((resolve, reject) => {
      const onAbort = () => {
        const index = waiters.indexOf(waiter)
        if (index >= 0) waiters.splice(index, 1)
        reject(cancelledError())
      }
      const waiter = {
        resolve: value => {
          signal?.removeEventListener('abort', onAbort)
          if (signal?.aborted) { give(value); reject(cancelledError()); return }
          resolve(value)
        },
        reject: error => {
          signal?.removeEventListener('abort', onAbort)
          reject(error)
        },
      }
      if (signal) {
        if (signal.aborted) return reject(cancelledError())
        signal.addEventListener('abort', onAbort, { once: true })
      }
      waiters.push(waiter)
    })
  }

  return {
    stats() {
      return { live, idle: idle.length, creating, waiting: waiters.length, closed }
    },
    async acquire(schema, signal) {
      let last
      for (let attempt = 0; attempt < 2; attempt++) {
        const conn = await take(signal)
        try {
          if (signal?.aborted) throw cancelledError()
          if (tracked.get(conn)?.lost) throw new Error('Connection lost before query preparation')
          await prepare(conn, schema)
          if (tracked.get(conn)?.lost) throw new Error('Connection lost during query preparation')
          let done = false
          const finish = async work => {
            if (done) return
            done = true
            await work()
          }
          return {
            connection: conn,
            async release() {
              await finish(async () => {
                try {
                  await reset(conn)
                  give(conn)
                } catch {
                  await retire(conn)
                }
              })
            },
            async discard() {
              await finish(() => retire(conn))
            },
          }
        } catch (error) {
          await retire(conn)
          last = error
          if (signal?.aborted || error?.cancelled || closed) throw error
        }
      }
      throw last
    },
    async close() {
      closed = true
      failWaiters(new Error('连接池已关闭。'))
      const leftover = idle.splice(0)
      await Promise.allSettled(leftover.map(conn => retire(conn)))
    },
  }
}

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
  operationTimeoutMs = 10_000,
  connectTimeoutMs = 15_000,
  create,
  prepare,
  reset,
  destroy,
  watchConnection,
  onStall,
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
  const stalled = error => { closed = true; failWaiters(error); onStall?.(error) }

  function deadline(work, ms, signal) {
    return new Promise((resolve, reject) => {
      let settled = false
      const finish = (error, value) => {
        if (settled) return
        settled = true; clearTimeout(timer); signal?.removeEventListener('abort', abort)
        error ? reject(error) : resolve(value)
      }
      const abort = () => finish(cancelledError())
      const timer = setTimeout(() => finish(Object.assign(new Error('连接会话操作超时。'), { code: 'ETIMEDOUT' })), ms)
      signal?.addEventListener('abort', abort, { once: true })
      Promise.resolve(work).then(value => finish(undefined, value), error => finish(error))
      if (signal?.aborted) abort()
    })
  }

  function pump() {
    while (!closed && waiters.length && (idle.length || live + creating < size)) {
      const waiter = waiters.shift()
      void take(waiter.signal).then(waiter.resolve, waiter.reject)
    }
  }

  async function retire(conn) {
    const state = tracked.get(conn)
    if (!state) return
    tracked.delete(conn)
    state.detach?.()
    const closing = Promise.resolve().then(() => destroy(conn))
    const release = () => { live = Math.max(0, live - 1); pump() }
    try { await deadline(closing, operationTimeoutMs) }
    catch (error) { if (error?.code === 'ETIMEDOUT') stalled(error) }
    finally { void closing.then(release, release) }
  }

  function give(conn) {
    if (closed || tracked.get(conn)?.lost) return void retire(conn)
    idle.push(conn)
    pump()
  }

  async function take(signal) {
    if (closed) throw new Error('连接池已关闭。')
    if (signal?.aborted) throw cancelledError()
    if (idle.length) return idle.pop()
    if (live + creating < size) {
      creating += 1
      let opening
      try { opening = Promise.resolve(create()) }
      catch (error) { creating--; pump(); throw error }
      // An abandoned native create owns its reservation until its connection is destroyed.
      let pending = true
      const releaseOpening = () => { if (pending) { pending = false; creating--; pump() } }
      try {
        const conn = await deadline(opening, connectTimeoutMs, signal)
        if (closed || signal?.aborted) {
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
        releaseOpening()
        return conn
      } catch (error) {
        if (error?.code === 'ETIMEDOUT') stalled(error)
        void opening.then(async conn => {
          const closing = Promise.resolve().then(() => destroy(conn))
          try { await deadline(closing, operationTimeoutMs) }
          catch (error) { if (error?.code === 'ETIMEDOUT') stalled(error) }
          finally { void closing.then(releaseOpening, releaseOpening) }
        }, releaseOpening)
        throw error
      }
    }
    return await new Promise((resolve, reject) => {
      const onAbort = () => {
        const index = waiters.indexOf(waiter)
        if (index >= 0) waiters.splice(index, 1)
        reject(cancelledError())
      }
      const waiter = {
        signal,
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
          await deadline(prepare(conn, schema), operationTimeoutMs, signal)
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
                  await deadline(reset(conn), operationTimeoutMs)
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

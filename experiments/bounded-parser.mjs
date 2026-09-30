import { Worker } from 'node:worker_threads'

/** M0 isolation probe. A parser result is never an execution authorization. */
export async function inspectBounded(dialect, sql, options = {}) {
  if (!['mysql', 'oracle'].includes(dialect) || typeof sql !== 'string' || !sql.trim() || Buffer.byteLength(sql, 'utf8') > 16384) throw new Error('INVALID_PARSE_INPUT')
  const timeoutMs = Math.min(5000, Math.max(1, options.timeoutMs ?? 5000))
  if (options.signal?.aborted) throw new Error('PARSE_CANCELLED')
  const worker = new Worker(new URL('./parser-worker.mjs', import.meta.url), { workerData: { dialect, sql }, resourceLimits: { maxOldGenerationSizeMb: 128, maxYoungGenerationSizeMb: 32, stackSizeMb: 4 } })
  let timer, stop
  try {
    return await new Promise((resolve, reject) => {
      timer = setTimeout(() => reject(new Error('PARSE_TIMEOUT')), timeoutMs)
      stop = () => reject(new Error('PARSE_CANCELLED'))
      options.signal?.addEventListener('abort', stop, { once: true })
      worker.once('message', message => message.ok ? resolve(message.result) : reject(new Error('PARSE_FAILED')))
      worker.once('error', () => reject(new Error('PARSE_WORKER_FAILED')))
      worker.once('exit', () => reject(new Error('PARSE_WORKER_EXITED')))
    })
  } finally {
    clearTimeout(timer); options.signal?.removeEventListener('abort', stop)
    await worker.terminate()
  }
}

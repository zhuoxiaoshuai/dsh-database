/** One deadline for metadata, coordination and reading. A late promise cannot resume the operation. */
export function createKafkaOperationScope(signal, deadlineMs) {
  const started = Date.now()
  let finish
  let reason = ''
  const done = new Promise(resolve => { finish = resolve })
  const settle = value => { if (!reason) { reason = value; finish(value) } }
  const onAbort = () => settle('cancelled')
  signal?.addEventListener('abort', onAbort, { once: true })
  const timer = setTimeout(() => settle('deadline'), Math.max(0, deadlineMs))
  if (signal?.aborted) settle('cancelled')
  return {
    get reason() { return reason },
    get done() { return done },
    get elapsedMs() { return Date.now() - started },
    settle,
    async race(work) {
      const outcome = await Promise.race([Promise.resolve(work).then(value => ({ value })), done.then(value => ({ reason: value }))])
      return outcome.reason ? undefined : outcome.value
    },
    dispose() { clearTimeout(timer); signal?.removeEventListener('abort', onAbort) },
  }
}

/** Admin calls cannot be interrupted in KafkaJS. Discard late replies and never start a following call. */
export async function withKafkaReadScope(signal, work, deadlineMs = 30000) {
  const scope = createKafkaOperationScope(signal, deadlineMs)
  const check = () => {
    if (!scope.reason) return
    const error = new Error(scope.reason === 'cancelled' ? 'Kafka 读取已取消。' : 'Kafka 读取超过截止时间。')
    error.name = scope.reason === 'cancelled' ? 'KafkaReadCancelled' : 'KafkaReadDeadline'
    throw error
  }
  const read = async action => {
    check()
    const result = await scope.race(action())
    check()
    return result
  }
  try { check(); return await work(read) } finally { scope.dispose() }
}

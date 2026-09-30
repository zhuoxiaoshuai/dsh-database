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

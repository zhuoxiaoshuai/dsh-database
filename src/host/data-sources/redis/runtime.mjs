export const redisRuntime = Object.freeze({
  id: 'redis', workerEntry: 'redis-worker.mjs', requiresPassword: false, usesCustomCa: input => !!input.tls,
  actions: Object.freeze(['redis-command', 'redis-scan', 'redis-key-suggest', 'redis-key']), documentKind: 'command', textExecution: true,
})

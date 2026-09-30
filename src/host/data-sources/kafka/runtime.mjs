export const kafkaRuntime = Object.freeze({
  id: 'kafka', workerEntry: 'kafka-worker.mjs', requiresPassword: false, usesCustomCa: input => !!input.tls,
  actions: Object.freeze(['kafka-topics', 'kafka-describe', 'kafka-peek', 'kafka-groups', 'kafka-group']), documentKind: 'command', textExecution: true,
})

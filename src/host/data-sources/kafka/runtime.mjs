export const kafkaRuntime = Object.freeze({
  id: 'kafka', workerEntry: 'kafka-worker.mjs', requiresPassword: false, usesCustomCa: input => !!input.tls,
  actions: Object.freeze(['kafka-topics', 'kafka-describe', 'kafka-peek', 'kafka-groups', 'kafka-group', 'kafka-produce',
    'kafka-topic-config', 'kafka-time-offsets', 'kafka-scan', 'kafka-produce-batch', 'kafka-tombstone', 'kafka-create-topic', 'kafka-set-group-offsets']), documentKind: 'command', textExecution: true,
})

import type { KafkaClientDescriptor } from './types.ts'

export const kafkaSource: KafkaClientDescriptor = Object.freeze({
  id: 'kafka', family: 'kafka', displayName: 'Kafka', badge: 'KAFKA',
  capabilities: { topics: true, describe: true, peek: true } as const, showsSchemaTree: false,
})

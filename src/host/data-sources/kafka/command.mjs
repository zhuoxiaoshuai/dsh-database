export * from '../../../shared/kafka-command.mjs'
import { kafkaBytes as commandBytes } from '../../../shared/kafka-command.mjs'

/** Driver boundary: the shared codec returns bytes; KafkaJS receives Node Buffers. */
export function kafkaBytes(value, label, options) {
  const bytes = commandBytes(value, label, options)
  return bytes === null ? null : Buffer.from(bytes)
}

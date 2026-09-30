const MAX_VALUE_PREVIEW = 16 * 1024
export const MAX_KAFKA_RESULT_BYTES = 1024 * 1024

export function encodeKafkaBytes(value) {
  if (value === null || value === undefined) return { kind: 'null', length: 0 }
  const bytes = Buffer.from(value)
  const preview = bytes.subarray(0, MAX_VALUE_PREVIEW)
  const decoded = preview.toString('utf8')
  const lossless = Buffer.from(decoded, 'utf8').equals(preview)
  return { kind: lossless ? 'text' : 'binary', length: bytes.length, truncated: bytes.length > preview.length,
    ...(lossless ? { text: decoded } : { base64: preview.toString('base64') }) }
}

export function encodeKafkaMessage(message) {
  const headers = Object.fromEntries(Object.entries(message.headers || {}).map(([name, value]) =>
    [name, Array.isArray(value) ? value.map(encodeKafkaBytes) : encodeKafkaBytes(value)]))
  return { offset: String(message.offset), timestamp: String(message.timestamp ?? ''), key: encodeKafkaBytes(message.key), value: encodeKafkaBytes(message.value), headers }
}

export function appendKafkaMessage(result, message) {
  const encoded = encodeKafkaMessage(message)
  const nextBytes = Buffer.byteLength(JSON.stringify(encoded))
  if (result.bytes + nextBytes > MAX_KAFKA_RESULT_BYTES - 8192) return false
  result.messages.push(encoded)
  result.bytes += nextBytes
  return true
}

export function kafkaHistorySummary(operation, result) {
  return { operation: operation.kind.toUpperCase(), target: operation.kind === 'topics' ? 'Topic 列表' : `${operation.topic}${operation.kind === 'peek' ? ` / 分区 ${operation.partition}` : ''}`,
    count: Array.isArray(result?.messages) ? result.messages.length : undefined, status: result?.complete === false ? 'partial' : 'completed' }
}

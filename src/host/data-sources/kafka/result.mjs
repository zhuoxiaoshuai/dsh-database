const MAX_VALUE_PREVIEW = 64 * 1024
export const MAX_KAFKA_RESULT_BYTES = 1024 * 1024
// Leave room for Host execution metadata and the response envelope.
const PAYLOAD_BYTES = MAX_KAFKA_RESULT_BYTES - 16384

export function encodeKafkaBytes(value) {
  if (value === null || value === undefined) return { kind: 'null', length: 0 }
  const bytes = Buffer.from(value)
  const preview = bytes.subarray(0, MAX_VALUE_PREVIEW)
  const decoded = preview.toString('utf8')
  const lossless = Buffer.from(decoded, 'utf8').equals(preview) && !/[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/u.test(decoded)
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
  if (result.bytes + nextBytes > PAYLOAD_BYTES - 8192) return false
  result.messages.push(encoded)
  result.bytes += nextBytes
  return true
}

export function kafkaResultBytes(result) { return Buffer.byteLength(JSON.stringify(result), 'utf8') }

/** List pagination is limited by count and encoded bytes; its cursor remains the next unread index. */
export function kafkaNamePage(items, cursor, field, metadata = {}) {
  const raw = cursor === undefined || cursor === '' ? '0' : String(cursor)
  if (!/^(0|[1-9]\d*)$/.test(raw) || !Number.isSafeInteger(Number(raw)) || Number(raw) > 1000000) throw new Error('页游标无效。')
  const start = Number(raw)
  const names = []
  let bytes = kafkaResultBytes(metadata) + 1024
  for (const name of items.slice(start, start + 100)) {
    const nextBytes = Buffer.byteLength(JSON.stringify(name), 'utf8') + 1
    if (bytes + nextBytes > PAYLOAD_BYTES) break
    names.push(name); bytes += nextBytes
  }
  if (!names.length && start < items.length) throw new Error('Kafka 名称超出结果大小限制。')
  const next = start + names.length
  return { ...metadata, [field]: names, truncated: next < items.length,
    ...(next < items.length ? { nextCursor: String(next) } : {}), elapsedMs: 0 }
}

/** Metadata is not infinitely pageable. Reduce only source-owned collections, with an explicit warning. */
export function limitKafkaResult(input) {
  if (kafkaResultBytes(input) <= PAYLOAD_BYTES) return input
  const result = structuredClone(input)
  result.truncated = true
  result.resultTruncated = true
  while (kafkaResultBytes(result) > PAYLOAD_BYTES) {
    const candidates = []
    for (const key of ['messages', 'members', 'partitions']) {
      if (Array.isArray(result[key]) && result[key].length) candidates.push({ size: kafkaResultBytes(result[key]), trim: () => { result[key] = result[key].slice(0, Math.floor(result[key].length / 2)) } })
    }
    if (!candidates.length) throw new Error('Kafka 详情超出结果大小限制。')
    candidates.sort((a, b) => b.size - a.size)[0].trim()
  }
  if (result.kind === 'peek') { result.complete = false; result.reason = 'bytes' }
  return result
}

export function kafkaFailureHealth(error) {
  if (error?.recycleWorker) return 'closed'
  const name = String(error?.name || '')
  const code = String(error?.code || '')
  // Topic / Group ACL and invalid input are operation errors, not broken connections.
  return /Connection|RequestTimeout|Authentication|SASLAuthentication/.test(name) || ['ECONNREFUSED', 'ECONNRESET', 'ETIMEDOUT', 'ENOTFOUND'].includes(code)
    || (error?.cause && error.cause !== error && /Connection|RequestTimeout/.test(String(error.cause.name || ''))) ? 'degraded' : undefined
}

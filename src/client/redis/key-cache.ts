import { encodeRedisKey } from './completion.ts'

const MAX_KEYS = 5000
const MAX_BYTES = 1024 * 1024

/** The cache is only an input hint. SCAN may be incomplete and keys may expire. */
export function mergeCachedKeys(previous: readonly string[], incoming: readonly string[]): string[] {
  const keys = [...previous]
  const seen = new Set(keys)
  let bytes = keys.reduce((size, key) => size + new TextEncoder().encode(key).length, 0)
  for (const key of incoming) {
    if (seen.has(key) || encodeRedisKey(key) === null) continue
    const size = new TextEncoder().encode(key).length
    if (keys.length >= MAX_KEYS) break
    if (bytes + size > MAX_BYTES) continue
    keys.push(key); seen.add(key); bytes += size
  }
  return keys
}

export function removeCachedKey(previous: readonly string[], name: string): string[] {
  return previous.filter(key => key !== name)
}

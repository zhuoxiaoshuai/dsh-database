const DECIMAL = /^(0|[1-9]\d*)$/

export const PEEK_GROUP_PREFIX = 'dsh-peek-'

export function visibleGroupIds(ids) {
  const names = []
  const seen = new Set()
  for (const id of ids || []) {
    if (typeof id !== 'string' || !id || id.startsWith(PEEK_GROUP_PREFIX) || seen.has(id)) continue
    seen.add(id)
    names.push(id)
  }
  names.sort()
  return names
}

export function pageByCursor(items, cursor, size = 100) {
  const start = cursor === undefined || cursor === '' || cursor === '0' ? 0 : Number(cursor)
  if (!Number.isSafeInteger(start) || start < 0 || start > 1000000) throw new Error('页游标无效。')
  const page = items.slice(start, start + size)
  const next = start + page.length
  return { page, truncated: next < items.length, ...(next < items.length ? { nextCursor: String(next) } : {}) }
}

/** Decimal text for offsets. Rejects values that cannot survive as int64. */
export function decimalText(value) {
  if (typeof value === 'bigint') return value < 0n ? null : value.toString()
  if (typeof value === 'number') return Number.isSafeInteger(value) && value >= 0 ? String(value) : null
  if (typeof value === 'string' && DECIMAL.test(value)) return value
  return null
}

/** Kafka uses -1 for "no committed offset". 0 is a real offset. */
export function committedOffset(value) {
  if (value === -1 || value === '-1' || value === -1n) return null
  return decimalText(value)
}

export function lagBetween(end, current) {
  const hi = decimalText(end)
  const lo = decimalText(current)
  if (hi == null || lo == null) return null
  const diff = BigInt(hi) - BigInt(lo)
  return (diff < 0n ? 0n : diff).toString()
}

export function unionTopicNames(assigned, committed) {
  return [...new Set([...(assigned || []), ...(committed || [])].filter(name => typeof name === 'string' && name))].sort()
}

function partitionId(value) {
  if (typeof value === 'number') return Number.isSafeInteger(value) && value >= 0 && value <= 2147483647 ? value : null
  if (typeof value === 'string' && DECIMAL.test(value)) {
    const id = Number(value)
    return Number.isSafeInteger(id) && id <= 2147483647 ? id : null
  }
  return null
}

/**
 * @param {{ committed?: { partition: unknown, offset: unknown }[], assignment?: { partition: unknown, consumer?: string }[], ends?: { partition: unknown, high: unknown }[] | null }} input
 * ends === null means the end-offset read failed: End and Lag stay unknown.
 */
export function groupTopicRows({ committed = [], assignment = [], ends = null }) {
  const current = new Map()
  const consumer = new Map()
  const end = new Map()
  const ids = new Set()
  for (const item of committed) {
    const id = partitionId(item.partition)
    if (id === null) continue
    ids.add(id)
    current.set(id, committedOffset(item.offset))
  }
  for (const item of assignment) {
    const id = partitionId(item.partition)
    if (id === null) continue
    ids.add(id)
    if (!consumer.has(id) && item.consumer) consumer.set(id, item.consumer)
  }
  const endsOk = ends != null
  if (endsOk) {
    for (const item of ends) {
      const id = partitionId(item.partition)
      if (id === null) continue
      ids.add(id)
      end.set(id, decimalText(item.high))
    }
  }
  return [...ids].sort((left, right) => left - right).map(id => {
    const currentOffset = current.has(id) ? current.get(id) : null
    const endOffset = endsOk ? (end.has(id) ? end.get(id) : null) : null
    return {
      partition: id,
      current: currentOffset,
      end: endOffset,
      lag: endsOk ? lagBetween(endOffset, currentOffset) : null,
      consumer: consumer.get(id) || null,
    }
  })
}

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
  return diff < 0n ? null : diff.toString()
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
export function groupTopicRows({ committed = [], assignment = [], ends = null, committedKnown = true }) {
  const current = new Map()
  const consumer = new Map()
  const end = new Map()
  const ids = new Set()
  const unreadable = new Set()
  for (const item of committed) {
    const id = partitionId(item.partition)
    if (id === null) continue
    ids.add(id)
    current.set(id, committedOffset(item.offset))
    if (item.unreadable || (committedOffset(item.offset) === null && ![-1, '-1', -1n].includes(item.offset))) unreadable.add(id)
  }
  for (const item of assignment) {
    const id = partitionId(item.partition)
    if (id === null) continue
    ids.add(id)
    if (!consumer.has(id)) consumer.set(id, item)
  }
  const endsOk = ends != null
  if (endsOk) {
    for (const item of ends) {
      const id = partitionId(item.partition)
      if (id === null) continue
      ids.add(id)
      end.set(id, { high: decimalText(item.high), low: decimalText(item.low) })
    }
  }
  return [...ids].sort((left, right) => left - right).map(id => {
    const currentOffset = current.has(id) ? current.get(id) : null
    const endOffset = endsOk ? (end.get(id)?.high ?? null) : null
    const earliest = endsOk ? (end.get(id)?.low ?? null) : null
    const status = !committedKnown || endOffset == null || unreadable.has(id) ? 'unreadable' : currentOffset == null ? 'uncommitted'
      : BigInt(currentOffset) > BigInt(endOffset) ? 'beyond-end'
      : earliest != null && BigInt(currentOffset) < BigInt(earliest) ? 'before-earliest' : 'normal'
    const owner = consumer.get(id)
    return {
      partition: id,
      current: currentOffset,
      end: endOffset,
      earliest,
      status,
      lag: status === 'normal' ? lagBetween(endOffset, currentOffset) : null,
      consumer: owner?.consumer || null,
      consumerId: owner?.consumerId || null,
      clientId: owner?.clientId || null,
      host: owner?.host || null,
    }
  })
}

export function summarizePartitions(partitions, complete = true) {
  const known = partitions.filter(row => row.lag != null)
  const knownLag = known.reduce((sum, row) => sum + BigInt(row.lag), 0n).toString()
  return { totalLag: complete && known.length === partitions.length ? knownLag : null, knownLag,
    knownPartitions: known.length, partitionCount: partitions.length, complete: complete && known.length === partitions.length,
    abnormalPartitions: partitions.filter(row => (row.lag != null && BigInt(row.lag) > 0n)
      || ['before-earliest', 'beyond-end', 'unreadable'].includes(row.status)).length,
    uncommittedPartitions: partitions.filter(row => row.status === 'uncommitted').length }
}

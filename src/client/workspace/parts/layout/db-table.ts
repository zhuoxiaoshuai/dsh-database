export type DbSortOrder = 'asc' | 'desc'

export function nextDbSort(key: string | undefined, order: DbSortOrder | undefined, column: string): { key?: string; order?: DbSortOrder } {
  if (key !== column || !order) return { key: column, order: 'asc' }
  if (order === 'asc') return { key: column, order: 'desc' }
  return {}
}

export function compareDbValues(left: unknown, right: unknown): number {
  const leftEmpty = left == null || left === ''
  const rightEmpty = right == null || right === ''
  if (leftEmpty || rightEmpty) return leftEmpty === rightEmpty ? 0 : leftEmpty ? 1 : -1
  if (/^-?\d+$/.test(String(left)) && /^-?\d+$/.test(String(right))) return compareDbIntegers(left, right)
  const leftNumber = typeof left === 'number' ? left : Number(left)
  const rightNumber = typeof right === 'number' ? right : Number(right)
  if (Number.isFinite(leftNumber) && Number.isFinite(rightNumber) && String(left).trim() !== '' && String(right).trim() !== '') return leftNumber - rightNumber
  return String(left).localeCompare(String(right), 'zh')
}

export function compareDbIntegers(left: unknown, right: unknown): number {
  if (emptyDbValue(left) || emptyDbValue(right)) return emptyDbValue(left) === emptyDbValue(right) ? 0 : emptyDbValue(left) ? 1 : -1
  if (!/^-?\d+$/.test(String(left)) || !/^-?\d+$/.test(String(right))) return compareDbValues(left, right)
  const a = BigInt(String(left)), b = BigInt(String(right))
  return a < b ? -1 : a > b ? 1 : 0
}

function emptyDbValue(value: unknown): boolean {
  return value == null || value === ''
}

export function sortDbRows<T>(rows: readonly T[], key: string | undefined, order: DbSortOrder | undefined, value: (row: T, key: string) => unknown, compare = compareDbValues): T[] {
  if (!key || !order) return [...rows]
  const direction = order === 'asc' ? 1 : -1
  return [...rows].sort((left, right) => {
    const leftValue = value(left, key)
    const rightValue = value(right, key)
    if (emptyDbValue(leftValue) || emptyDbValue(rightValue)) return compareDbValues(leftValue, rightValue)
    const compared = compare(leftValue, rightValue)
    return direction * compared
  })
}

export function dbRowClass(active: boolean): string {
  return active ? 'is-active' : ''
}

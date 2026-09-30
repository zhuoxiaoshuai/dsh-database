const RAW_GLOB = /[*?[]/

function escapeGlob(text: string): string {
  return text.replace(/[\\*?[\]]/g, '\\$&')
}

/** First word becomes the SCAN MATCH pattern. Plain text matches anywhere; glob text is sent as written. */
export function redisScanMatch(query: string): string {
  const first = query.trim().split(/\s+/).find(Boolean) || ''
  if (!first) return '*'
  if (RAW_GLOB.test(first)) return first
  return `*${escapeGlob(first)}*`
}

function globMatches(name: string, pattern: string): boolean {
  let source = ''
  for (let index = 0; index < pattern.length; index++) {
    const char = pattern[index]
    if (char === '\\') {
      const next = pattern[index + 1]
      source += next ? next.replace(/[.*+?^${}()|[\]\\]/g, '\\$&') : '\\\\'
      if (next) index += 1
    } else if (char === '*') source += '.*'
    else if (char === '?') source += '.'
    else if (char === '[') {
      const end = pattern.indexOf(']', index + 1)
      if (end > index + 1) { source += pattern.slice(index, end + 1); index = end }
      else source += '\\['
    } else source += char.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
  }
  try { return new RegExp(`^${source}$`, 'i').test(name) } catch { return false }
}

/** Every word must hit. Plain words are case-insensitive substrings; glob words keep Redis MATCH rules. */
export function redisKeyMatches(name: string, query: string): boolean {
  const parts = query.trim().split(/\s+/).filter(Boolean)
  if (!parts.length) return true
  return parts.every(part => RAW_GLOB.test(part) ? globMatches(name, part) : name.toLocaleLowerCase().includes(part.toLocaleLowerCase()))
}

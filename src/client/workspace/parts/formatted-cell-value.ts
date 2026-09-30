// Validate JSON, then indent its original tokens. Never stringify parsed numbers.
export function formatValue(raw: string, kind: string): string {
  if (raw.length > 262144) return raw
  if (kind === 'json') {
    try { JSON.parse(raw) } catch { return raw }
    let output = '', depth = 0, quoted = false, escape = false
    for (const char of raw) {
      if (output.length > 1048576) return raw
      if (quoted) { output += char; if (escape) escape = false; else if (char === '\\') escape = true; else if (char === '"') quoted = false; continue }
      if (char === '"') { quoted = true; output += char }
      else if (char === '{' || char === '[') { depth++; if (depth > 64) return raw; output += char + '\n' + '  '.repeat(depth) }
      else if (char === '}' || char === ']') { depth--; output += '\n' + '  '.repeat(depth) + char }
      else if (char === ',') output += ',\n' + '  '.repeat(depth)
      else if (char === ':') output += ': '
      else if (!/\s/.test(char)) output += char
    }
    return output
  }
  if (kind === 'xml') {
    if (/<!DOCTYPE|<!ENTITY/i.test(raw)) return raw
    const parsed = new DOMParser().parseFromString(raw, 'application/xml')
    if (parsed.querySelector('parsererror')) return raw
    return new XMLSerializer().serializeToString(parsed).replace(/></g, '>\n<')
  }
  return raw
}

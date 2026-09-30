const DATE_FORMAT = 'YYYY-MM-DD HH24:MI:SS'
export const ORACLE_TEMPORAL_SESSION_SQL = [
  "ALTER SESSION SET TIME_ZONE = 'UTC'",
  `ALTER SESSION SET NLS_DATE_FORMAT = '${DATE_FORMAT}'`,
  "ALTER SESSION SET NLS_TIMESTAMP_FORMAT = 'YYYY-MM-DD HH24:MI:SS.FF9'",
  "ALTER SESSION SET NLS_TIMESTAMP_TZ_FORMAT = 'YYYY-MM-DD HH24:MI:SS.FF9 TZH:TZM'",
]

const TEMPORAL = /^(\d{4})-(\d{2})-(\d{2})[ T](\d{2}):(\d{2}):(\d{2})(?:\.(\d{1,9}))?(?:(?:\s*)(Z|[+-]\d{2}:\d{2}))?$/i

export async function applyOracleTemporalSession(connection) {
  for (const sql of ORACLE_TEMPORAL_SESSION_SQL) await connection.execute(sql)
}

export function classifyOracleTemporal(column) {
  const type = String(column?.type || '').toUpperCase().replace(/\s+/g, ' ').trim()
  if (!type) return null
  const fromName = type.match(/TIMESTAMP\s*\((\d+)\)/)
  const rawScale = column?.scale
  const parsedScale = rawScale === null || rawScale === undefined || rawScale === '' ? NaN : Number(rawScale)
  const scale = Number.isInteger(parsedScale) ? parsedScale : (fromName ? Number(fromName[1]) : 6)
  if (type === 'DATE' || type.startsWith('DATE(') || type.startsWith('DATE ')) return { kind: 'date', scale: 0 }
  if (!/^TIMESTAMP\b/.test(type)) return null
  if (/\bWITH LOCAL TIME ZONE\b/.test(type)) return { kind: 'tsltz', scale: Number.isInteger(scale) ? scale : 6 }
  if (/\bWITH TIME ZONE\b/.test(type)) return { kind: 'tstz', scale: Number.isInteger(scale) ? scale : 6 }
  return { kind: 'timestamp', scale: Number.isInteger(scale) ? scale : 6 }
}

function assertCivil(year, month, day, hour, minute, second) {
  const y = Number(year), mo = Number(month), d = Number(day), h = Number(hour), mi = Number(minute), s = Number(second)
  if ([y, mo, d, h, mi, s].some(n => !Number.isInteger(n))) throw new Error('时间值无效。')
  if (mo < 1 || mo > 12 || d < 1 || d > 31 || h > 23 || mi > 59 || s > 59) throw new Error('时间值无效。')
  const dt = new Date(Date.UTC(y, mo - 1, d, h, mi, s))
  if (dt.getUTCFullYear() !== y || dt.getUTCMonth() !== mo - 1 || dt.getUTCDate() !== d
    || dt.getUTCHours() !== h || dt.getUTCMinutes() !== mi || dt.getUTCSeconds() !== s) throw new Error('时间值无效。')
}

function padFraction(frac, scale) {
  const digits = frac || ''
  if (!Number.isInteger(scale) || scale < 0 || scale > 9) throw new Error('时间列精度无效。')
  if (scale === 0) {
    if (/[1-9]/.test(digits)) throw new Error('时间值精度超过列定义。')
    return ''
  }
  if (digits.length > scale && /[1-9]/.test(digits.slice(scale))) throw new Error('时间值精度超过列定义。')
  return digits.slice(0, scale).padEnd(scale, '0')
}

function parseTemporal(value) {
  if (typeof value !== 'string' || !value.trim()) throw new Error('时间值无效。')
  const match = TEMPORAL.exec(value.trim())
  if (!match) throw new Error('时间值无效。')
  const [, year, month, day, hour, minute, second, fraction, zone] = match
  assertCivil(year, month, day, hour, minute, second)
  let offset
  if (zone) {
    if (/^z$/i.test(zone)) offset = '+00:00'
    else {
      const sign = zone[0], hh = Number(zone.slice(1, 3)), mm = Number(zone.slice(4, 6))
      if (!Number.isInteger(hh) || !Number.isInteger(mm) || hh > 15 || mm > 59) throw new Error('时间值无效。')
      offset = `${sign}${String(hh).padStart(2, '0')}:${String(mm).padStart(2, '0')}`
    }
  }
  return { year, month, day, hour, minute, second, fraction: fraction || '', offset }
}

function formatCivil(parts, fraction) {
  const body = `${parts.year}-${parts.month}-${parts.day} ${parts.hour}:${parts.minute}:${parts.second}`
  return fraction ? `${body}.${fraction}` : body
}

export function canonicalizeOracleTemporal(column, value) {
  const classified = classifyOracleTemporal(column)
  if (!classified) throw new Error('不是可规范化的 Oracle 时间列。')
  const parts = parseTemporal(value)
  const fraction = padFraction(parts.fraction, classified.scale)
  if (classified.kind === 'date') {
    if (parts.offset) throw new Error('DATE 不接受时区偏移。')
    return formatCivil(parts, '')
  }
  if (classified.kind === 'timestamp') {
    if (parts.offset && parts.offset !== '+00:00') throw new Error('TIMESTAMP 不接受时区偏移。')
    return formatCivil(parts, fraction)
  }
  if (classified.kind === 'tsltz') {
    if (parts.offset && parts.offset !== '+00:00') throw new Error('TIMESTAMP WITH LOCAL TIME ZONE 仅接受 UTC。')
    return formatCivil(parts, fraction)
  }
  if (!parts.offset) throw new Error('TIMESTAMP WITH TIME ZONE 需要显式偏移。')
  return `${formatCivil(parts, fraction)} ${parts.offset}`
}

export function oracleTemporalExpression(classified, placeholder) {
  if (classified.kind === 'date') return `TO_DATE(${placeholder}, '${DATE_FORMAT}')`
  const stamp = classified.scale > 0 ? `YYYY-MM-DD HH24:MI:SS.FF${classified.scale}` : DATE_FORMAT
  if (classified.kind === 'timestamp') return `TO_TIMESTAMP(${placeholder}, '${stamp}')`
  if (classified.kind === 'tsltz') return `CAST(TO_TIMESTAMP(${placeholder}, '${stamp}') AS TIMESTAMP WITH LOCAL TIME ZONE)`
  const tz = classified.scale > 0 ? `${stamp} TZH:TZM` : `${DATE_FORMAT} TZH:TZM`
  return `TO_TIMESTAMP_TZ(${placeholder}, '${tz}')`
}

export function normalizeOracleFetchedString(value) {
  if (typeof value !== 'string') return value
  const text = value.trim()
  const match = TEMPORAL.exec(text)
  if (!match || match[0] !== text) return value
  const [, year, month, day, hour, minute, second, fraction, zone] = match
  try { assertCivil(year, month, day, hour, minute, second) } catch { return value }
  const frac = (fraction || '').replace(/0+$/, '')
  const body = `${year}-${month}-${day} ${hour}:${minute}:${second}${frac ? `.${frac}` : ''}`
  if (!zone) return body
  const offset = /^z$/i.test(zone) ? '+00:00' : zone
  return `${body} ${offset}`
}

export function oracleFetchTypeHandler(oracle) {
  return meta => [oracle.DB_TYPE_NUMBER, oracle.DB_TYPE_DATE, oracle.DB_TYPE_TIMESTAMP, oracle.DB_TYPE_TIMESTAMP_TZ, oracle.DB_TYPE_TIMESTAMP_LTZ].includes(meta.dbType)
    ? { type: oracle.STRING }
    : undefined
}

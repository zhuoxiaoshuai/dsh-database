/** A server rejection is definitive; transport/cancel errors cannot prove no commit. */
export function writeDriverError(error, message) {
  const code = typeof error?.code === 'string' ? error.code : ''
  const oracle = Number(error?.errorNum || 0)
  const rejected = /^ER_/.test(code) && !error?.fatal
    || oracle > 0 && ![1013, 3113, 3114, 3135].includes(oracle)
  return Object.assign(new Error(message), { code, databaseCode: code || (oracle > 0 ? `ORA-${String(oracle).padStart(5, '0')}` : undefined),
    category: rejected ? 'database-rejection' : 'transport-or-interruption', phase: 'execute', effect: rejected ? 'none' : 'unknown' })
}

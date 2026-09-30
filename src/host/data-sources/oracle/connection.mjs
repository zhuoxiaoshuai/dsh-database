import { DRIVER_TIMEOUTS } from '../../request-timeouts.mjs'

export const ORACLE_IDENTITY_SQL = "SELECT SYS_CONTEXT('USERENV','DB_UNIQUE_NAME'), SYS_CONTEXT('USERENV','SERVICE_NAME'), SYS_CONTEXT('USERENV','SESSION_USER') FROM DUAL"

export function oracleConnectionConfig(input) {
  const key = input.oracleMode === 'sid' ? 'SID' : 'SERVICE_NAME'
  return {
    user: input.username,
    password: input.password,
    connectString: `(DESCRIPTION=(ADDRESS=(PROTOCOL=TCP)(HOST=${input.host})(PORT=${input.port}))(CONNECT_DATA=(${key}=${input.database})))`,
    transportConnectTimeout: DRIVER_TIMEOUTS.connectTransportSec,
    retryCount: 0,
  }
}

export const config = oracleConnectionConfig
export function validateTarget(database, oracleMode) {
  if (!['service', 'sid'].includes(String(oracleMode)) || !/^[a-zA-Z0-9._$#-]+$/.test(database)) {
    throw new Error('Oracle 需要有效的 Service Name 或 SID。')
  }
}
export const fingerprintSuffix = mode => [mode === 'sid' ? 'sid' : 'service']

export async function readOracleIdentity(connection) {
  return (await connection.execute(ORACLE_IDENTITY_SQL)).rows[0]
}

export async function oracleIdentityMatches(connection, expectedIdentity) {
  return JSON.stringify(await readOracleIdentity(connection)) === expectedIdentity
}

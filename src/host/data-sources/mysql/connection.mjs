export function mysqlConnectionConfig(input, options = {}) {
  return {
    host: input.host,
    port: input.port,
    user: input.username,
    password: input.password,
    ...options,
    multipleStatements: false,
  }
}

export const config = mysqlConnectionConfig
export function validateTarget() {}
export const fingerprintSuffix = () => []

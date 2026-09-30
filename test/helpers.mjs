import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

export function temporaryDirectory(tOrPrefix, maybePrefix) {
  const t = typeof tOrPrefix === 'string' ? undefined : tOrPrefix
  const prefix = typeof tOrPrefix === 'string' ? tOrPrefix : maybePrefix
  const directory = mkdtempSync(join(tmpdir(), prefix))
  const cleanup = () => rmSync(directory, { recursive: true, force: true })
  if (t) {
    t.after(cleanup)
    return directory
  }
  return { directory, cleanup }
}

export function connectionInput(overrides = {}) {
  return {
    name: 'fixture',
    dialect: 'mysql',
    host: 'db.test',
    port: 3306,
    database: 'app',
    oracleMode: 'service',
    username: 'reader',
    password: 'secret',
    environment: 'sit',
    ...overrides,
  }
}

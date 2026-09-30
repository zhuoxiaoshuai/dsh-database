import { existsSync } from 'node:fs'
import { homedir } from 'node:os'
import { join } from 'node:path'

/** Desktop stores harness data under APPDATA; CLI sets DSH_HOME. Honor DSH_HOME when set. */
export function resolveDshHome(): string {
  const envHome = process.env.DSH_HOME?.trim()
  if (envHome) return envHome
  const desktop = process.env.APPDATA ? join(process.env.APPDATA, 'dsh-desktop', 'harness') : ''
  if (desktop && existsSync(join(desktop, 'database', 'database-workspace.json'))) return desktop
  return desktop || join(homedir(), '.dsh')
}

export function databaseWorkspaceRoot(directory?: string): string {
  return directory || join(resolveDshHome(), 'database')
}

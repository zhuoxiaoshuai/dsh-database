import { existsSync, readdirSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import { databaseWorkspaceRoot, resolveDshHome } from './dsh-home.ts'
import type { PasswordProtector } from '../password-protector.ts'
import { windowsPasswordProtector } from '../password-protector.ts'
import type { Connection, ConnectionWorkbench, SourceConnectionSettings } from '../shared/workbench.ts'
import { coerceVisibleSchemas, sanitizeConnectionWorkbench } from '../shared/workbench.ts'
import { hostModules } from './data-sources/modules.ts'
import { normalizeEnvironment } from '../shared/connection-permission.ts'
import { writeJsonFile } from './json-file.ts'

export type StoredDatabaseConnection = {
  id: string
  settings: SourceConnectionSettings
  protectedPassword?: string
  protectedCa?: string
  /** 连接树下一级 id。空或缺省表示全部。不进会话文件。 */
  visibleSchemas?: string[]
  /** 仅读取旧文件时暂存，落盘前剥离。 */
  workbench?: ConnectionWorkbench
}

export type WorkspaceFile = {
  connections: StoredDatabaseConnection[]
  lastActiveId?: string
}

export const memoryPasswordProtector: PasswordProtector = {
  available: true,
  protect: async value => Buffer.from(value, 'utf8').toString('base64'),
  unprotect: async value => Buffer.from(value, 'base64').toString('utf8'),
}

function workspaceRoot(directory?: string) {
  return databaseWorkspaceRoot(directory)
}

/** Workspace-wide connection coordinates and optional DPAPI secrets. */
export class SavedDatabaseConnections {
  readonly path: string
  readonly passwordStorage: boolean
  readonly root: string
  private broken = false
  private readonly scoped: boolean
  private readonly protector: PasswordProtector
  constructor(directory?: string, protector: PasswordProtector = windowsPasswordProtector) {
    this.scoped = !!directory
    this.root = workspaceRoot(directory)
    this.path = join(this.root, 'database-workspace.json')
    this.protector = protector
    this.passwordStorage = protector.available
  }

  load(): WorkspaceFile {
    if (!existsSync(this.path)) return this.migrateLegacy()
    try {
      return this.parseFile(JSON.parse(readFileSync(this.path, 'utf8')))
    } catch {
      this.broken = true
      throw new Error('数据库连接记录无法读取，原文件已保留。')
    }
  }

  save(file: WorkspaceFile): void {
    if (this.broken) throw new Error('数据库连接记录损坏，未覆盖原文件。')
    const rows = file.connections.map(sanitizeStoredConnection)
    if (rows.length > 100) throw new Error('保存的数据库连接数量已达上限。')
    if (new Set(rows.map(row => row.id)).size !== rows.length) throw new Error('数据库连接标识重复。')
    const lastActiveId = file.lastActiveId && rows.some(row => row.id === file.lastActiveId) ? file.lastActiveId : undefined
    writeJsonFile(this.path, {
      version: 3,
      ...(lastActiveId ? { lastActiveId } : {}),
      connections: rows.map(row => ({
        id: row.id,
        settings: row.settings,
        ...(row.protectedPassword ? { protectedPassword: row.protectedPassword } : {}),
        ...(row.protectedCa ? { protectedCa: row.protectedCa } : {}),
        ...(row.visibleSchemas?.length ? { visibleSchemas: row.visibleSchemas } : {}),
      })),
    })
  }

  async protectPassword(id: string, password: string): Promise<string> {
    return this.protector.protect(JSON.stringify({ id, password }))
  }

  async resolvePassword(row: StoredDatabaseConnection): Promise<string> {
    if (!row.protectedPassword) throw new Error('已保存密码不可用，请重新输入密码。')
    try {
      const secret = JSON.parse(await this.protector.unprotect(row.protectedPassword))
      if (secret.id !== row.id || typeof secret.password !== 'string' || !secret.password) throw new Error()
      return secret.password
    } catch {
      throw new Error('无法读取已保存密码，请重新输入密码。')
    }
  }
  async protectCa(id: string, caPem: string): Promise<string> {
    return this.protector.protect(JSON.stringify({ id, caPem }))
  }
  async resolveCa(row: StoredDatabaseConnection): Promise<string> {
    if (!row.protectedCa) return ''
    try {
      const value = JSON.parse(await this.protector.unprotect(row.protectedCa))
      if (value.id !== row.id || typeof value.caPem !== 'string') throw new Error()
      return value.caPem
    } catch { throw new Error('无法读取已保存 CA 证书，请重新输入。') }
  }

  private migrateLegacy(): WorkspaceFile {
    const merged = new Map<string, StoredDatabaseConnection>()
    for (const file of this.legacyFiles()) {
      try {
        const parsed = JSON.parse(readFileSync(file, 'utf8'))
        if ((parsed.version === 1 || parsed.version === 2) && Array.isArray(parsed.connections)) {
          for (const row of parsed.connections) {
            const stored = sanitizeStoredConnection(row)
            if (!merged.has(stored.id)) merged.set(stored.id, stored)
          }
        }
      } catch { /* keep unreadable legacy files; do not copy them */ }
    }
    const connections = [...merged.values()]
    if (connections.length) this.save({ connections })
    return { connections }
  }

  private legacyFiles(): string[] {
    const names: string[] = []
        const extra = this.scoped ? [] : [join(resolveDshHome(), 'remote-exec'), join(resolveDshHome(), 'remote-exec', 'database-connections')]
    for (const directory of [this.root, join(this.root, 'database-connections'), ...extra]) {
      if (!existsSync(directory)) continue
      for (const name of readdirSync(directory)) {
        if (!name.endsWith('.json') || name === 'database-workspace.json') continue
        names.push(join(directory, name))
      }
    }
    return names
  }

  private parseFile(value: { version?: number; connections?: unknown; lastActiveId?: unknown }): WorkspaceFile {
    if (![1, 2, 3].includes(value.version || 0) || !Array.isArray(value.connections) || value.connections.length > 100) throw new Error()
    const connections: StoredDatabaseConnection[] = []
    const seen = new Set<string>()
    for (const row of value.connections) {
      try {
        const stored = sanitizeStoredConnection(row)
        if (seen.has(stored.id)) continue
        seen.add(stored.id)
        connections.push(stored)
      } catch { /* keep remaining connections when one row is invalid */ }
    }
    const lastActiveId = typeof value.lastActiveId === 'string' && connections.some(row => row.id === value.lastActiveId) ? value.lastActiveId : undefined
    return { connections, lastActiveId }
  }
}

/** 复制连接名称：`原名 副本`，冲突时 `原名 副本 2`。 */
export function uniqueCopyName(name: string, taken: Iterable<string>, max = 80): string {
  const used = taken instanceof Set ? taken : new Set(taken)
  const stripped = name.replace(/\s*副本(?:\s+\d+)?$/u, '').trim() || name.trim() || '连接'
  const extra = (n?: number) => (n ? ` 副本 ${n}` : ' 副本')
  const fit = (stem: string, suffix: string) => {
    const room = max - suffix.length
    return `${(room > 0 ? stem.slice(0, room) : '').trimEnd()}${suffix}`.slice(0, max).trim() || suffix.trim().slice(0, max)
  }
  let n = 0
  let candidate = fit(stripped, extra())
  while (used.has(candidate)) {
    n = n ? n + 1 : 2
    candidate = fit(stripped, extra(n))
    if (n > 999) break
  }
  return candidate
}

export function publicConnection(row: StoredDatabaseConnection, live?: Connection, workbench?: ConnectionWorkbench): Connection {
  const merged: ConnectionWorkbench = { ...workbench }
  if (row.visibleSchemas?.length) merged.visibleSchemas = row.visibleSchemas
  else delete merged.visibleSchemas
  return {
    id: row.id,
    name: live?.name || row.settings.name,
    dialect: live?.dialect || row.settings.dialect,
    environment: normalizeEnvironment(live?.environment || row.settings.environment),
    database: live?.database || ('database' in row.settings ? row.settings.database : ''),
    version: live?.version || '',
    live: !!live?.live,
    health: live?.health || (live?.live ? 'ready' : 'offline'),
    generation: live?.generation,
    databases: live?.databases,
    settings: { ...row.settings, caPem: undefined },
    hasPassword: !!row.protectedPassword,
    hasCa: !!row.protectedCa,
    ...(Object.keys(merged).length ? { workbench: merged } : {}),
  }
}

function sanitizeStoredConnection(value: Connection | StoredDatabaseConnection): StoredDatabaseConnection {
  if (!value || typeof value.id !== 'string' || !value.id || value.id.length > 160 || !value.settings) throw new Error('数据库连接记录无效。')
  const settings: SourceConnectionSettings = hostModules.get(value.settings.dialect).connection.normalizeStoredSettings(value.settings)
  const protectedPassword = 'protectedPassword' in value && typeof value.protectedPassword === 'string' && value.protectedPassword
    ? value.protectedPassword.slice(0, 65536)
    : undefined
  const protectedCa = 'protectedCa' in value && typeof value.protectedCa === 'string' && value.protectedCa
    ? value.protectedCa.slice(0, 131072)
    : undefined
  const fromRow = 'visibleSchemas' in value ? value.visibleSchemas : undefined
  const visibleSchemas = coerceVisibleSchemas(fromRow ?? value.workbench?.visibleSchemas)
  const workbench = value.workbench ? sanitizeConnectionWorkbench(value.workbench) : undefined
  const legacy = workbench && (workbench.queryTabs?.length || workbench.history?.length || workbench.templates?.length)
  return {
    id: value.id,
    settings,
    ...(protectedPassword ? { protectedPassword } : {}),
    ...(protectedCa ? { protectedCa } : {}),
    ...(visibleSchemas.length ? { visibleSchemas } : {}),
    ...(legacy && workbench ? { workbench } : {}),
  }
}

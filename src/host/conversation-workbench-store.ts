import { createHash } from 'node:crypto'
import { existsSync, copyFileSync, readFileSync, mkdirSync, renameSync } from 'node:fs'
import { join } from 'node:path'
import { sanitizeConnectionWorkbench, type ConnectionWorkbench, type SharedQuery } from '../shared/workbench.ts'
import { writeJsonFile } from './json-file.ts'
import { redisCommandTextMayContainCredential } from '../shared/redis-command.ts'

export type ConversationLayout = {
  workbenches: Record<string, ConnectionWorkbench>
}

const MAX_CACHED_SESSIONS = 200

export function hashConversationId(id: string): string {
  return createHash('sha256').update(id).digest('hex').slice(0, 32)
}

export function sanitizeConversationWorkbench(value: unknown): ConnectionWorkbench {
  const saved = sanitizeConnectionWorkbench(value)
  const { templates: _templates, ...rest } = saved
  if (rest.aiDocument) delete rest.sharedQuery
  return rest
}

/**
 * 只处理旧 SharedQuery 的会话字段；权威 ExecutionDocument 原样保留控制权。
 */
function resetSessionScopedFields(query: SharedQuery | undefined): SharedQuery | undefined {
  if (!query) return query
  return { ...query, controller: 'ai' }
}

function diskDocument(value: ConnectionWorkbench['aiDocument']): ConnectionWorkbench['aiDocument'] {
  if (!value) return value
  const text = value.sourceId === 'redis' && redisCommandTextMayContainCredential(value.text) ? '' : value.text
  return { ...value, text }
}

export class ConversationWorkbenchStore {
  private readonly root: string
  /** 每个会话一份驻内存 layout：读路径不再反复读盘解析，写路径只做一次同步落盘 */
  readonly #cache = new Map<string, ConversationLayout>()
  storageDegraded = false
  constructor(root: string) {
    this.root = root
  }

  pathFor(owner: string): string {
    return join(this.root, 'conversation-workbenches', `${hashConversationId(owner)}.json`)
  }

  load(owner: string): ConversationLayout {
    const cached = this.#cache.get(owner)
    if (cached) { this.#cache.delete(owner); this.#cache.set(owner, cached); return structuredClone(cached) }
    const path = this.pathFor(owner)
    if (!existsSync(path)) {
      const empty: ConversationLayout = { workbenches: {} }
      this.remember(owner, empty)
      return structuredClone(empty)
    }
    try {
      const parsed = JSON.parse(readFileSync(path, 'utf8')) as { version?: number; workbenches?: unknown }
      if (parsed.version !== 1 && parsed.version !== 2) throw new Error()
      if (parsed.version === 1 && !existsSync(`${path}.v1.bak`)) copyFileSync(path, `${path}.v1.bak`)
      const workbenches: Record<string, ConnectionWorkbench> = {}
      if (parsed.workbenches && typeof parsed.workbenches === 'object') {
        for (const [id, value] of Object.entries(parsed.workbenches as Record<string, unknown>)) {
          if (typeof id === 'string' && id.length <= 160) {
            try {
              const sanitized = sanitizeConversationWorkbench(value)
              workbenches[id] = { ...sanitized, sharedQuery: resetSessionScopedFields(sanitized.sharedQuery), ...(sanitized.aiDocument ? { aiDocument: diskDocument(sanitized.aiDocument) } : {}) }
            } catch { /* skip one broken tab */ }
          }
        }
      }
      const layout: ConversationLayout = { workbenches }
      this.remember(owner, layout)
      return structuredClone(layout)
    } catch {
      this.storageDegraded = true
      if (!existsSync(`${path}.corrupt.bak`)) copyFileSync(path, `${path}.corrupt.bak`)
      const empty: ConversationLayout = { workbenches: {} }
      this.remember(owner, empty)
      return structuredClone(empty)
    }
  }

  save(owner: string, layout: ConversationLayout, knownIds: Set<string>): void {
    const path = this.pathFor(owner)
    const workbenches: Record<string, ConnectionWorkbench> = {}
    for (const [id, value] of Object.entries(layout.workbenches)) {
      if (!knownIds.has(id)) continue
      const sanitized = sanitizeConversationWorkbench(value)
      workbenches[id] = { ...sanitized, sharedQuery: resetSessionScopedFields(sanitized.sharedQuery), ...(sanitized.aiDocument ? { aiDocument: diskDocument(sanitized.aiDocument) } : {}) }
    }
    if (existsSync(path) && !existsSync(`${path}.v1.bak`)) {
      try { const previous = JSON.parse(readFileSync(path, 'utf8')); if (previous.version === 1) copyFileSync(path, `${path}.v1.bak`) }
      catch { if (!existsSync(`${path}.corrupt.bak`)) copyFileSync(path, `${path}.corrupt.bak`) }
    }
    try { writeJsonFile(path, { version: 2, workbenches }); this.storageDegraded = false }
    catch (error) { this.storageDegraded = true; throw error }
    // 调用方不能通过引用修改权威缓存。
    this.remember(owner, layout)
  }

  private remember(owner: string, layout: ConversationLayout): void {
    this.#cache.delete(owner)
    this.#cache.set(owner, structuredClone(layout))
    while (this.#cache.size > MAX_CACHED_SESSIONS) this.#cache.delete(this.#cache.keys().next().value!)
  }

  /** Called only by api-session/removed; files remain recoverable. */
  archive(owner: string): void {
    this.#cache.delete(owner)
    const directory = join(this.root, 'removed-conversation-workbenches')
    mkdirSync(directory, { recursive: true })
    const path = this.pathFor(owner)
    const stem = `${hashConversationId(owner)}-${Date.now()}`
    if (existsSync(path)) renameSync(path, join(directory, `${stem}.json`))
    if (existsSync(`${path}.v1.bak`)) renameSync(`${path}.v1.bak`, join(directory, `${stem}.v1.bak`))
  }
}

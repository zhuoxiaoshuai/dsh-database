import { createHash } from 'node:crypto'
import { existsSync, mkdirSync, readdirSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import { sanitizeConnectionWorkbench, type ConnectionWorkbench, type SharedQuery } from '../shared/workbench.ts'
import { writeJsonFile } from './json-file.ts'
import { redisCommandTextMayContainCredential } from '../shared/redis-command.ts'

export type ConversationLayout = {
  workbenches: Record<string, ConnectionWorkbench>
}

const MAX_FILES = 200

export function hashConversationId(id: string): string {
  return createHash('sha256').update(id).digest('hex').slice(0, 32)
}

export function sanitizeConversationWorkbench(value: unknown): ConnectionWorkbench {
  const saved = sanitizeConnectionWorkbench(value)
  const { templates: _templates, ...rest } = saved
  return rest
}

/**
 * 会话级状态（controller）不落盘：重启后回到默认（AI 控制）。
 * 内存里保留真实值，落盘快照统一重置。
 */
function resetSessionScopedFields(query: SharedQuery | undefined): SharedQuery | undefined {
  if (!query) return query
  return { ...query, controller: 'ai' }
}

function diskDocument(value: ConnectionWorkbench['aiDocument']): ConnectionWorkbench['aiDocument'] {
  if (!value) return value
  const text = redisCommandTextMayContainCredential(value.text) ? '' : value.text
  return { ...value, text, controller: 'ai' }
}

export class ConversationWorkbenchStore {
  private readonly root: string
  /** 每个会话一份驻内存 layout：读路径不再反复读盘解析，写路径只做一次同步落盘 */
  readonly #cache = new Map<string, ConversationLayout>()
  constructor(root: string) {
    this.root = root
  }

  pathFor(owner: string): string {
    return join(this.root, 'conversation-workbenches', `${hashConversationId(owner)}.json`)
  }

  load(owner: string): ConversationLayout {
    const cached = this.#cache.get(owner)
    if (cached) return cached
    const path = this.pathFor(owner)
    if (!existsSync(path)) {
      const empty: ConversationLayout = { workbenches: {} }
      this.#cache.set(owner, empty)
      return empty
    }
    try {
      const parsed = JSON.parse(readFileSync(path, 'utf8')) as { version?: number; workbenches?: unknown }
      if (parsed.version !== 1) throw new Error()
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
      this.#cache.set(owner, layout)
      return layout
    } catch {
      const empty: ConversationLayout = { workbenches: {} }
      this.#cache.set(owner, empty)
      return empty
    }
  }

  save(owner: string, layout: ConversationLayout, knownIds: Set<string>): void {
    const directory = join(this.root, 'conversation-workbenches')
    const path = this.pathFor(owner)
    // 上限检查只在新文件首次落盘时需要扫描目录；目录扫描每次都做会放大写盘成本
    if (!existsSync(path) && existsSync(directory) && readdirSync(directory).filter(name => name.endsWith('.json')).length >= MAX_FILES) {
      throw new Error('对话工作区数量已达上限。')
    }
    const workbenches: Record<string, ConnectionWorkbench> = {}
    for (const [id, value] of Object.entries(layout.workbenches)) {
      if (!knownIds.has(id)) continue
      const sanitized = sanitizeConversationWorkbench(value)
      workbenches[id] = { ...sanitized, sharedQuery: resetSessionScopedFields(sanitized.sharedQuery), ...(sanitized.aiDocument ? { aiDocument: diskDocument(sanitized.aiDocument) } : {}) }
    }
    writeJsonFile(path, { version: 1, workbenches })
    // 落盘的是重置后的快照；内存缓存保留真实状态（含会话级字段），后续 load 命中缓存
    this.#cache.set(owner, layout)
  }
}

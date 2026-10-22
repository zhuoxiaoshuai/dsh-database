import { createHash } from 'node:crypto'
import type { KnowledgeArchiveGuard, KnowledgeArchiveTarget, KnowledgeTidySnapshot } from '../shared/knowledge.ts'

type Subject = { id: string; version: number; connectionId?: string; familyId: string; lineageId?: string; sourceId?: string; dialect?: string;
  title: string; summary: string; tags: string[]; text?: string; originalSql?: string }

/** The same complete content fields used by tidy snapshots, never a clipped list preview. */
export function archiveGuard(item: Subject): KnowledgeArchiveGuard {
  const snapshot: KnowledgeTidySnapshot = { text: item.originalSql ?? item.text ?? '', title: item.title, summary: item.summary, tags: item.tags }
  const token = createHash('sha256').update(JSON.stringify([item.id, item.connectionId || '', item.sourceId || item.dialect,
    item.familyId, item.lineageId || '', item.version, snapshot])).digest('hex')
  return { expectedVersion: item.version, expectedContentToken: token }
}

export function parseArchiveGuard(value: unknown): KnowledgeArchiveGuard {
  const guard = value as KnowledgeArchiveGuard | undefined
  if (!guard || !Number.isSafeInteger(guard.expectedVersion) || guard.expectedVersion < 1
    || typeof guard.expectedContentToken !== 'string' || !/^[a-f0-9]{64}$/.test(guard.expectedContentToken)) {
    throw new Error('归档需要已查看的版本与完整内容标记，请重新查看后重试。')
  }
  return { expectedVersion: guard.expectedVersion, expectedContentToken: guard.expectedContentToken }
}

export function assertArchiveGuard(item: Subject, value: unknown): void {
  const expected = parseArchiveGuard(value), actual = archiveGuard(item)
  if (actual.expectedVersion !== expected.expectedVersion || actual.expectedContentToken !== expected.expectedContentToken) {
    throw new Error('条目已被其他人更新，请重新查看后再归档。')
  }
}

export function parseArchiveTargets(value: unknown, ids: string[]): Map<string, KnowledgeArchiveGuard> {
  if (!Array.isArray(value) || value.length !== ids.length) throw new Error('归档需要保留项和全部归档项的已查看内容标记。')
  const result = new Map<string, KnowledgeArchiveGuard>()
  for (const entry of value as KnowledgeArchiveTarget[]) {
    if (!entry || typeof entry.id !== 'string' || !ids.includes(entry.id) || result.has(entry.id)) throw new Error('归档内容标记缺失、重复或与目标不匹配。')
    result.set(entry.id, parseArchiveGuard(entry.archiveGuard))
  }
  return result
}

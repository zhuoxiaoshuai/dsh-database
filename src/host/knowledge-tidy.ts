import type { DataSourceId } from '../shared/data-sources/types.ts'
import { randomUUID } from 'node:crypto'
import type { KnowledgeTidyBatch, KnowledgeTidyChange, KnowledgeTidyRisk, KnowledgeTidySnapshot } from '../shared/knowledge.ts'

export const TIDY_CHANGE_LIMIT = 30

export type TidySubject = {
  id: string
  connectionId: string
  sourceId: string
  version: number
  title: string
  summary: string
  tags: string[]
  text: string
}

export type TidyProposal = {
  id: string
  kind: 'update' | 'archive'
  title?: string
  summary?: string
  tags?: string[]
  sql?: string
  archiveIds?: string[]
}

const TEXT = 240

function clip(value: unknown, fallback = ''): string {
  return (typeof value === 'string' && value.trim() ? value : fallback).trim().slice(0, TEXT)
}

function clipTags(value: unknown, fallback: string[]): string[] {
  const source = Array.isArray(value) ? value : fallback
  return [...new Set(source.filter((item): item is string => typeof item === 'string' && !!item.trim()).map(item => item.trim().slice(0, 32)))].slice(0, 12)
}

function parseIds(value: unknown): string[] {
  if (!Array.isArray(value) || value.some(item => typeof item !== 'string' || !item.trim())) throw new Error('归档列表无效。')
  return value.map(item => (item as string).trim())
}

export function parseTidyProposals(value: unknown): TidyProposal[] {
  if (!Array.isArray(value) || value.length === 0) throw new Error('请提供整理变更。')
  if (value.length > TIDY_CHANGE_LIMIT) throw new Error(`单次最多提交 ${TIDY_CHANGE_LIMIT} 条变更。`)
  const proposals: TidyProposal[] = value.map(raw => {
    if (!raw || typeof raw !== 'object' || Array.isArray(raw)) throw new Error('整理变更无效。')
    const body = raw as Record<string, unknown>
    const id = typeof body.id === 'string' ? body.id.trim() : ''
    if (!id) throw new Error('请提供 id。')
    if (body.kind !== 'update' && body.kind !== 'archive') throw new Error('kind 须为 update 或 archive。')
    return {
      id,
      kind: body.kind,
      ...(typeof body.title === 'string' ? { title: body.title } : {}),
      ...(typeof body.summary === 'string' ? { summary: body.summary } : {}),
      ...(Array.isArray(body.tags) ? { tags: body.tags as string[] } : {}),
      ...(typeof body.sql === 'string' ? { sql: body.sql } : {}),
      ...(body.archiveIds === undefined ? {} : { archiveIds: parseIds(body.archiveIds) }),
    }
  })
  const seen = new Set<string>()
  for (const proposal of proposals) {
    if (seen.has(proposal.id)) throw new Error('整理变更不能重复。')
    seen.add(proposal.id)
    for (const extra of proposal.archiveIds || []) {
      if (seen.has(extra)) throw new Error('归档目标不能重复。')
      seen.add(extra)
    }
  }
  return proposals
}

export function buildTidyBatch(input: {
  connectionId: string
  sourceId: DataSourceId
  proposals: TidyProposal[]
  lookup(id: string): TidySubject | undefined
  prepare(current: TidySubject, sql: string | undefined): { text: string; risk: KnowledgeTidyRisk }
}): KnowledgeTidyBatch {
  const changes: KnowledgeTidyChange[] = input.proposals.map(proposal => {
    const current = input.lookup(proposal.id)
    if (!current || current.connectionId !== input.connectionId || current.sourceId !== input.sourceId) throw new Error('提案条目不属于此连接。')
    const before: KnowledgeTidySnapshot = { title: current.title, summary: current.summary, tags: [...current.tags], text: current.text }
    if (proposal.kind === 'archive') return { id: current.id, kind: 'archive', expectedVersion: current.version, before, risk: 'same' }
    const archiveTargets = (proposal.archiveIds || []).map(extra => {
      const other = input.lookup(extra)
      if (!other || other.connectionId !== input.connectionId || other.sourceId !== input.sourceId) throw new Error('待归档条目不属于此连接。')
      return { id: other.id, expectedVersion: other.version, before: { title: other.title, summary: other.summary, tags: [...other.tags], text: other.text } }
    })
    const prepared = input.prepare(current, proposal.sql)
    return {
      id: current.id,
      kind: 'update',
      expectedVersion: current.version,
      before,
      after: {
        title: clip(proposal.title, current.title),
        summary: clip(proposal.summary, current.summary),
        tags: clipTags(proposal.tags, current.tags),
        text: prepared.text,
      },
      risk: prepared.risk,
      ...(archiveTargets.length ? { archiveTargets } : {}),
    }
  })
  return { id: randomUUID(), connectionId: input.connectionId, sourceId: input.sourceId, createdAt: new Date().toISOString(), changes }
}

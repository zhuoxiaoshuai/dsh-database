import { randomUUID } from 'node:crypto'
import { archiveGuard, assertArchiveGuard, parseArchiveTargets } from './knowledge-archive-guard.ts'
import { constants, copyFileSync, existsSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import { draftSqlExperience, normalizeSqlExperience, type DialectKind, type NormalizedTemplate } from './sql-template-normalizer.ts'
import { UNPARSED_TEMPLATE_SUMMARY } from '../shared/sql-text.ts'
import { legacyDataSourceId } from '../shared/data-sources/registry.ts'
import { latestPublishedByFamily, searchTemplates, similarTemplates, type TemplateIndex } from './sql-template-similarity.ts'
import { restoreTemplateLineages, sameTemplateLineage, isWritableLineageHead, lineageHead, markAmbiguousLineages } from './sql-template-lineage.ts'
import { writeJsonFile } from './json-file.ts'
import { knowledgePolicies } from './knowledge-policy-registry.ts'
import type { DataSourceId } from '../shared/data-sources/types.ts'
import { formatSqlExperience, sameSqlExperience } from '../shared/sql-experience.ts'
import { buildTidyBatch, parseTidyProposals, TIDY_CHANGE_LIMIT, type TidySubject } from './knowledge-tidy.ts'
import type { KnowledgeArchiveGuard, KnowledgeClusterGroup, KnowledgeItem, KnowledgeTidyBatch, KnowledgeTidyChange, KnowledgeTidyRisk } from '../shared/knowledge.ts'

export type SqlTemplate = TemplateIndex & {
  archiveGuard?: KnowledgeArchiveGuard
  variant: string
  dialect: DialectKind | 'any'
  connectionId?: string
  originalSql: string
}

export type SqlTemplateSummary = Omit<SqlTemplate, 'originalSql' | 'normalizedSql'>

type KnowledgeFile = { templates: SqlTemplate[]; commands: KnowledgeItem[]; tidies: KnowledgeTidyBatch[] }

const MAX_TEMPLATES = 500
// One proposal per connection, with each proposal referencing at least one stored item.
// Match the library capacity, including files previously written above the old load-only cap of 50.
const MAX_TIDY_BATCHES = MAX_TEMPLATES
const TEXT = 240
const CLUSTER_GROUPS = 30
const CLUSTER_MEMBERS = 8
const ARCHIVE_BATCH = 20

function clipText(value: unknown, fallback = ''): string {
  return (typeof value === 'string' && value.trim() ? value : fallback).slice(0, TEXT)
}

function clipTags(value: unknown): string[] {
  if (!Array.isArray(value)) return []
  return [...new Set(value.filter((item): item is string => typeof item === 'string' && !!item.trim()).map(item => item.trim().slice(0, 32)))].slice(0, 12)
}

function dialectOf(item: SqlTemplate): DialectKind {
  return legacyDataSourceId(item.dialect)
}

function sameTemplateContent(a: SqlTemplate, b: SqlTemplate): boolean {
  return a.id === b.id && a.version === b.version && a.originalSql === b.originalSql && a.title === b.title
    && a.summary === b.summary && JSON.stringify(a.tags) === JSON.stringify(b.tags) && a.archived === b.archived
}

function clipPreview(value: string): string {
  return value.replace(/\s+/g, ' ').trim().slice(0, TEXT)
}

function rankKeep<T extends { updatedAt: string; usageCount?: number }>(items: T[]): T {
  return items.slice().sort((a, b) => (b.usageCount || 0) - (a.usageCount || 0) || b.updatedAt.localeCompare(a.updatedAt))[0]
}

function clusterGroups<T extends { id: string; title: string; summary: string; version: number; fingerprint: string; updatedAt: string; usageCount?: number; familyId: string; tags: string[]; connectionId?: string; sourceId?: string; dialect?: string; originalSql?: string; text?: string }>(
  items: T[],
  textOf: (item: T) => string,
): KnowledgeClusterGroup[] {
  const groups = new Map<string, T[]>()
  for (const item of items) {
    const key = item.fingerprint || `id:${item.id}`
    const list = groups.get(key)
    if (list) list.push(item)
    else groups.set(key, [item])
  }
  return [...groups.values()]
    .sort((a, b) => b.length - a.length || rankKeep(b).updatedAt.localeCompare(rankKeep(a).updatedAt))
    .slice(0, CLUSTER_GROUPS)
    .map(members => {
      const keep = rankKeep(members)
      return {
        fingerprint: keep.fingerprint,
        keepId: keep.id,
        count: members.length,
        members: members.slice().sort((a, b) => Number(b.id === keep.id) - Number(a.id === keep.id)).slice(0, CLUSTER_MEMBERS)
          .map(item => ({ id: item.id, title: item.title, summary: item.summary, version: item.version, archiveGuard: archiveGuard(item), text: clipPreview(textOf(item)) })),
      }
    })
}

function parseIdList(value: unknown, label: string): string[] {
  if (!Array.isArray(value) || value.length === 0) throw new Error(`请提供${label}。`)
  if (value.length > ARCHIVE_BATCH) throw new Error(`单次最多归档 ${ARCHIVE_BATCH} 条。`)
  const ids = value.map(item => {
    if (typeof item !== 'string' || !item.trim()) throw new Error(`${label}无效。`)
    return item.trim()
  })
  if (new Set(ids).size !== ids.length) throw new Error(`${label}不能重复。`)
  return ids
}

export class SqlTemplateStore {
  #upgradeSource?: { path: string; version: number }
  readonly path: string
  readonly legacyPath: string
  #file?: KnowledgeFile
  #fingerprintIndex = new Map<string, string>()
  #parseQueue: Promise<void> = Promise.resolve()
  #enrichments = new Map<string, { receipt: SqlTemplate; task: Promise<SqlTemplate | undefined> }>()
  constructor(root: string) {
    this.path = join(root, 'knowledge.json')
    this.legacyPath = join(root, 'sql-templates.json')
  }

  searchKnowledge(sourceId: DataSourceId, connectionId: string, query = ''): KnowledgeItem[] {
    const needle = query.trim().toLocaleLowerCase()
    return this.ensure().commands.filter(item => !item.archived && item.sourceId === sourceId && item.connectionId === connectionId
      && (!needle || [item.title, item.summary, item.text, ...item.tags].some(value => value.toLocaleLowerCase().includes(needle))))
      .map(item => ({ ...item, tags: [...item.tags], archiveGuard: archiveGuard(item) }))
  }

  getKnowledge(sourceId: DataSourceId, id: string, connectionId: string): KnowledgeItem | undefined {
    const item = this.ensure().commands.find(row => row.sourceId === sourceId && row.id === id && row.connectionId === connectionId && !row.archived)
    return item ? { ...item, tags: [...item.tags], archiveGuard: archiveGuard(item) } : undefined
  }

  previewKnowledge(sourceId: DataSourceId, text: string) {
    const { fingerprint, ...analysis } = knowledgePolicies.get(sourceId).analyze(text)
    return { fingerprint, analysis, similar: [] as KnowledgeItem[] }
  }

  publishKnowledge(input: { sourceId: DataSourceId; connectionId: string; text: string; title?: string; summary?: string; tags?: string[]; id?: string; expectedVersion?: number }): KnowledgeItem {
    const connectionId = input.connectionId.trim()
    if (!connectionId) throw new Error('请提供 connectionId。')
    const analysis = knowledgePolicies.get(input.sourceId).analyze(input.text)
    const { fingerprint, operation } = analysis
    const file = structuredClone(this.ensure())
    const current = input.id ? file.commands.find(item => item.id === input.id && item.sourceId === input.sourceId && item.connectionId === connectionId && !item.archived) : file.commands.find(item => item.sourceId === input.sourceId && item.connectionId === connectionId && item.fingerprint === fingerprint && !item.archived)
    if (input.id && !current) throw new Error('知识条目不存在。')
    if (input.expectedVersion !== undefined && current?.version !== input.expectedVersion) throw new Error('知识条目已更新，请刷新后再保存。')
    if (!current && file.commands.length + file.templates.length >= MAX_TEMPLATES) throw new Error('知识条目数量已达上限。')
    const item: KnowledgeItem = {
      id: current?.id || randomUUID(), familyId: current?.familyId || randomUUID(), sourceId: input.sourceId, connectionId,
      text: input.text.trim(), title: clipText(input.title, `${operation} 操作`), summary: clipText(input.summary, `${operation} 操作`),
      tags: clipTags(input.tags), fingerprint, version: current ? current.version + 1 : 1, archived: false,
      updatedAt: new Date().toISOString(), analysis: { operation, risk: analysis.risk, semantic: analysis.semantic },
    }
    if (current) Object.assign(current, item)
    else file.commands.push(item)
    this.#commit(file)
    return { ...item, tags: [...item.tags], archiveGuard: archiveGuard(item) }
  }

  archiveKnowledge(sourceId: DataSourceId, id: string, connectionId: string, guard?: unknown): { ok: true } {
    const file = structuredClone(this.ensure())
    const item = file.commands.find(row => row.sourceId === sourceId && row.id === id && row.connectionId === connectionId && !row.archived)
    if (!item) throw new Error('知识条目不存在。')
    assertArchiveGuard(item, guard)
    item.archived = true
    item.updatedAt = new Date().toISOString()
    this.#commit(file)
    return { ok: true }
  }

  clusterKnowledge(sourceId: DataSourceId, connectionId: string): KnowledgeClusterGroup[] {
    return clusterGroups(this.searchKnowledge(sourceId, connectionId), item => item.text)
  }

  archiveKnowledgeDuplicates(sourceId: DataSourceId, connectionId: string, keepId: string, ids: string[], guards?: unknown): { ok: true; archived: string[] } {
    const list = parseIdList(ids, '归档列表')
    const expected = parseArchiveTargets(guards, [keepId, ...list])
    const keep = this.getKnowledge(sourceId, keepId, connectionId)
    if (!keep) throw new Error('保留的知识条目不存在。')
    assertArchiveGuard(keep, expected.get(keepId))
    if (list.includes(keepId)) throw new Error('不能归档保留条目。')
    const file = structuredClone(this.ensure())
    const archived: string[] = []
    for (const id of list) {
      const item = file.commands.find(row => row.sourceId === sourceId && row.id === id && row.connectionId === connectionId && !row.archived)
      if (!item) throw new Error('待归档知识条目不存在。')
      assertArchiveGuard(item, expected.get(id))
      if (item.fingerprint !== keep.fingerprint) throw new Error('只能归档同一指纹的重复经验。')
      item.archived = true
      item.updatedAt = new Date().toISOString()
      archived.push(id)
    }
    this.#commit(file)
    return { ok: true, archived }
  }

  list(): SqlTemplate[] {
    return this.ensure().templates.map(item => ({ ...item, tags: [...item.tags], archiveGuard: archiveGuard(item) }))
  }

  get(id: string, publishedOnly = false): SqlTemplate | undefined {
    const item = this.ensure().templates.find(row => row.id === id)
    if (!item || item.archived || (publishedOnly && item.unpublished)) return undefined
    return { ...item, tags: [...item.tags], archiveGuard: archiveGuard(item) }
  }

  search(query: string, dialect?: string, connectionId?: string): SqlTemplate[] {
    return searchTemplates(query, latestPublishedByFamily(this.ensure().templates), dialect, connectionId).map(item => ({ ...item, tags: [...item.tags], archiveGuard: archiveGuard(item) }))
  }

  archive(id: string, expectedVersion: number, guard?: unknown): { ok: true; archived: string[] } {
    const file = structuredClone(this.ensure())
    const item = this.#need(id, file)
    if (!Number.isInteger(expectedVersion)) throw new Error('删除模板需要提供已查看的版本，请刷新后重试。')
    this.#assertVersion(item, expectedVersion, file)
    assertArchiveGuard(item, guard)
    const archived = this.#archiveLineage(file, item)
    this.#commit(file)
    return { ok: true, archived }
  }

  #archiveLineage(file: KnowledgeFile, target: SqlTemplate): string[] {
    const archived: string[] = []
    for (const item of file.templates) if (sameTemplateLineage(item, target)) {
      item.archived = true; item.updatedAt = new Date().toISOString(); archived.push(item.id)
    }
    return archived
  }

  clusterPublished(connectionId: string, dialect?: string): KnowledgeClusterGroup[] {
    const published = latestPublishedByFamily(this.ensure().templates)
      .filter(item => item.connectionId === connectionId && (!dialect || item.dialect === 'any' || item.dialect === dialect))
    return clusterGroups(published, item => item.originalSql)
  }

  async annotateSql(input: {
    id: string
    connectionId: string
    sql: string
    title: string
    summary?: string
    tags?: string[]
    expectedVersion?: number
  }): Promise<SqlTemplate> {
    const current = this.get(input.id, true)
    if (!current || current.connectionId !== input.connectionId) throw new Error('模板不属于此连接。')
    const dialect = dialectOf(current)
    if (!sameSqlExperience(current.originalSql, input.sql, dialect)) {
      throw new Error('整理只能加注释和格式化，不能改查询条件、表或列。')
    }
    return this.publish({
      sql: formatSqlExperience(input.sql, dialect),
      dialect,
      connectionId: input.connectionId,
      title: input.title,
      summary: input.summary,
      tags: input.tags,
      action: 'newVersion',
      targetId: input.id,
      expectedVersion: input.expectedVersion,
    })
  }

  libraryCount(connectionId: string, sourceId: DataSourceId): number {
    if (sourceId === 'mysql' || sourceId === 'oracle') {
      return latestPublishedByFamily(this.ensure().templates)
        .filter(item => item.connectionId === connectionId && (item.dialect === sourceId || item.dialect === 'any')).length
    }
    if (sourceId === 'redis' || sourceId === 'kafka') return this.searchKnowledge(sourceId, connectionId).length
    return 0
  }

  getTidy(connectionId: string): KnowledgeTidyBatch | undefined {
    const batch = this.ensure().tidies.find(item => item.connectionId === connectionId)
    return batch ? structuredClone(batch) : undefined
  }

  proposeTidy(input: { connectionId: string; sourceId: DataSourceId; changes: unknown }): KnowledgeTidyBatch {
    const connectionId = input.connectionId.trim()
    if (!connectionId) throw new Error('请提供 connectionId。')
    if (input.sourceId === 'nacos') throw new Error('Nacos 没有经验库。')
    const batch = buildTidyBatch({
      connectionId,
      sourceId: input.sourceId,
      proposals: parseTidyProposals(input.changes),
      lookup: id => this.#tidySubject(id),
      prepare: (current, sql) => this.#prepareTidyText(input.sourceId, current, sql),
    })
    const file = structuredClone(this.ensure())
    file.tidies = [...file.tidies.filter(item => item.connectionId !== connectionId), batch]
    if (file.tidies.length > MAX_TIDY_BATCHES) throw new Error('待审批整理批次数量已达上限。')
    this.#commit(file)
    return structuredClone(batch)
  }

  #needTidy(connectionId: string, batchId: string, file = this.ensure()): KnowledgeTidyBatch {
    const batch = file.tidies.find(item => item.connectionId === connectionId)
    if (!batchId || !batch || batch.id !== batchId) throw new Error('整理提案已变化，请刷新后重新审批。')
    return batch
  }

  async applyTidy(connectionId: string, batchId: string, ids?: string[]): Promise<{ applied: string[]; failed: { id: string; message: string }[]; remaining: number }> {
    const batch = structuredClone(this.#needTidy(connectionId, batchId))
    const wanted = ids?.length ? ids : batch.changes.map(change => change.id)
    const applied: string[] = []
    const failed: { id: string; message: string }[] = []
    for (const id of wanted) {
      const change = batch.changes.find(item => item.id === id)
      if (!change) { failed.push({ id, message: '待审批变更不存在。' }); continue }
      try {
        await this.#applyTidyChange(connectionId, batchId, batch.sourceId, change)
        applied.push(id)
      } catch (error) {
        failed.push({ id, message: error instanceof Error ? error.message : '审批失败。' })
      }
    }
    return { applied, failed, remaining: this.getTidy(connectionId)?.changes.length || 0 }
  }

  rejectTidy(connectionId: string, batchId: string, ids?: string[]): { remaining: number } {
    const batch = this.#needTidy(connectionId, batchId)
    if (ids?.length) {
      const known = new Set(batch.changes.map(change => change.id))
      if (ids.some(id => !known.has(id))) throw new Error('待审批变更不存在。')
    }
    const file = structuredClone(this.ensure())
    this.#dropTidy(file, connectionId, ids?.length ? ids : batch.changes.map(change => change.id))
    this.#commit(file)
    return { remaining: this.getTidy(connectionId)?.changes.length || 0 }
  }

  archiveDuplicates(connectionId: string, keepId: string, ids: string[], dialect?: DialectKind, guards?: unknown): { ok: true; archived: string[] } {
    const list = parseIdList(ids, '归档列表')
    const expected = parseArchiveTargets(guards, [keepId, ...list])
    const keep = this.get(keepId, true)
    if (!keep || keep.connectionId !== connectionId) throw new Error('保留的经验不存在。')
    const target = { connectionId, dialect: dialect || dialectOf(keep) }
    this.#assertTarget(keep, target)
    if (list.includes(keepId)) throw new Error('不能归档保留条目。')
    const file = structuredClone(this.ensure())
    const archived: string[] = []
    this.#assertVersion(this.#need(keepId, file), expected.get(keepId)!.expectedVersion, file)
    assertArchiveGuard(this.#need(keepId, file), expected.get(keepId))
    for (const id of list) {
      const item = file.templates.find(row => row.id === id && !row.archived && !row.unpublished)
      if (!item || item.connectionId !== connectionId) throw new Error('待归档经验不存在。')
      this.#assertTarget(item, target)
      this.#assertVersion(item, expected.get(id)!.expectedVersion, file)
      assertArchiveGuard(item, expected.get(id))
      if (sameTemplateLineage(item, keep)) throw new Error('不能归档保留条目的版本链。')
      if (item.fingerprint !== keep.fingerprint) throw new Error('只能归档同一指纹的重复经验。')
      archived.push(...this.#archiveLineage(file, item))
    }
    this.#commit(file)
    return { ok: true, archived }
  }

  searchSummaries(query: string, dialect?: string, connectionId?: string): SqlTemplateSummary[] {
    return this.search(query, dialect, connectionId).map(({ originalSql: _o, normalizedSql: _n, ...rest }) => rest)
  }

  async whenIdle(): Promise<void> {
    await this.#parseQueue
  }

  async preview(sql: string, dialect: DialectKind, connectionId?: string) {
    const draft = await normalizeSqlExperience(sql, dialect)
    const published = latestPublishedByFamily(this.ensure().templates)
      .filter(item => (!connectionId || item.connectionId === connectionId) && item.dialect === dialect && !item.lineageAmbiguous)
    return { draft, similar: similarTemplates(draft, published) }
  }

  async publishFromSql(input: {
    sql: string
    dialect: DialectKind
    connectionId: string
    title: string
    summary?: string
    tags?: string[]
  }): Promise<{ id: string; title: string; merged: boolean; version: number; archiveGuard: KnowledgeArchiveGuard }> {
    const connectionId = input.connectionId?.trim()
    if (!connectionId) throw new Error('请提供 connectionId。')
    const draft = draftSqlExperience(input.sql, input.dialect)
    const published = latestPublishedByFamily(this.ensure().templates)
      .filter(item => item.connectionId === connectionId && item.dialect === input.dialect && !item.lineageAmbiguous)
    const exact = similarTemplates(draft, published).find(hit => hit.score >= 0.97)
    const saved = await this.publish({
      sql: input.sql,
      dialect: input.dialect,
      connectionId,
      title: input.title,
      summary: input.summary,
      tags: input.tags,
      action: exact ? 'mergeMeta' : 'create',
      targetId: exact?.id,
    })
    const receipt = await this.#settlePublishedReceipt(saved)
    return { id: receipt.id, title: receipt.title, merged: !!exact, version: receipt.version, archiveGuard: archiveGuard(receipt) }
  }

  async ingestUnpublished(sqls: string[], dialect: DialectKind): Promise<void> {
    const file = structuredClone(this.ensure())
    const ids: string[] = []
    for (const sql of sqls.slice(0, 20)) {
      try {
        const draft = draftSqlExperience(sql, dialect)
        if (file.templates.some(item => item.fingerprint === draft.fingerprint || item.normalizedSql === draft.normalizedSql)) continue
        const item = this.#fromDraft(draft, dialect, { unpublished: true, title: draft.suggestedTitle, summary: draft.suggestedSummary, tags: draft.suggestedTags })
        file.templates.push(item)
        ids.push(item.id)
      } catch { /* skip invalid leftover sql */ }
    }
    this.#commit(file)
    for (const id of ids) this.#scheduleEnrich(id)
  }

  async publish(input: {
    sql: string
    dialect: DialectKind
    connectionId?: string
    title?: string
    summary?: string
    tags?: string[]
    action: 'create' | 'newVersion' | 'variant' | 'mergeMeta' | 'useExisting'
    targetId?: string
    expectedVersion?: number
    expectedSnapshot?: unknown
    variant?: string
  }): Promise<SqlTemplate> {
    let file = structuredClone(this.ensure())
    if (file.templates.length >= MAX_TEMPLATES && input.action === 'create') throw new Error('经验模板数量已达上限。')
    if (input.action === 'useExisting') {
      const current = this.#need(input.targetId, file)
      this.#assertTarget(current, input)
      this.#assertVersion(current, input.expectedVersion, file, input.expectedSnapshot)
      this.#touch(current)
      this.#commit(file)
      return { ...current, tags: [...current.tags], archiveGuard: archiveGuard(current) }
    }
    const needsParsed = input.action === 'newVersion' || input.action === 'variant'
    const draft = needsParsed
      ? await normalizeSqlExperience(input.sql, input.dialect)
      : draftSqlExperience(input.sql, input.dialect)
    // Parsing yields: base the commit on the latest authoritative snapshot.
    file = structuredClone(this.ensure())
    if (file.templates.length + file.commands.length >= MAX_TEMPLATES && ['create', 'variant', 'newVersion'].includes(input.action)) throw new Error('经验模板数量已达上限。')
    const title = clipText(input.title, draft.suggestedTitle)
    const summary = clipText(input.summary, draft.suggestedSummary)
    const tags = clipTags(input.tags).length ? clipTags(input.tags) : draft.suggestedTags
    const meta = { title, summary, tags }
    if (input.action === 'create') {
      const exact = this.#findExactPublished(draft, input.dialect, input.connectionId, file)
      if (exact) {
        if (input.title?.trim()) exact.title = title
        if (input.summary?.trim() || draft.suggestedSummary) exact.summary = summary
        exact.tags = clipTags([...exact.tags, ...tags])
        exact.unpublished = false
        exact.updatedAt = new Date().toISOString()
        this.#touch(exact)
        this.#commit(file)
        if (!exact.features.parseOk) this.#scheduleEnrich(exact.id)
        return { ...exact, tags: [...exact.tags], archiveGuard: archiveGuard(exact) }
      }
    }
    if (input.action === 'mergeMeta') {
      const current = this.#need(input.targetId, file)
      this.#assertTarget(current, input)
      this.#assertVersion(current, input.expectedVersion, file, input.expectedSnapshot)
      if (input.title?.trim()) current.title = title
      if (input.summary?.trim()) current.summary = summary
      current.tags = clipTags([...current.tags, ...tags])
      current.unpublished = false
      current.updatedAt = new Date().toISOString()
      this.#commit(file)
      if (!current.features.parseOk) this.#scheduleEnrich(current.id)
      return { ...current, tags: [...current.tags], archiveGuard: archiveGuard(current) }
    }
    const current = input.action === 'create' ? undefined : this.#need(input.targetId, file)
    if (current) { this.#assertTarget(current, input); this.#assertVersion(current, input.expectedVersion, file, input.expectedSnapshot) }
    if (input.action === 'newVersion' && current && !draft.features.parseOk && current.fingerprint !== draft.fingerprint) {
      throw new Error('未解析成功的 SQL 不能覆盖已有模板正文，请选择新建。')
    }
    const next = this.#fromDraft(draft, input.dialect, {
      ...meta,
      connectionId: input.connectionId || current?.connectionId,
      familyId: current?.familyId,
      lineageId: input.action === 'newVersion' ? current?.lineageId : undefined,
      variant: input.action === 'variant' ? clipText(input.variant, input.dialect) : current?.variant,
      version: input.action === 'newVersion' && current ? lineageHead(file.templates, current)!.version + 1 : 1,
    })
    file.templates.push(next)
    this.#commit(file)
    if (!next.features.parseOk) this.#scheduleEnrich(next.id)
    return { ...next, tags: [...next.tags], archiveGuard: archiveGuard(next) }
  }

  async dispatch(body: Record<string, unknown>): Promise<unknown> {
    const action = String(body.action || '')
    const dialect = legacyDataSourceId(body.dialect)
    if (action === 'template-search') {
      const connectionId = typeof body.connectionId === 'string' && body.connectionId.trim() ? body.connectionId.trim() : undefined
      if (!connectionId) return { items: [] }
      return { items: this.searchSummaries(String(body.query || ''), typeof body.dialect === 'string' ? body.dialect : undefined, connectionId) }
    }
    if (action === 'template-get' && typeof body.id === 'string') {
      const item = this.get(body.id, true)
      if (!item) throw new Error('模板不存在、未发布或已归档。')
      return item
    }
    if (action === 'template-preview') {
      if (typeof body.sql !== 'string') throw new Error('请提供 SQL。')
      const connectionId = typeof body.connectionId === 'string' && body.connectionId.trim() ? body.connectionId.trim() : undefined
      return this.preview(body.sql, dialect, connectionId)
    }
    if (action === 'template-archive' && typeof body.id === 'string') {
      const item = this.#need(body.id)
      this.#assertTarget(item, { connectionId: typeof body.connectionId === 'string' ? body.connectionId : undefined, dialect })
      return this.archive(body.id, (body.archiveGuard as KnowledgeArchiveGuard)?.expectedVersion, body.archiveGuard)
    }
    if (action === 'template-tidy-get' || action === 'template-tidy-apply' || action === 'template-tidy-reject') {
      const connectionId = typeof body.connectionId === 'string' ? body.connectionId.trim() : ''
      if (!connectionId) throw new Error('请提供 connectionId。')
      if (action === 'template-tidy-get') return { tidy: this.getTidy(connectionId) ?? null }
      const ids = Array.isArray(body.ids) ? body.ids.filter((item): item is string => typeof item === 'string') : undefined
      const batchId = typeof body.batchId === 'string' ? body.batchId : ''
      if (action === 'template-tidy-reject') return this.rejectTidy(connectionId, batchId, ids)
      return this.applyTidy(connectionId, batchId, ids)
    }
    if (action === 'template-cluster') {
      const connectionId = typeof body.connectionId === 'string' && body.connectionId.trim() ? body.connectionId.trim() : ''
      if (!connectionId) return { groups: [] }
      return { groups: this.clusterPublished(connectionId, typeof body.dialect === 'string' ? body.dialect : undefined) }
    }
    if (action === 'template-annotate') {
      const connectionId = typeof body.connectionId === 'string' && body.connectionId.trim() ? body.connectionId.trim() : ''
      if (!connectionId) throw new Error('请提供 connectionId。')
      if (typeof body.id !== 'string' || !body.id.trim()) throw new Error('请提供 id。')
      if (typeof body.sql !== 'string' || !body.sql.trim()) throw new Error('请提供 SQL。')
      if (typeof body.title !== 'string' || !body.title.trim()) throw new Error('请提供标题。')
      this.#assertTarget(this.#need(body.id), { connectionId, dialect })
      return this.annotateSql({
        id: body.id,
        connectionId,
        sql: body.sql,
        title: body.title,
        summary: typeof body.summary === 'string' ? body.summary : undefined,
        tags: Array.isArray(body.tags) ? body.tags as string[] : undefined,
        expectedVersion: typeof body.expectedVersion === 'number' ? body.expectedVersion : undefined,
      })
    }
    if (action === 'template-archive-duplicates') {
      const connectionId = typeof body.connectionId === 'string' && body.connectionId.trim() ? body.connectionId.trim() : ''
      if (!connectionId) throw new Error('请提供 connectionId。')
      if (typeof body.keepId !== 'string' || !body.keepId.trim()) throw new Error('请提供 keepId。')
      return this.archiveDuplicates(connectionId, body.keepId.trim(), Array.isArray(body.ids) ? body.ids as string[] : [], dialect, body.guards)
    }
    if (action === 'template-publish') {
      const publishAction = body.publishAction
      const connectionId = typeof body.connectionId === 'string' && body.connectionId.trim() ? body.connectionId.trim() : undefined
      if (!connectionId) throw new Error('请提供 connectionId。')
      if (publishAction === 'fromSql') {
        return this.publishFromSql({
          sql: String(body.sql || ''),
          dialect,
          connectionId,
          title: typeof body.title === 'string' ? body.title : '',
          summary: typeof body.summary === 'string' ? body.summary : undefined,
          tags: Array.isArray(body.tags) ? body.tags as string[] : undefined,
        })
      }
      const saved = await this.publish({
        sql: String(body.sql || ''),
        dialect,
        connectionId,
        title: typeof body.title === 'string' ? body.title : undefined,
        summary: typeof body.summary === 'string' ? body.summary : undefined,
        tags: Array.isArray(body.tags) ? body.tags as string[] : undefined,
        action: publishAction === 'newVersion' || publishAction === 'variant' || publishAction === 'mergeMeta' || publishAction === 'useExisting' ? publishAction : 'create',
        targetId: typeof body.targetId === 'string' ? body.targetId : undefined,
        expectedVersion: typeof body.expectedVersion === 'number' ? body.expectedVersion : undefined,
        expectedSnapshot: body.expectedSnapshot,
        variant: typeof body.variant === 'string' ? body.variant : undefined,
      })
      // Persistence remains immediate. The API receipt includes our own asynchronous metadata
      // enrichment, but must never adopt a concurrent author's change as this editor's baseline.
      const receipt = await this.#settlePublishedReceipt(saved)
      return { ...receipt, archiveGuard: archiveGuard(receipt) }
    }
    throw new Error('不支持此模板操作。')
  }

  #tidySubject(id: string, file = this.ensure()): TidySubject | undefined {
    const sql = file.templates.find(item => item.id === id && !item.archived && !item.unpublished)
    if (sql && sql.dialect !== 'any' && sql.connectionId) return {
      id: sql.id, connectionId: sql.connectionId, sourceId: sql.dialect, version: sql.version,
      title: sql.title, summary: sql.summary, tags: [...sql.tags], text: sql.originalSql,
    }
    const command = file.commands.find(item => item.id === id && !item.archived)
    if (!command) return
    return {
      id: command.id, connectionId: command.connectionId, sourceId: command.sourceId, version: command.version,
      title: command.title, summary: command.summary, tags: [...command.tags], text: command.text,
    }
  }

  #prepareTidyText(sourceId: DataSourceId, current: TidySubject, sql: string | undefined): { text: string; risk: KnowledgeTidyRisk } {
    if (sourceId === 'mysql' || sourceId === 'oracle') {
      const text = (sql === undefined ? current.text : sql).slice(0, 32768)
      if (!text.trim()) throw new Error('请提供 SQL。')
      return { text, risk: sameSqlExperience(current.text, text, sourceId) ? 'same' : 'executable-changed' }
    }
    const text = (sql === undefined ? current.text : sql).trim().slice(0, 65536)
    if (!text.trim()) throw new Error('请提供命令。')
    const policy = knowledgePolicies.get(sourceId)
    const before = policy.analyze(current.text).fingerprint
    const after = policy.analyze(text).fingerprint
    return { text, risk: before === after ? 'same' : 'executable-changed' }
  }

  async #applyTidyChange(connectionId: string, batchId: string, sourceId: DataSourceId, change: KnowledgeTidyChange): Promise<void> {
    const sql = sourceId === 'mysql' || sourceId === 'oracle'
    const after = change.after
    if (change.kind === 'update' && !after) throw new Error('整理提案缺少新内容。')
    // Parsing may yield. Validate every subject and the proposal again on the latest snapshot below.
    const draft = sql && after && after.text !== change.before.text
      ? await normalizeSqlExperience(after.text, sourceId) : undefined
    const analysis = !sql && after ? knowledgePolicies.get(sourceId).analyze(after.text) : undefined
    const file = structuredClone(this.ensure())
    const batch = this.#needTidy(connectionId, batchId, file)
    if (!batch.changes.some(row => row.id === change.id)) throw new Error('这条整理已审批，请刷新。')
    const targets = [{ id: change.id, expectedVersion: change.expectedVersion, before: change.before }, ...(change.archiveTargets || [])]
    for (const target of targets) {
      const current = this.#tidySubject(target.id, file)
      const before = target.before
      if (!current || current.connectionId !== connectionId || current.sourceId !== sourceId
        || current.version !== target.expectedVersion || current.text !== before.text
        || current.title !== before.title || current.summary !== before.summary
        || JSON.stringify(current.tags) !== JSON.stringify(before.tags)) {
        throw new Error('经验已被其他人更新或归档，请重新查看差异后再保存。')
      }
      const template = sql ? file.templates.find(row => row.id === target.id)! : undefined
      if (template?.lineageAmbiguous) throw new Error('历史版本关系不明确，请另存为新模板。')
      if (template && !isWritableLineageHead(file.templates, template)) {
        throw new Error('模板已被其他人更新，请重新查看差异后再保存。')
      }
    }
    let enrichId: string | undefined
    if (change.kind === 'update' && after) {
      if (sql) {
        const item = file.templates.find(row => row.id === change.id)!
        if (draft) {
          if (file.templates.length + file.commands.length >= MAX_TEMPLATES) throw new Error('经验模板数量已达上限。')
          if (!draft.features.parseOk && item.fingerprint !== draft.fingerprint) throw new Error('未解析成功的 SQL 不能覆盖已有模板正文，请选择新建。')
          const next = this.#fromDraft(draft, sourceId, { ...after, connectionId, familyId: item.familyId, lineageId: item.lineageId, variant: item.variant, version: lineageHead(file.templates, item)!.version + 1 })
          file.templates.push(next)
          if (!next.features.parseOk) enrichId = next.id
        } else {
          Object.assign(item, { title: after.title, summary: after.summary, tags: [...after.tags], updatedAt: new Date().toISOString() })
          if (!item.features.parseOk) enrichId = item.id
        }
      } else {
        const item = file.commands.find(row => row.id === change.id)!
        Object.assign(item, { ...after, tags: [...after.tags], fingerprint: analysis!.fingerprint, version: item.version + 1,
          updatedAt: new Date().toISOString(), analysis: { operation: analysis!.operation, risk: analysis!.risk, semantic: analysis!.semantic } })
      }
    }
    const archiveIds = new Set([...(change.kind === 'archive' ? [change.id] : []), ...(change.archiveTargets || []).map(target => target.id)])
    if (sql && change.kind === 'update') {
      const keep = this.#need(change.id, file)
      if ([...archiveIds].some(id => sameTemplateLineage(this.#need(id, file), keep))) throw new Error('不能归档保留条目的版本链。')
    }
    for (const item of sql ? file.templates : file.commands) {
      if (archiveIds.has(item.id)) {
        if (sql) this.#archiveLineage(file, item as SqlTemplate)
        else { item.archived = true; item.updatedAt = new Date().toISOString() }
      }
    }
    // Published content, all archives and removal of the approved proposal share one durable commit.
    this.#dropTidy(file, connectionId, [change.id])
    this.#commit(file)
    if (enrichId) this.#scheduleEnrich(enrichId)
  }

  #dropTidy(file: KnowledgeFile, connectionId: string, ids: string[]): void {
    const batch = file.tidies.find(item => item.connectionId === connectionId)
    if (!batch) return
    const drop = new Set(ids)
    batch.changes = batch.changes.filter(change => !drop.has(change.id))
    if (!batch.changes.length) file.tidies = file.tidies.filter(item => item.connectionId !== connectionId)
  }

  #need(id: string | undefined, file = this.ensure()): SqlTemplate {
    const current = file.templates.find(row => row.id === id)
    if (!current) throw new Error('目标模板不存在。')
    return current
  }

  #assertTarget(current: SqlTemplate, input: { connectionId?: string; dialect: DialectKind }): void {
    if (!input.connectionId || current.connectionId !== input.connectionId) throw new Error('模板不属于此连接。')
    if (current.dialect !== input.dialect) throw new Error('数据源与目标模板不匹配。')
  }

  #assertVersion(current: SqlTemplate, expected: number | undefined, file: KnowledgeFile, snapshot?: unknown): void {
    if (current.lineageAmbiguous) throw new Error('历史版本关系不明确，请另存为新模板。')
    const before = snapshot as KnowledgeTidyChange['before'] | undefined
    if (!isWritableLineageHead(file.templates, current) || expected !== undefined && expected !== current.version
      || snapshot !== undefined && (!before || before.text !== current.originalSql || before.title !== current.title
        || before.summary !== current.summary || JSON.stringify(before.tags) !== JSON.stringify(current.tags))) {
      throw new Error('模板已被其他人更新或归档，请重新查看差异后再保存。')
    }
  }

  #touch(current: SqlTemplate): void {
    current.usageCount += 1
    current.updatedAt = new Date().toISOString()
  }

  #fromDraft(draft: NormalizedTemplate, dialect: DialectKind, extra: { title: string; summary: string; tags: string[]; connectionId?: string; unpublished?: boolean; familyId?: string; lineageId?: string; variant?: string; version?: number }): SqlTemplate {
    const id = randomUUID()
    return {
      id,
      familyId: extra.familyId || randomUUID(),
      lineageId: extra.lineageId || id,
      version: extra.version || 1,
      variant: extra.variant || dialect,
      dialect,
      ...(extra.connectionId ? { connectionId: extra.connectionId.slice(0, 160) } : {}),
      title: extra.title.slice(0, TEXT),
      summary: extra.summary.slice(0, TEXT),
      tags: extra.tags,
      originalSql: draft.originalSql,
      normalizedSql: draft.normalizedSql,
      fingerprint: draft.fingerprint,
      features: draft.features,
      unpublished: extra.unpublished,
      archived: false,
      usageCount: 0,
      updatedAt: new Date().toISOString(),
    }
  }

  ensure(): KnowledgeFile {
    if (this.#file) return this.#file
    const source = existsSync(this.path) ? this.path : this.legacyPath
    if (!existsSync(source)) {
      this.#file = { templates: [], commands: [], tidies: [] }
      return this.#file
    }
    try {
      const parsed = JSON.parse(readFileSync(source, 'utf8')) as { version?: number; templates?: SqlTemplate[]; commands?: KnowledgeItem[]; tidies?: unknown }
      if (!((source === this.legacyPath && parsed.version === 1) || (source === this.path && (parsed.version === 2 || parsed.version === 3))) || !Array.isArray(parsed.templates) || parsed.templates.length > MAX_TEMPLATES || (parsed.commands && !Array.isArray(parsed.commands))) throw new Error()
      const templates = parsed.templates.map(sanitizeStoredTemplate)
      if (parsed.version !== 3) {
        restoreTemplateLineages(templates)
        this.#upgradeSource = { path: source, version: parsed.version! }
      } else if (templates.some(item => !item.lineageId)) throw new Error()
      markAmbiguousLineages(templates)
      this.#file = { templates, commands: (parsed.commands || []).map(sanitizeStoredKnowledgeItem), tidies: sanitizeTidies(parsed.tidies) }
      this.#rebuildIndex()
      return this.#file
    } catch {
      throw new Error('SQL 经验库无法读取，原文件已保留。')
    }
  }

  #commit(file: KnowledgeFile): void {
    const next = { templates: file.templates, commands: file.commands, tidies: file.tidies || [] }
    if (this.#upgradeSource) {
      const source = this.#upgradeSource
      // Exclusive backup: never replace the original upgrade evidence on retries.
      const backup = `${this.path}.v${source.version}.bak`
      try { copyFileSync(source.path, backup, constants.COPYFILE_EXCL) }
      catch (error) {
        if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error
        if (!readFileSync(backup).equals(readFileSync(source.path))) throw new Error('旧经验库备份与原文件不一致，原文件已保留。')
      }
    }
    writeJsonFile(this.path, { version: 3, ...next })
    this.#upgradeSource = undefined
    this.#file = next
    this.#rebuildIndex()
  }

  #rebuildIndex(): void {
    this.#fingerprintIndex.clear()
    for (const item of latestPublishedByFamily(this.ensure().templates)) {
      if (item.archived || item.unpublished || item.lineageAmbiguous || !item.fingerprint) continue
      const key = `${item.connectionId || ''}:${item.dialect}:${item.fingerprint}`
      const current = this.#fingerprintIndex.get(key)
      if (!current) this.#fingerprintIndex.set(key, item.id)
      else {
        const prev = this.ensure().templates.find(row => row.id === current)
        if (prev && item.version >= prev.version) this.#fingerprintIndex.set(key, item.id)
      }
    }
  }

  #findExactPublished(draft: NormalizedTemplate, dialect: DialectKind, connectionId: string | undefined, file = this.ensure()): SqlTemplate | undefined {
    const key = `${connectionId || ''}:${dialect}:${draft.fingerprint}`
    const id = this.#fingerprintIndex.get(key)
    const byId = id ? file.templates.find(row => row.id === id && !row.unpublished && !row.archived) : undefined
    if (byId) return byId
    return latestPublishedByFamily(file.templates).find(item =>
      !item.unpublished && !item.archived && !item.lineageAmbiguous && item.dialect === dialect
      && (!connectionId || item.connectionId === connectionId)
      && (item.fingerprint === draft.fingerprint || item.normalizedSql === draft.normalizedSql),
    )
  }

  async #settlePublishedReceipt(saved: SqlTemplate): Promise<SqlTemplate> {
    const enrichment = this.#enrichments.get(saved.id)
    return enrichment && sameTemplateContent(saved, enrichment.receipt) ? await enrichment.task || saved : saved
  }

  #scheduleEnrich(id: string): void {
    const receipt = structuredClone(this.ensure().templates.find(item => item.id === id)!)
    const task = this.#parseQueue.then(() => this.#enrich(id, receipt)).catch(() => undefined)
    this.#enrichments.set(id, { receipt, task })
    this.#parseQueue = task.then(() => {})
  }

  async #enrich(id: string, receipt: SqlTemplate): Promise<SqlTemplate | undefined> {
    const item = this.ensure().templates.find(row => row.id === id)
    if (!item || item.archived || item.features.parseOk) return
    const dialect = dialectOf(item)
    const cheap = draftSqlExperience(item.originalSql, dialect)
    const draft = await normalizeSqlExperience(item.originalSql, dialect)
    const file = structuredClone(this.ensure())
    const current = file.templates.find(row => row.id === id)
    if (!current || current.archived || current.originalSql !== item.originalSql || current.version !== item.version) return
    current.normalizedSql = draft.normalizedSql
    current.fingerprint = draft.fingerprint
    current.features = draft.features
    const ownsMetadata = sameTemplateContent(current, receipt)
    if (ownsMetadata) {
      if (current.title === cheap.suggestedTitle) current.title = draft.suggestedTitle.slice(0, TEXT)
      if (!current.summary.trim() || current.summary === cheap.suggestedSummary || current.summary === UNPARSED_TEMPLATE_SUMMARY) current.summary = draft.suggestedSummary.slice(0, TEXT)
      current.tags = clipTags([...current.tags, ...draft.suggestedTags])
    }
    current.updatedAt = new Date().toISOString()
    this.#commit(file)
    return ownsMetadata ? structuredClone(current) : undefined
  }
}

function sanitizeTidies(value: unknown): KnowledgeTidyBatch[] {
  if (value === undefined) return []
  if (!Array.isArray(value) || value.length > MAX_TIDY_BATCHES) throw new Error()
  return value.filter(batch => batch && typeof batch === 'object' && typeof batch.id === 'string'
    && Array.isArray(batch.changes) && !batch.changes.some((change: Record<string, unknown>) => Array.isArray(change.archiveIds) && change.archiveIds.length)).map(batch => {
    if (!batch || typeof batch !== 'object' || Array.isArray(batch)) throw new Error()
    const row = batch as KnowledgeTidyBatch
    if (typeof row.connectionId !== 'string' || typeof row.sourceId !== 'string' || !Array.isArray(row.changes) || row.changes.length > TIDY_CHANGE_LIMIT) throw new Error()
    return {
      id: row.id,
      connectionId: row.connectionId.slice(0, 160),
      sourceId: row.sourceId,
      createdAt: typeof row.createdAt === 'string' ? row.createdAt : new Date().toISOString(),
      changes: row.changes.map(change => {
        if (!change || change.kind !== 'update' && change.kind !== 'archive' || typeof change.id !== 'string' || !change.before) throw new Error()
        return {
          ...change,
          id: change.id.slice(0, 160),
          before: { ...change.before, tags: [...(change.before.tags || [])] },
          ...(change.after ? { after: { ...change.after, tags: [...(change.after.tags || [])] } } : {}),
        }
      }),
    }
  })
}

function sanitizeStoredTemplate(value: SqlTemplate): SqlTemplate {
  if (!value || typeof value.id !== 'string' || typeof value.familyId !== 'string') throw new Error()
  return {
    id: value.id.slice(0, 160),
    familyId: value.familyId.slice(0, 160),
    ...(typeof value.lineageId === 'string' && value.lineageId.trim() ? { lineageId: value.lineageId.slice(0, 160) } : {}),
    ...(value.lineageAmbiguous ? { lineageAmbiguous: true } : {}),
    version: Number.isInteger(value.version) ? value.version : 1,
    variant: clipText(value.variant, 'default'),
    dialect: value.dialect === 'any' ? 'any' : legacyDataSourceId(value.dialect),
    ...(typeof value.connectionId === 'string' && value.connectionId.trim() ? { connectionId: value.connectionId.trim().slice(0, 160) } : {}),
    title: clipText(value.title, '未命名模板'),
    summary: clipText(value.summary),
    tags: clipTags(value.tags),
    originalSql: String(value.originalSql || '').slice(0, 32768),
    normalizedSql: String(value.normalizedSql || '').slice(0, 32768),
    fingerprint: String(value.fingerprint || '').slice(0, 2000),
    features: value.features && typeof value.features === 'object' ? value.features : {
      operation: 'unknown', tables: [], columns: [], conditionColumns: [], joins: [], aggregates: [], groupBy: [], orderBy: [], risk: 'unknown', parseOk: false,
    },
    unpublished: !!value.unpublished,
    archived: !!value.archived,
    usageCount: Number.isInteger(value.usageCount) ? value.usageCount : 0,
    updatedAt: typeof value.updatedAt === 'string' ? value.updatedAt : new Date().toISOString(),
  }
}

function sanitizeStoredKnowledgeItem(value: KnowledgeItem): KnowledgeItem {
  if (!value || typeof value.sourceId !== 'string' || typeof value.id !== 'string' || typeof value.connectionId !== 'string' || typeof value.text !== 'string') throw new Error()
  const analysis = knowledgePolicies.get(value.sourceId as DataSourceId).analyze(value.text)
  return {
    id: value.id.slice(0, 160), familyId: typeof value.familyId === 'string' ? value.familyId.slice(0, 160) : value.id.slice(0, 160), sourceId: value.sourceId as DataSourceId,
    connectionId: value.connectionId.slice(0, 160), text: value.text.slice(0, 65536), title: clipText(value.title, `${analysis.operation} 操作`),
    summary: clipText(value.summary), tags: clipTags(value.tags), fingerprint: analysis.fingerprint,
    version: Number.isInteger(value.version) && value.version > 0 ? value.version : 1, archived: !!value.archived,
    updatedAt: typeof value.updatedAt === 'string' ? value.updatedAt : new Date().toISOString(),
    analysis: { operation: analysis.operation, risk: analysis.risk, semantic: analysis.semantic },
  }
}


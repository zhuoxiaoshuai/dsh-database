import { randomUUID } from 'node:crypto'
import { existsSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import { draftSqlExperience, normalizeSqlExperience, type DialectKind, type NormalizedTemplate } from './sql-template-normalizer.ts'
import { legacyDataSourceId } from '../shared/data-sources/registry.ts'
import { latestPublishedByFamily, searchTemplates, similarTemplates, type TemplateIndex } from './sql-template-similarity.ts'
import { writeJsonFile } from './json-file.ts'
import { knowledgePolicies } from './knowledge-policy-registry.ts'
import type { DataSourceId } from '../shared/data-sources/types.ts'
import type { KnowledgeItem } from '../shared/knowledge.ts'

export type SqlTemplate = TemplateIndex & {
  variant: string
  dialect: DialectKind | 'any'
  connectionId?: string
  originalSql: string
}

export type SqlTemplateSummary = Omit<SqlTemplate, 'originalSql' | 'normalizedSql'>

const MAX_TEMPLATES = 500
const TEXT = 240

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

export class SqlTemplateStore {
  readonly path: string
  readonly legacyPath: string
  #file?: { templates: SqlTemplate[]; commands: KnowledgeItem[] }
  #fingerprintIndex = new Map<string, string>()
  #parseQueue: Promise<void> = Promise.resolve()
  constructor(root: string) {
    this.path = join(root, 'knowledge.json')
    this.legacyPath = join(root, 'sql-templates.json')
  }

  searchKnowledge(sourceId: DataSourceId, connectionId: string, query = ''): KnowledgeItem[] {
    const needle = query.trim().toLocaleLowerCase()
    return this.ensure().commands.filter(item => !item.archived && item.sourceId === sourceId && item.connectionId === connectionId
      && (!needle || [item.title, item.summary, item.text, ...item.tags].some(value => value.toLocaleLowerCase().includes(needle))))
      .map(item => ({ ...item, tags: [...item.tags] }))
  }

  getKnowledge(sourceId: DataSourceId, id: string, connectionId: string): KnowledgeItem | undefined {
    const item = this.ensure().commands.find(row => row.sourceId === sourceId && row.id === id && row.connectionId === connectionId && !row.archived)
    return item ? { ...item, tags: [...item.tags] } : undefined
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
    const file = this.ensure()
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
    this.#persist()
    return { ...item, tags: [...item.tags] }
  }

  archiveKnowledge(sourceId: DataSourceId, id: string, connectionId: string): { ok: true } {
    const item = this.ensure().commands.find(row => row.sourceId === sourceId && row.id === id && row.connectionId === connectionId && !row.archived)
    if (!item) throw new Error('知识条目不存在。')
    item.archived = true
    item.updatedAt = new Date().toISOString()
    this.#persist()
    return { ok: true }
  }

  list(): SqlTemplate[] {
    return this.ensure().templates.map(item => ({ ...item }))
  }

  get(id: string, publishedOnly = false): SqlTemplate | undefined {
    const item = this.ensure().templates.find(row => row.id === id)
    if (!item || item.archived || (publishedOnly && item.unpublished)) return undefined
    return { ...item }
  }

  search(query: string, dialect?: string, connectionId?: string): SqlTemplate[] {
    return searchTemplates(query, latestPublishedByFamily(this.ensure().templates.filter(item => !item.unpublished && !item.archived)), dialect, connectionId)
  }

  archive(id: string): { ok: true } {
    const item = this.#need(id)
    item.archived = true
    item.updatedAt = new Date().toISOString()
    this.#rebuildIndex()
    this.#persist()
    return { ok: true }
  }

  searchSummaries(query: string, dialect?: string, connectionId?: string): SqlTemplateSummary[] {
    return this.search(query, dialect, connectionId).map(({ originalSql: _o, normalizedSql: _n, ...rest }) => rest)
  }

  async whenIdle(): Promise<void> {
    await this.#parseQueue
  }

  async preview(sql: string, dialect: DialectKind, connectionId?: string) {
    const draft = await normalizeSqlExperience(sql, dialect)
    const published = latestPublishedByFamily(this.ensure().templates.filter(item => !item.unpublished && !item.archived))
      .filter(item => !connectionId || item.connectionId === connectionId)
    return { draft, similar: similarTemplates(draft, published) }
  }

  async publishFromSql(input: {
    sql: string
    dialect: DialectKind
    connectionId: string
    title: string
    summary?: string
    tags?: string[]
  }): Promise<{ id: string; title: string; merged: boolean; version: number }> {
    const connectionId = input.connectionId?.trim()
    if (!connectionId) throw new Error('请提供 connectionId。')
    const draft = draftSqlExperience(input.sql, input.dialect)
    const published = latestPublishedByFamily(this.ensure().templates.filter(item => !item.unpublished && !item.archived))
      .filter(item => item.connectionId === connectionId)
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
    return { id: saved.id, title: saved.title, merged: !!exact, version: saved.version }
  }

  async ingestUnpublished(sqls: string[], dialect: DialectKind): Promise<void> {
    const file = this.ensure()
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
    this.#rebuildIndex()
    this.#persist()
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
    variant?: string
  }): Promise<SqlTemplate> {
    const file = this.ensure()
    if (file.templates.length >= MAX_TEMPLATES && input.action === 'create') throw new Error('经验模板数量已达上限。')
    if (input.action === 'useExisting') {
      const current = this.#need(input.targetId)
      this.#touch(current)
      this.#persist()
      return { ...current }
    }
    const needsParsed = input.action === 'newVersion' || input.action === 'variant'
    const draft = needsParsed
      ? await normalizeSqlExperience(input.sql, input.dialect)
      : draftSqlExperience(input.sql, input.dialect)
    const title = clipText(input.title, draft.suggestedTitle)
    const summary = clipText(input.summary, draft.suggestedSummary)
    const tags = clipTags(input.tags).length ? clipTags(input.tags) : draft.suggestedTags
    const meta = { title, summary, tags }
    if (input.action === 'create') {
      const exact = this.#findExactPublished(draft, input.dialect, input.connectionId)
      if (exact) {
        if (input.title?.trim()) exact.title = title
        if (input.summary?.trim() || draft.suggestedSummary) exact.summary = summary
        exact.tags = clipTags([...exact.tags, ...tags])
        exact.unpublished = false
        exact.updatedAt = new Date().toISOString()
        this.#touch(exact)
        this.#rebuildIndex()
        this.#persist()
        if (!exact.features.parseOk) this.#scheduleEnrich(exact.id)
        return { ...exact }
      }
    }
    if (input.action === 'mergeMeta') {
      const current = this.#need(input.targetId)
      this.#assertVersion(current, input.expectedVersion)
      if (input.title?.trim()) current.title = title
      if (input.summary?.trim()) current.summary = summary
      current.tags = clipTags([...current.tags, ...tags])
      current.unpublished = false
      current.updatedAt = new Date().toISOString()
      this.#rebuildIndex()
      this.#persist()
      if (!current.features.parseOk) this.#scheduleEnrich(current.id)
      return { ...current }
    }
    const current = input.action === 'create' ? undefined : this.#need(input.targetId)
    if (current) this.#assertVersion(current, input.expectedVersion)
    if (input.action === 'newVersion' && current && !draft.features.parseOk && current.fingerprint !== draft.fingerprint) {
      throw new Error('未解析成功的 SQL 不能覆盖已有模板正文，请选择新建。')
    }
    const next = this.#fromDraft(draft, input.dialect, {
      ...meta,
      connectionId: input.connectionId || current?.connectionId,
      familyId: current?.familyId,
      variant: input.action === 'variant' ? clipText(input.variant, input.dialect) : current?.variant,
      version: input.action === 'newVersion' && current ? current.version + 1 : 1,
    })
    file.templates.push(next)
    this.#rebuildIndex()
    this.#persist()
    if (!next.features.parseOk) this.#scheduleEnrich(next.id)
    return { ...next }
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
    if (action === 'template-archive' && typeof body.id === 'string') return this.archive(body.id)
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
      return this.publish({
        sql: String(body.sql || ''),
        dialect,
        connectionId,
        title: typeof body.title === 'string' ? body.title : undefined,
        summary: typeof body.summary === 'string' ? body.summary : undefined,
        tags: Array.isArray(body.tags) ? body.tags as string[] : undefined,
        action: publishAction === 'newVersion' || publishAction === 'variant' || publishAction === 'mergeMeta' || publishAction === 'useExisting' ? publishAction : 'create',
        targetId: typeof body.targetId === 'string' ? body.targetId : undefined,
        expectedVersion: typeof body.expectedVersion === 'number' ? body.expectedVersion : undefined,
        variant: typeof body.variant === 'string' ? body.variant : undefined,
      })
    }
    throw new Error('不支持此模板操作。')
  }

  #need(id?: string): SqlTemplate {
    const current = this.ensure().templates.find(row => row.id === id)
    if (!current) throw new Error('目标模板不存在。')
    return current
  }

  #assertVersion(current: SqlTemplate, expected?: number): void {
    if (expected !== undefined && expected !== current.version) throw new Error('模板已被其他人更新，请重新查看差异后再保存。')
  }

  #touch(current: SqlTemplate): void {
    current.usageCount += 1
    current.updatedAt = new Date().toISOString()
  }

  #fromDraft(draft: NormalizedTemplate, dialect: DialectKind, extra: { title: string; summary: string; tags: string[]; connectionId?: string; unpublished?: boolean; familyId?: string; variant?: string; version?: number }): SqlTemplate {
    return {
      id: randomUUID(),
      familyId: extra.familyId || randomUUID(),
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

  ensure(): { templates: SqlTemplate[]; commands: KnowledgeItem[] } {
    if (this.#file) return this.#file
    const source = existsSync(this.path) ? this.path : this.legacyPath
    if (!existsSync(source)) {
      this.#file = { templates: [], commands: [] }
      return this.#file
    }
    try {
      const parsed = JSON.parse(readFileSync(source, 'utf8')) as { version?: number; templates?: SqlTemplate[]; commands?: KnowledgeItem[] }
      if (!((source === this.legacyPath && parsed.version === 1) || (source === this.path && parsed.version === 2)) || !Array.isArray(parsed.templates) || parsed.templates.length > MAX_TEMPLATES || (parsed.commands && !Array.isArray(parsed.commands))) throw new Error()
      this.#file = { templates: parsed.templates.map(sanitizeStoredTemplate), commands: (parsed.commands || []).map(sanitizeStoredKnowledgeItem) }
      this.#rebuildIndex()
      return this.#file
    } catch {
      throw new Error('SQL 经验库无法读取，原文件已保留。')
    }
  }

  #persist(): void {
    const file = this.ensure()
    writeJsonFile(this.path, { version: 2, templates: file.templates, commands: file.commands })
  }

  #rebuildIndex(): void {
    this.#fingerprintIndex.clear()
    for (const item of this.ensure().templates) {
      if (item.archived || item.unpublished || !item.fingerprint) continue
      const key = `${item.connectionId || ''}:${item.dialect}:${item.fingerprint}`
      const current = this.#fingerprintIndex.get(key)
      if (!current) this.#fingerprintIndex.set(key, item.id)
      else {
        const prev = this.ensure().templates.find(row => row.id === current)
        if (prev && item.version >= prev.version) this.#fingerprintIndex.set(key, item.id)
      }
    }
  }

  #findExactPublished(draft: NormalizedTemplate, dialect: DialectKind, connectionId?: string): SqlTemplate | undefined {
    const key = `${connectionId || ''}:${dialect}:${draft.fingerprint}`
    const id = this.#fingerprintIndex.get(key)
    const byId = id ? this.ensure().templates.find(row => row.id === id && !row.unpublished && !row.archived) : undefined
    if (byId) return byId
    return this.ensure().templates.find(item =>
      !item.unpublished && !item.archived && item.dialect === dialect
      && (!connectionId || item.connectionId === connectionId)
      && (item.fingerprint === draft.fingerprint || item.normalizedSql === draft.normalizedSql),
    )
  }

  #scheduleEnrich(id: string): void {
    this.#parseQueue = this.#parseQueue.then(() => this.#enrich(id)).catch(() => {})
  }

  async #enrich(id: string): Promise<void> {
    const item = this.ensure().templates.find(row => row.id === id)
    if (!item || item.archived || item.features.parseOk) return
    const dialect = dialectOf(item)
    const cheap = draftSqlExperience(item.originalSql, dialect)
    const draft = await normalizeSqlExperience(item.originalSql, dialect)
    const current = this.ensure().templates.find(row => row.id === id)
    if (!current || current.archived) return
    current.normalizedSql = draft.normalizedSql
    current.fingerprint = draft.fingerprint
    current.features = draft.features
    if (current.title === cheap.suggestedTitle) current.title = draft.suggestedTitle.slice(0, TEXT)
    if (!current.summary.trim() || current.summary === cheap.suggestedSummary) current.summary = draft.suggestedSummary.slice(0, TEXT)
    current.tags = clipTags([...current.tags, ...draft.suggestedTags])
    current.updatedAt = new Date().toISOString()
    this.#rebuildIndex()
    this.#persist()
  }
}

function sanitizeStoredTemplate(value: SqlTemplate): SqlTemplate {
  if (!value || typeof value.id !== 'string' || typeof value.familyId !== 'string') throw new Error()
  return {
    id: value.id.slice(0, 160),
    familyId: value.familyId.slice(0, 160),
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


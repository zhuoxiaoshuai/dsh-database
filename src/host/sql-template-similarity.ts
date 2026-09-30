import type { NormalizedTemplate, TemplateFeatures } from './sql-template-normalizer.ts'

export type TemplateIndex = {
  id: string
  familyId: string
  version: number
  title: string
  summary: string
  tags: string[]
  normalizedSql: string
  fingerprint: string
  features: TemplateFeatures
  unpublished?: boolean
  archived: boolean
  usageCount: number
  updatedAt: string
  dialect?: string
  connectionId?: string
}

export type SimilarityHit = {
  id: string
  familyId: string
  version: number
  title: string
  score: number
  reasons: string[]
  unpublished?: boolean
}

function jaccard(a: string[], b: string[]): number {
  const left = new Set(a.map(v => v.toLowerCase()))
  const right = new Set(b.map(v => v.toLowerCase()))
  if (!left.size && !right.size) return 1
  let inter = 0
  for (const item of left) if (right.has(item)) inter++
  return inter / new Set([...left, ...right]).size
}

function tokens(text: string): string[] {
  return text.toLowerCase().split(/[^a-z0-9_\u4e00-\u9fff]+/).filter(item => item.length > 1)
}

function overlap(a: string, b: string): number {
  const left = tokens(a), right = new Set(tokens(b))
  if (!left.length) return 0
  return left.filter(item => right.has(item)).length / left.length
}

function scoreFeatures(a: TemplateFeatures, b: TemplateFeatures): { score: number; reasons: string[] } {
  const reasons: string[] = []
  let score = 0
  if (a.operation === b.operation) { score += 0.18; reasons.push(`操作同为 ${a.operation}`) }
  else reasons.push(`操作不同：${a.operation} / ${b.operation}`)
  const tables = jaccard(a.tables, b.tables)
  score += tables * 0.28
  if (tables === 1 && a.tables.length) reasons.push('涉及相同表')
  else if (tables > 0) reasons.push('部分表重叠')
  const columns = jaccard(a.columns, b.columns)
  score += columns * 0.16
  const conditions = jaccard(a.conditionColumns, b.conditionColumns)
  score += conditions * 0.12
  const joins = jaccard(a.joins, b.joins)
  score += joins * 0.08
  if (a.risk !== b.risk) { score -= 0.25; reasons.push(`风险不同：${a.risk} / ${b.risk}`) }
  return { score: Math.max(0, Math.min(1, score)), reasons }
}

export function similarTemplates<T extends TemplateIndex>(draft: NormalizedTemplate, templates: T[], limit = 5): SimilarityHit[] {
  const hits: SimilarityHit[] = []
  for (const item of templates) {
    if (item.archived) continue
    const reasons: string[] = []
    let score = 0
    if (item.fingerprint === draft.fingerprint) {
      score = 1
      reasons.push('结构指纹完全相同')
    } else if (item.normalizedSql === draft.normalizedSql) {
      score = 0.97
      reasons.push('标准化 SQL 相同')
    } else {
      const structural = scoreFeatures(draft.features, item.features)
      score = structural.score
      reasons.push(...structural.reasons)
      const text = overlap(`${draft.suggestedTitle} ${draft.suggestedSummary} ${draft.suggestedTags.join(' ')}`, `${item.title} ${item.summary} ${item.tags.join(' ')}`)
      score = Math.min(1, score + text * 0.12)
      if (text > 0.4) reasons.push('标题或标签相近')
      if (!draft.features.parseOk || !item.features.parseOk) {
        score = Math.min(score, 0.49)
        reasons.push('存在未解析语句，不自动合并')
      }
    }
    if (score >= 0.35) hits.push({
      id: item.id,
      familyId: item.familyId,
      version: item.version,
      title: item.title,
      score: Number(score.toFixed(3)),
      reasons: reasons.slice(0, 4),
      unpublished: item.unpublished,
    })
  }
  return hits.sort((a, b) => b.score - a.score).slice(0, limit)
}

export function latestPublishedByFamily<T extends TemplateIndex>(templates: T[]): T[] {
  const map = new Map<string, T>()
  for (const item of templates) {
    if (item.archived || item.unpublished) continue
    const current = map.get(item.familyId)
    if (!current || item.version > current.version || item.updatedAt.localeCompare(current.updatedAt) > 0) map.set(item.familyId, item)
  }
  return [...map.values()]
}

export function searchTemplates<T extends TemplateIndex>(query: string, templates: T[], dialect?: string, connectionId?: string): T[] {
  const needles = tokens(query)
  const scored = templates.filter(item => !item.archived).map(item => {
    if (connectionId && item.connectionId !== connectionId) return { item, score: 0 }
    if (dialect && item.dialect !== 'any' && item.dialect !== dialect) return { item, score: 0 }
    const hay = `${item.title} ${item.summary} ${item.tags.join(' ')} ${item.features.tables.join(' ')} ${item.features.columns.join(' ')}`.toLowerCase()
    if (!needles.length) return { item, score: 0.01 + Math.min(item.usageCount, 20) / 100 }
    let score = 0
    for (const needle of needles) {
      if (hay.includes(needle)) score += 1
      if (item.features.tables.some(table => table.toLowerCase() === needle)) score += 1.5
      if (item.tags.some(tag => tag.toLowerCase() === needle)) score += 1.2
    }
    score += Math.min(item.usageCount, 20) / 50
    return { item, score }
  })
  return scored.filter(row => row.score > 0).sort((a, b) => b.score - a.score || b.item.updatedAt.localeCompare(a.item.updatedAt)).slice(0, 30).map(row => row.item)
}

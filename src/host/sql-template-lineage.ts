import type { TemplateIndex } from './sql-template-similarity.ts'

export function sameTemplateLineage(a: TemplateIndex, b: TemplateIndex): boolean {
  return a.connectionId === b.connectionId && a.dialect === b.dialect && a.familyId === b.familyId
    && (a.lineageId || a.familyId) === (b.lineageId || b.familyId)
}

export function lineageHead<T extends TemplateIndex>(templates: readonly T[], item: T): T | undefined {
  return templates.filter(row => !row.unpublished && sameTemplateLineage(row, item))
    .reduce<T | undefined>((head, row) => !head || row.version > head.version ? row : head, undefined)
}

export function isWritableLineageHead<T extends TemplateIndex>(templates: readonly T[], item: T): boolean {
  return !item.lineageAmbiguous && !item.archived && !item.unpublished && lineageHead(templates, item)?.id === item.id
}

/** Preserve corrupt/reused version numbers for inspection, never repair history by guessing. */
export function markAmbiguousLineages<T extends TemplateIndex>(templates: T[]): void {
  const versions = new Map<string, T>()
  const ambiguous: T[] = []
  for (const item of templates) {
    const key = JSON.stringify([item.connectionId, item.dialect, item.familyId, item.lineageId || item.familyId, item.version])
    if (versions.has(key) || item.lineageAmbiguous) ambiguous.push(item)
    versions.set(key, item)
  }
  for (const item of templates) if (ambiguous.some(row => sameTemplateLineage(row, item))) item.lineageAmbiguous = true
}

/** Old files have no parent IDs. Never guess a predecessor where more than one fits. */
export function restoreTemplateLineages<T extends TemplateIndex & { variant: string }>(templates: T[]): void {
  const groups = new Map<string, T[]>()
  for (const item of templates) {
    const key = JSON.stringify([item.connectionId || '', item.dialect, item.familyId])
    const group = groups.get(key) || []
    group.push(item); groups.set(key, group)
  }
  for (const group of groups.values()) {
    const heads = new Map<string, T>()
    const previous: T[] = []
    let ambiguous = false
    for (const item of group) {
      if (item.version === 1) item.lineageId = item.id
      else {
        const parents = previous.filter(parent => parent.variant === item.variant && parent.version === item.version - 1)
        if (parents.length !== 1 || heads.get(parents[0].lineageId!) !== parents[0]) { ambiguous = true; break }
        item.lineageId = parents[0].lineageId
      }
      heads.set(item.lineageId!, item)
      previous.push(item)
    }
    if (ambiguous) for (const item of group) {
      item.lineageId = item.id
      item.lineageAmbiguous = true
    }
  }
}

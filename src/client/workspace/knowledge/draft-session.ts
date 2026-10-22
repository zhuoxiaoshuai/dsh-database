import type { KnowledgeArchiveGuard, KnowledgeTidySnapshot } from '../../../shared/knowledge.ts'
import type { KnowledgeExecutionSnapshot } from './execution-owner.ts'

export const draftFields = ['text', 'sql', 'title', 'summary', 'tags'] as const
type Field = typeof draftFields[number]
export type DraftSession = {
  token: symbol
  revision: number
  fieldRevisions: Partial<Record<Field, number>>
  loadState: 'ready' | 'loading' | 'error'
  dirty: boolean
  saveError?: string
  archived?: boolean
  pending?: object
  executionPending?: object
  executionSnapshot?: KnowledgeExecutionSnapshot
  base?: { id: string; version: number; snapshot: KnowledgeTidySnapshot; archiveGuard?: KnowledgeArchiveGuard }
}

export function newDraft(): DraftSession {
  return { token: Symbol('knowledge-draft'), revision: 0, fieldRevisions: {}, loadState: 'ready', dirty: false }
}

/** A completed execution is still owned by its draft after the run lock is released. */
export function shouldRetainDraft(draft?: DraftSession): boolean {
  return !!draft && !!(draft.dirty || draft.pending || draft.executionPending || draft.executionSnapshot)
}

export function editDraft<S extends DraftSession>(draft: S, patch: Partial<S>): S {
  const fieldRevisions = { ...draft.fieldRevisions }
  for (const field of draftFields) if (Object.prototype.hasOwnProperty.call(patch, field)) fieldRevisions[field] = (fieldRevisions[field] || 0) + 1
  return { ...draft, ...patch, fieldRevisions, revision: draft.revision + 1, dirty: true }
}

/** Only the request's own fields and baseline can be acknowledged, never a refreshed list. */
export function acceptDraft<S extends DraftSession>(current: S, sent: S, accepted: Partial<S>, base: NonNullable<DraftSession['base']>): S {
  const next = { ...current, base, pending: undefined, saveError: '', archived: false }
  for (const field of draftFields) if (Object.prototype.hasOwnProperty.call(accepted, field)
    && (current.fieldRevisions[field] || 0) === (sent.fieldRevisions[field] || 0)) {
    Object.assign(next, { [field]: (accepted as Record<string, unknown>)[field] })
  }
  next.dirty = draftFields.some(field => Object.prototype.hasOwnProperty.call(accepted, field)
    && (next as Record<string, unknown>)[field] !== (accepted as Record<string, unknown>)[field])
  return next
}

/** Canonical storage is keyed by draft identity. Entry IDs are only selection bindings. */
export class DraftSessions<S extends DraftSession> {
  private drafts = new Map<symbol, S>()
  private bindings = new Map<string, symbol>()
  private retained = new Set<symbol>()
  private collect(token: symbol): void {
    const draft = this.drafts.get(token)
    if (draft && !shouldRetainDraft(draft) && !this.retained.has(token) && ![...this.bindings.values()].includes(token)) this.drafts.delete(token)
  }
  get(key: string): S | undefined { const token = this.bindings.get(key); return token ? this.drafts.get(token) : undefined }
  byToken(token: symbol): S | undefined { return this.drafts.get(token) }
  update(draft: S): void { this.drafts.set(draft.token, draft) }
  set(key: string, draft: S): void {
    const old = this.get(key)
    if (old && old.token !== draft.token && shouldRetainDraft(old)) this.keep(old)
    this.update(draft); this.bindings.set(key, draft.token)
    if (old && old.token !== draft.token) this.collect(old.token)
  }
  bindReceipt(key: string, draft: S): void {
    const occupied = this.get(key)
    this.update(draft)
    if (occupied && occupied.token !== draft.token) this.keep(draft)
    else this.bindings.set(key, draft.token)
  }
  keep(draft: S): void { this.update(draft); this.retained.add(draft.token) }
  recovered(token: symbol): void { this.retained.delete(token) }
  recoverable(active: symbol): S[] { return [...this.retained].filter(token => token !== active).map(token => this.drafts.get(token)!).filter(Boolean) }
  values(): IterableIterator<S> { return this.drafts.values() }
  delete(key: string): void {
    const old = this.get(key)
    if (old && shouldRetainDraft(old)) this.keep(old)
    this.bindings.delete(key)
    if (old) this.collect(old.token)
  }
  clear(): void { this.bindings.clear(); this.drafts.clear(); this.retained.clear() }
  *[Symbol.iterator](): IterableIterator<[string, S]> { for (const [key, token] of this.bindings) yield [key, this.drafts.get(token)!] }
}

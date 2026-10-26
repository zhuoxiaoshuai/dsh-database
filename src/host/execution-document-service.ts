import type { Connection } from '../shared/workbench.ts'
import { legacySharedQueryDocument } from '../shared/workbench.ts'
import { assertDocumentRevision, emptyExecutionDocument, isDocumentRevision, updateExecutionDocument, controlExecutionDocument, type ExecutionDocument } from '../shared/execution-document.ts'
import { sanitizeConversationWorkbench, type ConversationLayout } from './conversation-workbench-store.ts'
import { hostModules, getSourceRuntime } from './data-sources/modules.ts'

export interface ExecutionDocumentPort {
  binding(owner: string, id: string, generation?: unknown): Connection
  layout(owner: string): ConversationLayout
  save(owner: string, layout: ConversationLayout): void
  changed(owner: string, id: string, document: ExecutionDocument): void
}

/** Owns document revisions and control; manual tab drafts remain a separate concern. */
export class ExecutionDocumentService {
  private readonly port: ExecutionDocumentPort
  constructor(port: ExecutionDocumentPort) { this.port = port }
  read(owner: string, id: string, generation?: unknown): ExecutionDocument {
    const binding = this.port.binding(owner, id, generation)
    const workbench = this.port.layout(owner).workbenches[id]
    if (workbench?.aiDocument?.sourceId === binding.dialect) return workbench.aiDocument
    const kind = getSourceRuntime(binding.dialect).documentKind
    if (!kind) throw new Error('此数据源不支持此能力。')
    // 没有权威文档时旧 SharedQuery 只是迁移输入；迁移后的文档不再回读旧字段。
    const old = legacySharedQueryDocument(workbench, binding.dialect, binding.database)
    return old && kind === 'sql'
      ? old
      : emptyExecutionDocument(binding.dialect, kind === 'sql' ? { schema: binding.database } : binding.dialect === 'redis' ? { database: binding.database } : {})
  }
  private commit(owner: string, id: string, document: ExecutionDocument): ExecutionDocument {
    const layout = this.port.layout(owner)
    layout.workbenches[id] = sanitizeConversationWorkbench({ ...layout.workbenches[id], aiDocument: document })
    this.port.save(owner, layout)
    this.port.changed(owner, id, document)
    return document
  }
  update(owner: string, id: string, text: string, source: 'ai' | 'user' | 'system', expectedRevision?: number, generation?: unknown, context?: unknown): ExecutionDocument {
    if (!isDocumentRevision(expectedRevision)) throw new Error('缺少有效文档修订，请刷新。')
    const previous = this.read(owner, id, generation)
    const normalized = context === undefined ? undefined : hostModules.get(previous.sourceId).execution!.normalizeContext(context, this.port.binding(owner, id))
    const next = updateExecutionDocument(previous, text, source, expectedRevision, normalized)
    return next === previous ? previous : this.commit(owner, id, next)
  }
  control(owner: string, id: string, controller: 'ai' | 'user', reason: string, generation?: unknown, revision?: number): ExecutionDocument {
    if (!isDocumentRevision(revision)) throw new Error('缺少有效文档修订，请刷新。')
    const previous = this.read(owner, id, generation)
    assertDocumentRevision(previous, revision, 'AI Query 已变化，请刷新后再试。')
    const next = controlExecutionDocument(previous, controller, reason)
    return next === previous ? previous : this.commit(owner, id, next)
  }
}

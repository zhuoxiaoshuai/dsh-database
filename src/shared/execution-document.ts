import type { DataSourceId } from './data-sources/types.ts'

export type ExecutionDocument = {
  sourceId: DataSourceId
  text: string
  context: Record<string, string>
  revision: number
  controller: 'ai' | 'user'
  controllerReason?: string
}

function textLimit(sourceId: DataSourceId): number { return sourceId === 'kafka' ? 512 * 1024 : 65536 }

export function emptyExecutionDocument(sourceId: DataSourceId, context: Record<string, string> = {}): ExecutionDocument {
  return { sourceId, text: '', context, revision: 1, controller: 'ai' }
}

export function sanitizeExecutionDocument(value: unknown, sourceId: DataSourceId): ExecutionDocument {
  const input = value && typeof value === 'object' ? value as Record<string, unknown> : {}
  const context = input.context && typeof input.context === 'object' ? Object.fromEntries(Object.entries(input.context).filter(([key, item]) => key.length <= 80 && typeof item === 'string').slice(0, 12).map(([key, item]) => [key, String(item).slice(0, 256)])) : {}
  return {
    sourceId, text: typeof input.text === 'string' ? input.text.slice(0, textLimit(sourceId)) : '', context,
    revision: Number.isInteger(input.revision) && Number(input.revision) > 0 ? Math.min(Number(input.revision), 1_000_000_000) : 1,
    controller: input.controller === 'user' ? 'user' : 'ai',
    ...(typeof input.controllerReason === 'string' ? { controllerReason: input.controllerReason.slice(0, 40) } : {}),
  }
}

/** 目标也是可执行文档的一部分；切换目标保留控制权。 */
export function withExecutionDocumentContext(previous: ExecutionDocument, patch: Record<string, string>, expectedRevision?: number): ExecutionDocument {
  if (expectedRevision !== undefined && expectedRevision !== previous.revision) throw new Error('AI Query 已变化，请重新读取后再试。')
  const context = { ...previous.context }
  let changed = false
  for (const [key, value] of Object.entries(patch)) {
    if (!key || key.length > 80) continue
    const clipped = value.slice(0, 256)
    if (context[key] === clipped) continue
    context[key] = clipped
    changed = true
  }
  return changed ? { ...previous, context, revision: previous.revision + 1 } : previous
}

export function updateExecutionDocument(previous: ExecutionDocument, text: string, source: 'ai' | 'user' | 'system', expectedRevision?: number, context?: Record<string, string>): ExecutionDocument {
  if (expectedRevision !== undefined && expectedRevision !== previous.revision) throw new Error('AI Query 已变化，请重新读取后再试。')
  if (source === 'ai' && previous.controller !== 'ai') throw new Error('用户已接管 AI Query，无法覆盖编辑器。')
  const clipped = text.slice(0, textLimit(previous.sourceId))
  const target = context === undefined ? previous : withExecutionDocumentContext(previous, context)
  const takesControl = source === 'user' && previous.controller !== 'user'
  if (clipped === previous.text && !takesControl) return target
  return { ...target, text: clipped, revision: previous.revision + 1,
    controller: source === 'user' ? 'user' : previous.controller,
    controllerReason: source === 'user' ? 'user-edit' : source === 'ai' ? 'ai-publish' : previous.controllerReason }
}

export function controlExecutionDocument(previous: ExecutionDocument, controller: 'ai' | 'user', reason = 'user-takeover'): ExecutionDocument {
  if (previous.controller === controller) return previous
  return { ...previous, controller, controllerReason: controller === 'ai' ? 'return-ai' : reason, revision: previous.revision + 1 }
}

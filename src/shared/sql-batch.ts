import type { Dialect, Result } from './workbench.ts'
import { enumerateStatements, locateStatement, type StatementRange } from './sql-lex.ts'
import { stripLeadingComments } from './sql-text.ts'
import { executionStop } from './execution.ts'

export type SqlStatementKind = 'select' | 'insert' | 'update' | 'delete' | 'explain' | 'show' | 'other'
export type SqlStepStatus = 'pending' | 'running' | 'ok' | 'failed' | 'skipped' | 'cancelled' | 'unknown'
export type SqlRunMode = 'selection-or-current' | 'all'
export type SqlStep = {
  index: number
  sql: string
  kind: SqlStatementKind
  status: SqlStepStatus
  result?: Result
  error?: string
}

const UNSUPPORTED = 'SQL 页支持查询与增删改（SELECT / INSERT / UPDATE / DELETE）。DDL 暂未开放。'

export function isBlankStatement(sql: string): boolean {
  return !stripLeadingComments(sql).trim()
}

export function enumerateExecutableStatements(sql: string, dialect: Dialect): StatementRange[] {
  return enumerateStatements(sql, dialect).filter(item => !isBlankStatement(item.sql))
}

export function classifyManualSql(sql: string): SqlStatementKind {
  const probe = stripLeadingComments(sql)
  if (/^explain\b/i.test(probe)) return 'explain'
  if (/^show\b/i.test(probe)) return 'show'
  if (/^(with\b[\s\S]*\bselect\b|select\b)/i.test(probe)) return 'select'
  if (/^insert\b/i.test(probe)) return 'insert'
  if (/^update\b/i.test(probe)) return 'update'
  if (/^delete\b/i.test(probe)) return 'delete'
  return 'other'
}

export function resultTabLabel(index: number, total: number): string {
  return total > 1 ? `结果${index + 1}` : '结果'
}

export function expandExecutedResult(step: SqlStep, result: Result): SqlStep[] {
  const items = Array.isArray(result.batch) && result.batch.length > 1 ? result.batch : [result]
  return items.map((item, offset) => {
    const sql = typeof item.sql === 'string' && item.sql.trim() ? item.sql : step.sql
    const { batch: _ignored, ...set } = item
    return {
      index: step.index + offset,
      sql,
      kind: classifyManualSql(sql),
      status: 'ok' as const,
      result: set,
    }
  })
}
export function statementKindLabel(kind: SqlStatementKind): string {
  return ({ select: 'SELECT', insert: 'INSERT', update: 'UPDATE', delete: 'DELETE', explain: 'EXPLAIN', show: 'SHOW', other: '其他' })[kind]
}

export function stepStatusLabel(status: SqlStepStatus): string {
  return ({ pending: '待执行', running: '执行中', ok: '成功', failed: '失败', skipped: '未执行', cancelled: '已取消', unknown: '结果未知' })[status]
}

export function resolveRunStatements(input: {
  sql: string
  dialect: Dialect
  selection?: string
  cursor?: number
  mode: SqlRunMode
}): StatementRange[] {
  if (input.mode === 'all') return enumerateExecutableStatements(input.sql, input.dialect)
  const selected = input.selection?.trim()
  if (selected) return enumerateExecutableStatements(selected, input.dialect)
  const current = locateStatement(input.sql, input.cursor ?? 0, input.dialect)
  return isBlankStatement(current.sql) ? [] : [current]
}

export function createSqlBatch(statements: string[]): SqlStep[] {
  return statements.map((sql, index) => ({ index, sql, kind: classifyManualSql(sql), status: 'pending' }))
}

export function summarizeSqlBatch(steps: SqlStep[]) {
  const ok = steps.filter(step => step.status === 'ok').length
  const failed = steps.filter(step => step.status === 'failed').length
  const running = steps.findIndex(step => step.status === 'running')
  const affected = steps.reduce((sum, step) => sum + (step.result?.affectedRows ?? 0), 0)
  const elapsedMs = steps.reduce((sum, step) => sum + (step.result?.elapsedMs ?? 0), 0)
  const rows = steps.reduce((sum, step) => sum + (step.result?.rows.length ?? 0), 0)
  return { ok, failed, total: steps.length, running, affected, elapsedMs, rows }
}

export function formatSqlBatchStatus(steps: SqlStep[], busy = false): string {
  const summary = summarizeSqlBatch(steps)
  if (!summary.total) return ''
  if (busy) {
    if (summary.running >= 0) return `正在执行 ${summary.running + 1}/${summary.total}`
    const next = steps.findIndex(step => step.status === 'pending')
    return `正在执行 ${Math.max(1, (next >= 0 ? next : summary.total - 1) + 1)}/${summary.total}`
  }
  return `${summary.ok}/${summary.total} 成功${summary.failed ? ` · ${summary.failed} 失败` : ''} · 影响 ${summary.affected} 行 · ${summary.elapsedMs}ms`
}

export async function runSqlBatch(input: {
  steps: SqlStep[]
  from?: number
  only?: number
  execute(sql: string, signal: AbortSignal): Promise<Result>
  signal: AbortSignal
  onChange?(steps: SqlStep[]): void
}): Promise<SqlStep[]> {
  const steps = input.steps.map(step => ({ ...step }))
  const start = input.only ?? input.from ?? 0
  let last = input.only ?? steps.length - 1
  const emit = () => input.onChange?.(steps.map(step => ({ ...step })))
  const stopRest = (from: number, status: 'skipped' | 'cancelled') => {
    for (let i = from; i < steps.length; i++) {
      if (input.only != null && i !== input.only) continue
      if (steps[i].status === 'pending' || steps[i].status === 'running') steps[i] = { ...steps[i], status }
    }
  }
  for (let i = start; i <= last; i++) {
    const step = steps[i]
    if (!step) break
    if (step.kind === 'other') {
      steps[i] = { ...step, status: 'failed', error: UNSUPPORTED }
      if (input.only == null) stopRest(i + 1, 'skipped')
      emit()
      break
    }
    if (input.signal.aborted) {
      steps[i] = { ...step, status: 'cancelled', error: '已取消' }
      if (input.only == null) stopRest(i + 1, 'cancelled')
      emit()
      break
    }
    steps[i] = { ...step, status: 'running', error: undefined }
    emit()
    try {
      const result = await input.execute(step.sql, input.signal)
      const expanded = expandExecutedResult({ ...steps[i], sql: step.sql }, result)
      if (expanded.length === 1) {
        steps[i] = { ...expanded[0], index: i }
      } else {
        steps.splice(i, 1, ...expanded.map((item, offset) => ({ ...item, index: i + offset })))
        for (let j = i + expanded.length; j < steps.length; j++) steps[j] = { ...steps[j], index: j }
        last += expanded.length - 1
        i += expanded.length - 1
      }
      emit()
    } catch (error) {
      const message = error instanceof Error ? error.message : '执行失败'
      const stop = executionStop({ aborted: input.signal.aborted, dispatched: true, message })
      steps[i] = { ...steps[i], status: stop.status, error: stop.message }
      if (input.only == null) stopRest(i + 1, stop.status === 'failed' ? 'skipped' : 'cancelled')
      emit()
      break
    }
  }
  return steps
}

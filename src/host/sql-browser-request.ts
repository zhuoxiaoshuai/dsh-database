import { format } from 'sql-formatter'
import type { Dialect, SharedQuery } from '../shared/workbench.ts'
import { dialectCapabilities } from '../shared/dialect-capabilities.ts'
import { SQL_FIELD_MAX_LENGTH } from '../shared/limits.ts'

export type BrowserQueryUpdate = {
  source: 'user' | 'format'
  patch: Pick<Partial<SharedQuery>, 'sql' | 'schema'>
  revision?: number
}

export function parseBrowserQueryInitiator(value: unknown): 'user' {
  if (value !== undefined && value !== 'user') throw new Error('浏览器只能发起人工执行。')
  return 'user'
}

export function parseBrowserQueryUpdate(input: Record<string, unknown>): BrowserQueryUpdate {
  const source = input.source === undefined ? 'user' : input.source
  if (source !== 'user' && source !== 'format') throw new Error('浏览器不能使用此文档更新来源。')
  const raw = input.patch === undefined ? {} : input.patch
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)
    || ![Object.prototype, null].includes(Object.getPrototypeOf(raw))) throw new Error('文档补丁必须是普通对象。')
  const patch: BrowserQueryUpdate['patch'] = {}
  for (const key of Object.keys(raw)) {
    if (key !== 'sql' && key !== 'schema') throw new Error('浏览器只能修改 SQL 和 Schema。')
    const value = (raw as Record<string, unknown>)[key]
    if (typeof value !== 'string') throw new Error('SQL 和 Schema 必须是文本。')
    patch[key] = value
  }
  if (input.revision !== undefined && (!Number.isSafeInteger(input.revision) || (input.revision as number) < 0)) {
    throw new Error('文档修订号无效。')
  }
  return { source, patch, revision: input.revision as number | undefined }
}

export function validateBrowserFormat(current: SharedQuery, patch: BrowserQueryUpdate['patch'], dialect: Dialect, expectedRevision?: number): void {
  if (expectedRevision !== undefined && expectedRevision !== current.revision) throw new Error('AI Query 已变化，请刷新后再格式化。')
  if (patch.schema !== undefined && patch.schema !== current.schema) throw new Error('格式化不能改变 Schema。')
  if (patch.sql === undefined || patch.sql === current.sql) return
  if (patch.sql.length > SQL_FIELD_MAX_LENGTH) throw new Error('格式化结果超过文档长度上限。')
  let formatted: string
  try { formatted = format(current.sql, { language: dialectCapabilities(dialect).formatterLanguage }) }
  catch { throw new Error('无法格式化当前 SQL，请检查语法。') }
  if (formatted.length > SQL_FIELD_MAX_LENGTH) throw new Error('格式化结果超过文档长度上限。')
  if (patch.sql !== formatted) throw new Error('格式化内容与当前 SQL 不一致，请刷新后重试。')
}

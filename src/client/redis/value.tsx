import React from 'react'
import type { RedisValue } from '../../shared/redis-result.ts'

export function RedisValueView({ data }: { data: RedisValue | undefined }): React.ReactElement {
  if (!data) return <span>—</span>
  if (data.type === 'nil') return <span className="db-muted">(nil)</span>
  if (data.type === 'integer') return <span>(integer) {String(data.value)}</span>
  if (data.type === 'binary') return <span>(binary, {data.length} bytes, Base64) {String(data.value)}</span>
  if (data.type === 'string') return <span>{String(data.value)}</span>
  if (data.type === 'truncated') return <span>… 已截断</span>
  if (data.type === 'error') return <span className="db-redis-error">{String(data.value)}</span>
  if ('value' in data && Array.isArray(data.value)) return <ol className="db-redis-values">{data.value.map((item, index) => <li key={index}>{Array.isArray(item) ? <><RedisValueView data={item[0]} /> → <RedisValueView data={item[1]} /></> : <RedisValueView data={item} />}</li>)}</ol>
  return <span>{'value' in data ? String(data.value ?? '') : ''}</span>
}

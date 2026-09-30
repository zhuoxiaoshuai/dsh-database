import React from 'react'
import { tableColumns, type KeyRow } from './key-model.ts'
import { RedisKeyTable } from './key-table.tsx'

export function RedisKeyStream({
  name, rows, more, revision, writing, onCreate, onDelete, onCopy,
}: {
  name: string
  rows: KeyRow[]
  more?: boolean
  revision: unknown
  writing?: boolean
  onCreate(rows: Record<string, string>[]): void
  onDelete(row: KeyRow): void
  onCopy(text: string): void
}): React.ReactElement {
  return <RedisKeyTable name={name} kind="stream" columns={tableColumns('stream')} rows={rows} more={more} revision={revision} writing={writing}
    sequence={false} allowEdit={false} repeatCreate createFields={[{ key: 'field', label: 'Field' }, { key: 'value', label: 'Value' }]} wrapColumn="fields"
    onCreate={onCreate} onDelete={onDelete} onCopy={onCopy} />
}

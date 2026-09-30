import React from 'react'
import { tableColumns, type KeyRow } from './key-model.ts'
import { RedisKeyTable } from './key-table.tsx'

export function RedisKeyBitmap({
  name, rows, more, revision, writing, onCreate, onToggle, onText, onCopy,
}: {
  name: string
  rows: KeyRow[]
  more?: boolean
  revision: unknown
  writing?: boolean
  onCreate(values: Record<string, string>): void
  onToggle(row: KeyRow): void
  onText(): void
  onCopy(text: string): void
}): React.ReactElement {
  return <>
    <div className="db-redis-key-tools">
      <button className="db-redis-btn" type="button" onClick={onText}>Text</button>
    </div>
    <RedisKeyTable name={name} kind="bitmap" columns={tableColumns('bitmap')} rows={rows} more={more} revision={revision} writing={writing}
      sequence={false} allowEdit={false} allowDelete={false} createFields={[{ key: 'offset', label: 'Offset' }, { key: 'bit', label: 'Bit' }]}
      onCreate={items => { if (items[0]) onCreate(items[0]) }} onCopy={onCopy} onCell={(column, row) => { if (column === 'bit') onToggle(row) }} />
  </>
}

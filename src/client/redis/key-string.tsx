import React from 'react'
import type { StringEncoding } from './key-model.ts'
import { presentEncoding } from './key-model.ts'

const ENCODINGS: { id: StringEncoding; label: string }[] = [
  { id: 'text', label: 'Text' },
  { id: 'json', label: 'Json' },
  { id: 'hex', label: 'Hex' },
  { id: 'binary', label: 'Binary' },
]

export function RedisKeyString({
  encoding, value, dirty, binary, size, busy, readOnly, onEncoding, onBit, onChange, onSave, onCopy,
}: {
  encoding: StringEncoding
  value: string
  dirty: boolean
  binary?: { base64: string; length: number }
  size: number
  busy: boolean
  readOnly: boolean
  onEncoding(encoding: StringEncoding): void
  onBit(): void
  onChange(value: string): void
  onSave(): void
  onCopy(text: string): void
}): React.ReactElement {
  const formatted = presentEncoding(encoding === 'text' ? 'text' : encoding, value, binary)
  const shown = encoding === 'text' || (encoding === 'json' && dirty) ? value : formatted.text
  const editable = !readOnly && !busy && (encoding === 'text' || encoding === 'json')
  const invalidJson = encoding === 'json' && formatted.invalidJson
  return <>
    <div className="db-redis-key-tools">
      <div className="db-redis-key-tools-main">
        {ENCODINGS.map(item => <button key={item.id} className="db-redis-btn" type="button" aria-pressed={encoding === item.id} onClick={() => onEncoding(item.id)}>{item.label}</button>)}
        <button className="db-redis-btn" type="button" onClick={onBit}>Bit</button>
        <span className="db-muted">Size {size}</span>
      </div>
      <button className="db-redis-btn" type="button" onClick={() => onCopy(shown)}>Copy</button>
    </div>
    <div className="db-redis-value">
      {invalidJson && <p className="db-redis-key-hint">JSON 无法解析，按原文显示。</p>}
      {readOnly && encoding === 'text' && <p className="db-redis-key-hint">二进制值仅展示 Hex / Binary。</p>}
      {editable
        ? <textarea aria-label="String 值" value={shown} onChange={event => onChange(event.target.value)} onKeyDown={event => { if ((event.ctrlKey || event.metaKey) && event.key === 's') { event.preventDefault(); onSave() } }} />
        : <pre className="db-redis-key-pre">{shown || '—'}</pre>}
    </div>
    {editable && <div className="db-redis-savebar"><button className="db-redis-btn db-primary" type="button" disabled={busy} onClick={onSave}>保存</button></div>}
  </>
}

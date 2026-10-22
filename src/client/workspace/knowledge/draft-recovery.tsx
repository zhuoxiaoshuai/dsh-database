import React from 'react'
import type { DraftSession } from './draft-session.ts'

export function DraftRecovery({ drafts, disabled, onRestore }: {
  drafts: (DraftSession & { title: string })[]; disabled?: boolean; onRestore(token: symbol): void
}): React.ReactElement | null {
  if (!drafts.length) return null
  return <div className="db-info-note" aria-label="保留的草稿">
    {drafts.map((draft, index) => <p key={index}><span>{draft.title || '未命名草稿'} </span>
      <button type="button" disabled={disabled} onClick={() => onRestore(draft.token)}>{!draft.dirty && !draft.pending && draft.executionSnapshot ? '恢复草稿与执行结果' : '恢复未保存草稿'}</button>
    </p>)}
  </div>
}

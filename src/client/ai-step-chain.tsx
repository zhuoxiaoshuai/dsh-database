import React, { useState } from 'react'
import { ChevronDown, ChevronRight } from 'lucide-react'
import { executionChainNewestFirst, executionTitle, type ExecutionRecord } from '../shared/execution.ts'

export function AiStepChain({
  chain,
  selectedId,
  onPick,
}: {
  chain: ExecutionRecord[]
  selectedId?: string
  onPick(id: string): void
}): React.ReactElement {
  const [open, setOpen] = useState(true)
  const display = executionChainNewestFirst(chain)
  const activeId = selectedId || chain[chain.length - 1]?.executionId
  return <section className={`db-ai-step-panel${open ? '' : ' is-collapsed'}`} aria-label="本轮执行步骤">
    <header className="db-ai-step-panel-head">
      <span>本轮执行步骤</span>
      <button type="button" className="db-icon-button" aria-expanded={open} aria-label={open ? '折叠本轮步骤' : '展开本轮步骤'} onClick={() => setOpen(value => !value)}>
        {open ? <ChevronDown size={14} /> : <ChevronRight size={14} />}
      </button>
    </header>
    {open && <div className="db-ai-step-chain">
      {display.length ? display.map((item, index) => <React.Fragment key={item.executionId}>
        {index > 0 && <span className="db-ai-step-arrow" aria-hidden="true">←</span>}
        <button type="button" className={item.executionId === activeId ? 'is-active' : ''} onClick={() => onPick(item.executionId)} title={executionTitle(item)}>
          {executionTitle(item)}
        </button>
      </React.Fragment>) : <span className="db-muted">还没有本轮步骤。AI 执行后会按顺序出现在这里。</span>}
    </div>}
  </section>
}

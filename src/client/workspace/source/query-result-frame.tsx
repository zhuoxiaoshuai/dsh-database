import React from 'react'

export type QueryResultPane = 'result' | 'message'
export type QueryResultTab = { key: string; label: string }

export type QueryResultFrameProps = {
  pane?: QueryResultPane
  onPaneChange?(pane: QueryResultPane): void
  resultLabel?: string
  messageLabel?: string
  resultTabs?: QueryResultTab[]
  activeResultTab?: string
  onResultTabChange?(key: string): void
  summary?: React.ReactNode
  actions?: React.ReactNode
  secondaryHeader?: React.ReactNode
  children?: React.ReactNode
  message?: React.ReactNode
  empty?: React.ReactNode
}

/** Owns all vertical tracks inside a SQL result pane. */
export function QueryResultFrame({
  pane = 'result',
  onPaneChange,
  resultLabel = '结果',
  messageLabel = '消息',
  resultTabs,
  activeResultTab,
  onResultTabChange,
  summary,
  actions,
  secondaryHeader,
  children,
  message,
  empty = <p className="db-muted db-query-result-empty">运行查询后在此显示结果。</p>,
}: QueryResultFrameProps): React.ReactElement {
  const body = pane === 'message' ? message : children
  const tabs = resultTabs && resultTabs.length > 1 ? resultTabs : undefined
  return <section className="db-query-result-frame" aria-label="查询结果">
    <header className="db-query-result-head">
      {onPaneChange && <div className="db-query-result-tabs" role="tablist" aria-label="结果视图">
        {tabs
          ? tabs.map(tab => <button
              key={tab.key}
              type="button"
              role="tab"
              aria-selected={pane === 'result' && activeResultTab === tab.key}
              onClick={() => { onResultTabChange?.(tab.key); onPaneChange('result') }}
            >{tab.label}</button>)
          : <button type="button" role="tab" aria-selected={pane === 'result'} onClick={() => onPaneChange('result')}>{resultLabel}</button>}
        <button type="button" role="tab" aria-selected={pane === 'message'} onClick={() => onPaneChange('message')}>{messageLabel}</button>
      </div>}
    </header>
    {secondaryHeader && <div className="db-query-result-secondary">{secondaryHeader}</div>}
    <div className="db-query-result-body">
      {body ?? empty}
    </div>
    {(summary || actions) && <footer className="db-query-result-foot">
      <div className="db-query-result-search-slot" />
      {summary && <div className="db-query-result-summary">{summary}</div>}
      {actions && <div className="db-query-result-actions">{actions}</div>}
    </footer>}
  </section>
}

import React from 'react'
/** Shared list state and chrome; sources own search inputs, rows and paging protocols. */
export function ResourceList({title, search, actions, loading, error, empty, paging, children, className='db-resource-list', header, bodyClassName, pagingClassName='db-catalog-toolbar', style, extra, emptyContent='没有数据。', loadingContent='正在加载…'}: {
  title: string; search?: React.ReactNode; actions?: React.ReactNode; loading?: boolean; error?: string; empty?: boolean; paging?: React.ReactNode; children: React.ReactNode;
  className?:string;header?:React.ReactNode;bodyClassName?:string;pagingClassName?:string;style?:React.CSSProperties;extra?:React.ReactNode;emptyContent?:React.ReactNode;loadingContent?:React.ReactNode
}) {
  const body=<>{error && <p className="db-error" role="alert">{error}</p>}{loading && loadingContent && <p className="db-muted" role="status">{loadingContent}</p>}{!loading && !error && empty && <div className="db-muted">{emptyContent}</div>}{children}</>
  return <section className={className} aria-label={title} style={style}>
    {header || <header className="db-catalog-toolbar"><strong>{title}</strong>{search}{actions}</header>}
    {bodyClassName?<div className={bodyClassName} aria-busy={loading || undefined}>{body}</div>:body}
    {paging && <footer className={pagingClassName}>{paging}</footer>}{extra}
  </section>
}

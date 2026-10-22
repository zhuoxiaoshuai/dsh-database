import React from 'react'
import {ResourceError} from '../feedback/resource-error.tsx'
import {EmptyState} from '../feedback/empty-state.tsx'
export {ResourceError} from '../feedback/resource-error.tsx'
export function ResourceHeading({title, description, actions, summary}: {title: React.ReactNode; description?: React.ReactNode; actions?: React.ReactNode; summary?: React.ReactNode}) {
  const fullTitle = typeof title === 'string' ? title : undefined
  return <header className="db-resource-heading"><div className="db-resource-title"><h3 title={fullTitle} tabIndex={fullTitle ? 0 : undefined}>{title}</h3>{summary && <span className="db-resource-summary">{summary}</span>}{description && <p className="db-muted">{description}</p>}</div>{actions && <div className="db-resource-actions">{actions}</div>}</header>
}
export function ResourceMetadata({items}: {items: {label: string; value: React.ReactNode}[]}) {
  return <dl className="db-resource-metadata">{items.map(item => <div key={item.label}><dt>{item.label}</dt><dd>{item.value}</dd></div>)}</dl>
}
/** Shared list state and chrome; sources own search inputs, rows and paging protocols. */
export function ResourceList({title, search, actions, loading, error, empty, paging, children, className='db-resource-list', header, bodyClassName, pagingClassName='db-catalog-toolbar', style, extra, emptyContent='没有数据。', loadingContent='正在加载…'}: {
  title: string; search?: React.ReactNode; actions?: React.ReactNode; loading?: boolean; error?: string; empty?: boolean; paging?: React.ReactNode; children: React.ReactNode;
  className?:string;header?:React.ReactNode;bodyClassName?:string;pagingClassName?:string;style?:React.CSSProperties;extra?:React.ReactNode;emptyContent?:React.ReactNode;loadingContent?:React.ReactNode
}) {
  const body=<>{error && <ResourceError message={error}/>} {loading && loadingContent && <EmptyState loading>{loadingContent}</EmptyState>}{!loading && !error && empty && <EmptyState>{emptyContent}</EmptyState>}{children}</>
  return <section className={className} aria-label={title} style={style}>
    {header || <header className="db-catalog-toolbar"><strong>{title}</strong>{search}{actions}</header>}
    {bodyClassName?<div className={bodyClassName} aria-busy={loading || undefined}>{body}</div>:body}
    {paging && <footer className={pagingClassName}>{paging}</footer>}{extra}
  </section>
}

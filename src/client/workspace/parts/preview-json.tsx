import React from 'react'

/** Shared truncated JSON preview for execution history. */
export function previewJson(value: unknown): React.ReactElement {
  return <pre className="db-cell-detail">{JSON.stringify(value, null, 2).slice(0, 4000)}</pre>
}

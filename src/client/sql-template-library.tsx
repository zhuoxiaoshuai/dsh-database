import React from 'react'
import { KnowledgeLibrary } from './workspace/knowledge/knowledge-library.tsx'
import { useSqlKnowledge, type SqlKnowledgeProps } from './sql/use-sql-knowledge.tsx'

/** Compatibility entry: SQL owns analysis and sessions, the common library owns layout. */
export function SqlTemplateLibrary(props: SqlKnowledgeProps): React.ReactElement {
  const bindings = useSqlKnowledge(props)
  return <KnowledgeLibrary {...bindings} />
}

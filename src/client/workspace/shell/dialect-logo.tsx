import React from 'react'
import type { DataSourceId } from '../../../shared/data-sources/types.ts'
import { clientModules } from '../../data-sources/registry.ts'

export function DialectLogo({ dialect, className = 'db-dialect-logo', compact }: { dialect: DataSourceId; className?: string; compact?: boolean }): React.ReactElement {
  const logo = clientModules.get(dialect).logo
  const mark = compact && logo.compact ? logo.compact : logo
  return <svg className={logo.className ? `${className} ${logo.className}` : className} viewBox={mark.viewBox} overflow="hidden" aria-hidden="true">{mark.artwork}</svg>
}

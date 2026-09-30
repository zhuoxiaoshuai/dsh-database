import React from 'react'
import type { DataSourceId } from '../../../shared/data-sources/types.ts'
import { clientModules } from '../../data-sources/registry.ts'

export function DialectLogo({ dialect, className = 'db-dialect-logo' }: { dialect: DataSourceId; className?: string }): React.ReactElement {
  const logo = clientModules.get(dialect).logo
  return <svg className={logo.className ? `${className} ${logo.className}` : className} viewBox={logo.viewBox} aria-hidden="true">{logo.artwork}</svg>
}

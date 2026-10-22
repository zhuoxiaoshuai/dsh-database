import { useSyncExternalStore, type CSSProperties } from 'react'
import { resolveWorkbenchTheme, subscribeWorkbenchTheme, workbenchThemeSnapshot } from './workbench-theme.ts'

export function useWorkbenchTheme(owner?: Element | null) {
  useSyncExternalStore(subscribeWorkbenchTheme, workbenchThemeSnapshot, () => 'mist-green:host:light')
  const theme = resolveWorkbenchTheme(undefined, owner)
  return {
    dark: theme.scheme === 'dark',
    attributes: { 'data-db-palette': theme.paletteId, 'data-db-scheme': theme.scheme, 'data-db-theme-mode': theme.mode },
    style: { ...theme.variables, colorScheme: theme.scheme } as CSSProperties,
  }
}

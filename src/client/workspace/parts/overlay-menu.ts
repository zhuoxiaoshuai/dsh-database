import { type ThemeDoc } from './theme/host-theme.ts'
import { resolveWorkbenchTheme } from './theme/workbench-theme.ts'

export function overlayMenuClass(anchor: HTMLElement | null, extra = '', doc?: ThemeDoc | null): string {
  const owner = (anchor as { ownerDocument?: ThemeDoc } | null)?.ownerDocument
  const dark = resolveWorkbenchTheme(doc ?? owner, anchor).scheme === 'dark'
  return ['db-search-select-menu', dark ? 'db-dark' : '', extra].filter(Boolean).join(' ')
}

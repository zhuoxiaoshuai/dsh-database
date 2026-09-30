import { isHostDark, type ThemeDoc } from './host-theme.ts'

export function overlayMenuClass(anchor: HTMLElement | null, extra = '', doc?: ThemeDoc | null): string {
  const workbenchDark = Boolean(anchor?.closest?.('.db-workbench')?.classList.contains('db-dark'))
  const owner = (anchor as { ownerDocument?: ThemeDoc } | null)?.ownerDocument
  const dark = workbenchDark || isHostDark(doc ?? owner)
  return ['db-search-select-menu', dark ? 'db-dark' : '', extra].filter(Boolean).join(' ')
}

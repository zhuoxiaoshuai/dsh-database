import { isHostDark, subscribeHostTheme, type ThemeDoc } from './host-theme.ts'
import { themeVariables, workbenchThemes, type ThemeScheme } from './theme-tokens.ts'

export type ThemeMode = 'host' | 'light' | 'dark'
export type ThemePreference = { paletteId: string; mode: ThemeMode }
export const THEME_STORAGE_KEY = 'dsh-database:theme:v1'
const defaults: ThemePreference = { paletteId: 'mist-green', mode: 'host' }
let preference = defaults
let initialized = false
let stopHost: (() => void) | undefined
const listeners = new Set<() => void>()

function normalize(value: unknown): ThemePreference {
  const candidate = value as Partial<ThemePreference> | undefined
  if (!candidate || !Object.hasOwn(workbenchThemes, candidate.paletteId ?? '') || !['host', 'light', 'dark'].includes(candidate.mode ?? '')) return { ...defaults }
  return { paletteId: candidate.paletteId!, mode: candidate.mode! }
}
function initialize() {
  if (initialized || typeof window === 'undefined') return
  initialized = true
  try {
    const saved = JSON.parse(window.localStorage.getItem(THEME_STORAGE_KEY) || 'null')
    preference = saved?.version === 1 ? normalize(saved.preference) : { ...defaults }
  } catch { preference = { ...defaults } }
}
export function getWorkbenchThemePreference(): ThemePreference { initialize(); return { ...preference } }
export function setWorkbenchTheme(next: ThemePreference): void {
  initialize()
  preference = normalize(next)
  try { window.localStorage.setItem(THEME_STORAGE_KEY, JSON.stringify({ version: 1, preference })) } catch { /* Memory preference remains usable. */ }
  for (const listener of listeners) listener()
}
export function resolveWorkbenchTheme(doc?: ThemeDoc, owner?: Element | null) {
  const selected = getWorkbenchThemePreference()
  const workbench = owner?.closest('.db-workbench')
  const ownedDark = selected.mode === 'host' && !workbench?.hasAttribute?.('data-db-scheme') && workbench?.classList.contains('db-dark')
  const scheme: ThemeScheme = selected.mode === 'host' ? (ownedDark || isHostDark(doc) ? 'dark' : 'light') : selected.mode
  return { ...selected, scheme, variables: themeVariables(selected.paletteId, scheme) }
}
export function workbenchThemeSnapshot(): string {
  const current = resolveWorkbenchTheme()
  return `${current.paletteId}:${current.mode}:${current.scheme}`
}
export function subscribeWorkbenchTheme(listener: () => void): () => void {
  initialize()
  listeners.add(listener)
  if (listeners.size === 1 && typeof document !== 'undefined') stopHost = subscribeHostTheme(() => { for (const notify of listeners) notify() })
  return () => { listeners.delete(listener); if (!listeners.size) { stopHost?.(); stopHost = undefined } }
}

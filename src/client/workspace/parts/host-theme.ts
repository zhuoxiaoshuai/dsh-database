export const HOST_DARK_ATTRIBUTE = 'data-ds-dark-theme'

export type ThemeDoc = {
  documentElement?: {
    classList?: { contains(name: string): boolean }
    dataset?: { theme?: string }
    style?: { colorScheme?: string }
  }
  body?: { hasAttribute?(name: string): boolean }
  defaultView?: { matchMedia?(query: string): { matches: boolean; addEventListener?(type: string, fn: () => void): void; removeEventListener?(type: string, fn: () => void): void } | undefined } | null
}

function documentOf(doc?: ThemeDoc | null): ThemeDoc | undefined {
  if (doc) return doc
  if (typeof document === 'undefined') return undefined
  return document
}

export function isHostDark(doc?: ThemeDoc | null): boolean {
  const root = documentOf(doc)
  if (!root) return false
  if (root.body?.hasAttribute?.(HOST_DARK_ATTRIBUTE)) return true
  const html = root.documentElement
  if (html?.classList?.contains('dark') || html?.dataset?.theme === 'dark') return true
  const scheme = html?.style?.colorScheme || ''
  if (/(^|\s)dark(\s|$)/i.test(scheme)) return true
  if (/(^|\s)light(\s|$)/i.test(scheme)) return false
  try {
    return root.defaultView?.matchMedia?.('(prefers-color-scheme: dark)')?.matches === true
  } catch {
    return false
  }
}

export function subscribeHostTheme(onChange: () => void, doc?: Document): () => void {
  const target = (doc ?? (typeof document !== 'undefined' ? document : undefined)) as (Document & ThemeDoc) | undefined
  if (!target?.documentElement) return () => {}
  const observer = new MutationObserver(onChange)
  observer.observe(target.documentElement, { attributes: true, attributeFilter: ['class', 'data-theme', 'style'] })
  if (target.body) observer.observe(target.body, { attributes: true, attributeFilter: [HOST_DARK_ATTRIBUTE] })
  const media = target.defaultView?.matchMedia?.('(prefers-color-scheme: dark)')
  media?.addEventListener?.('change', onChange)
  return () => {
    observer.disconnect()
    media?.removeEventListener?.('change', onChange)
  }
}

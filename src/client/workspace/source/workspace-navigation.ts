import { useCallback, useLayoutEffect, useRef, useState } from 'react'

/** Source payloads stay opaque; the shared controller only uses page identity. */
export type NavigationItem = { id: string }
export type NavigationConfig = {
  initialItems: NavigationItem[]
  initialActive: string
  fallback: string
  onClose?(item: NavigationItem): void
}

export function useWorkspaceNavigation() {
  const [tabs, setTabs] = useState<NavigationItem[]>([])
  const [active, setActive] = useState('')
  const config = useRef<NavigationConfig>()
  const tabsRef = useRef(tabs)
  tabsRef.current = tabs
  const open = useCallback((item: NavigationItem) => {
    setTabs(previous => previous.some(tab => tab.id === item.id) ? previous : [...previous, item])
    setActive(item.id)
  }, [])
  const close = useCallback((id: string) => {
    if (id === config.current?.fallback) return
    const closing = tabsRef.current.find(tab => tab.id === id)
    if (!closing) return
    config.current?.onClose?.(closing)
    const next = tabsRef.current.filter(tab => tab.id !== id)
    tabsRef.current = next
    setTabs(next)
    setActive(current => current === id ? next.at(-1)?.id || config.current?.fallback || '' : current)
  }, [])
  const configure = useCallback((next: NavigationConfig) => { config.current = next }, [])
  const initialize = useCallback(() => {
    const initial = config.current
    if (!initial) return
    tabsRef.current = initial.initialItems
    setTabs(initial.initialItems)
    setActive(initial.initialActive)
  }, [])
  return { tabs, setTabs, active, setActive, open, close, configure, initialize }
}

export type WorkspaceNavigation = ReturnType<typeof useWorkspaceNavigation>

export function useNavigationConfiguration(navigation: WorkspaceNavigation, config: NavigationConfig, identity: string) {
  navigation.configure(config)
  useLayoutEffect(() => { navigation.initialize() }, [navigation.initialize, identity])
}

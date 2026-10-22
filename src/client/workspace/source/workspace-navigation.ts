import { useCallback, useLayoutEffect, useRef, useState } from 'react'

/** Source payloads stay opaque; the shared controller only uses page identity. */
export type NavigationItem = { id: string }
export type NavigationConfig = {
  initialItems: NavigationItem[]
  initialActive: string
  fallback: string
  beforeClose?(item: NavigationItem): boolean | Promise<boolean>
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
  const close = useCallback(async (id: string) => {
    if (id === config.current?.fallback) return
    const closing = tabsRef.current.find(tab => tab.id === id)
    if (!closing) return
    if (config.current?.beforeClose && !await config.current.beforeClose(closing)) return
    if (!tabsRef.current.some(tab => tab.id === id)) return
    config.current?.onClose?.(closing)
    const removed = tabsRef.current.filter(tab => tab.id !== id)
    tabsRef.current = removed
    setTabs(previous => previous.filter(tab => tab.id !== id))
    setActive(current => current === id ? removed.at(-1)?.id || config.current?.fallback || '' : current)
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

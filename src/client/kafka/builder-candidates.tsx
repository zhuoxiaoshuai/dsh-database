import React, { useEffect, useRef, useState } from 'react'
import type { Connection, WorkspaceBridge } from '../../shared/workbench.ts'
import { SearchSelect, type SearchSelectFieldProps } from '../workspace/parts/controls/search-select.tsx'

/** Mounted only for fields used by the selected operation. Cache belongs to this connection. */
export function KafkaNameInput({ bridge, connection, category, value, onChange, names = [], label, ...inputProps }: {
  bridge: WorkspaceBridge; connection: Connection; category: 'topics' | 'groups'; value: string; onChange(value: string): void; names?: readonly string[]; label: string
} & SearchSelectFieldProps) {
  const [opened, setOpened] = useState(false), [search, setSearch] = useState('')
  const [items, setItems] = useState<string[]>([]), [nextCursor, setNextCursor] = useState<string>()
  const [loading, setLoading] = useState(false), [error, setError] = useState('')
  const pending = useRef<AbortController | null>(null), sequence = useRef(0)
  const cache = useRef(new Map<string, { items: string[]; nextCursor?: string }>())
  const load = async (append = false, refresh = false) => {
    pending.current?.abort()
    const serial = ++sequence.current, controller = new AbortController()
    pending.current = controller
    const cached = cache.current.get(search)
    if (!append && cached && !refresh) { setItems(cached.items); setNextCursor(cached.nextCursor); setLoading(false); setError(''); return }
    setLoading(true); setError('')
    try {
      if (!connection.live || !bridge.explorer) throw new Error('候选读取不可用，可手工输入。')
      const page = await bridge.explorer(connection, 'list', { ...(category === 'groups' ? { parent: 'folder:groups' } : {}), search, ...(append ? { cursor: nextCursor } : {}) }, controller.signal)
      if (controller.signal.aborted || serial !== sequence.current) return
      const incoming = (page.nodes || []).map(node => node.title)
      const next = [...new Set([...(append ? items : []), ...incoming])]
      setItems(next); setNextCursor(page.nextCursor)
      cache.current.set(search, { items: next, nextCursor: page.nextCursor })
      if (cache.current.size > 20) cache.current.delete(cache.current.keys().next().value!)
      if (page.warning) setError(page.warning)
    } catch (caught) {
      if (!controller.signal.aborted && serial === sequence.current) setError(caught instanceof Error ? caught.message : '候选读取失败，可手工输入。')
    } finally { if (serial === sequence.current) setLoading(false) }
  }
  useEffect(() => {
    if (!opened) return
    pending.current?.abort(); ++sequence.current
    setItems([]); setNextCursor(undefined); setError('')
    const timer = setTimeout(() => void load(), search ? 250 : 0)
    return () => { clearTimeout(timer); pending.current?.abort(); ++sequence.current }
  }, [opened, search, connection.id, connection.generation, category])
  useEffect(() => () => { pending.current?.abort(); ++sequence.current }, [])
  return <SearchSelect {...inputProps} value={value} onPick={onChange} options={[...new Set([...items, ...names])]} placeholder="选择或输入名称" ariaLabel={label} allowCustom
    onOpen={() => setOpened(true)} onSearch={setSearch} loading={loading} hasMore={!!nextCursor} onMore={() => void load(true)} error={error} onRetry={() => void load(false, true)} />
}

export function useKafkaPartitions(bridge: WorkspaceBridge, connection: Connection, topic: string, enabled: boolean) {
  const [state, setState] = useState<{ topic: string; items: number[]; loading: boolean; error: string }>({ topic: '', items: [], loading: false, error: '' })
  const [refresh, setRefresh] = useState(0)
  const identity = `${connection.id}\0${connection.generation || ''}`
  const owner = useRef(identity); owner.current = identity
  const cache = useRef(new Map<string, number[]>())
  useEffect(() => {
    if (!enabled || !topic) return
    const controller = new AbortController(), expected = identity
    const cacheKey = `${identity}\0${topic}`, cached = cache.current.get(cacheKey)
    if (cached && !refresh) { setState({ topic, items: cached, loading: false, error: '' }); return }
    setState({ topic, items: [], loading: true, error: '' })
    const timer = setTimeout(async () => {
      try {
        if (!connection.live || !bridge.explorer) throw new Error('分区读取不可用，可手工输入。')
        const result = await bridge.explorer(connection, 'read', { ref: `topic:${encodeURIComponent(topic)}`, refresh: !!refresh }, controller.signal) as { partitions?: { partition: number }[]; warning?: string }
        if (controller.signal.aborted || owner.current !== expected) return
        const items = (result.partitions || []).map(item => item.partition)
        cache.current.set(cacheKey, items)
        if (cache.current.size > 20) cache.current.delete(cache.current.keys().next().value!)
        setState({ topic, items, loading: false, error: result.warning || '' })
      } catch (caught) { if (!controller.signal.aborted && owner.current === expected) setState({ topic, items: [], loading: false, error: caught instanceof Error ? caught.message : '分区读取失败。' }) }
    }, 250)
    return () => { clearTimeout(timer); controller.abort() }
  }, [topic, enabled, identity, refresh])
  return { ...(state.topic === topic && enabled ? state : { items: [], loading: false, error: '' }), retry: () => setRefresh(value => value + 1) }
}

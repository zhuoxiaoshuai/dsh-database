import React, { useEffect, useState } from 'react'
import type { Connection, WorkspaceBridge } from '../../shared/workbench.ts'
import { redisKeySlot, redisParameterHint } from './completion.ts'
import { RedisCommandEditor } from './command-editor.tsx'
import { RedisOverview } from './overview.tsx'
import { RedisResultView } from './result.tsx'
import type { RedisKeySuggestResult } from '../../shared/redis-result.ts'
import { mergeCachedKeys, removeCachedKey } from './key-cache.ts'
import { redisCommandDatabase, redisSelectedDatabase } from '../../shared/data-sources/redis.ts'
import type { StandardSourceBindings } from '../data-sources/types.ts'

type Suggestion = 'loading' | 'partial' | 'complete' | 'failed'
type EditorContext = { bridge: WorkspaceBridge; connection: Connection; database: string; keys: readonly string[]; onSuggestion(status: Suggestion): void }

export function RedisQueryEditor({ value, onChange, onRun, editorContext }: { value: string; onChange(value: string): void; onRun(value: string): void; editorContext?: unknown }): React.ReactElement {
  const ctx = editorContext as EditorContext | undefined
  if (!ctx) throw new Error('Redis 命令编辑器缺少工作区上下文。')
  return <RedisCommandEditor value={value} onChange={onChange} onRun={onRun} onCursorChange={() => {}} keys={ctx.keys}
    identity={`${ctx.connection.id}:${ctx.connection.generation ?? ''}:${ctx.database}`}
    onKeySuggestionStatus={ctx.onSuggestion}
    suggestKeys={async (prefix, signal) => {
      if (!ctx.bridge.redis || !ctx.connection.live) throw new Error('请先连接 Redis。')
      return ctx.bridge.redis(ctx.connection, 'redis-key-suggest', { prefix, database: ctx.database }, signal) as unknown as RedisKeySuggestResult
    }} />
}

function hintFor(text: string, status: Suggestion): string | undefined {
  const base = redisParameterHint(text)
  if (!base) return undefined
  if (!redisKeySlot(text, text.length)) return base
  const note = status === 'loading' ? '正在限量查找 Key，候选可能不完整'
    : status === 'failed' ? '查找失败，仍可手工输入 Key'
    : status === 'complete' ? '本轮 Key 扫描已完成'
    : 'Key 候选可能不完整'
  return `${base} · ${note}`
}

function redisStatus(connection: Connection): string {
  const settings = connection.settings && 'redisMode' in connection.settings ? connection.settings : undefined
  if (settings?.redisMode === 'cluster') return '集群'
  if (settings?.redisMode === 'sentinel') return `哨兵 · ${settings.sentinelMaster || ''}`
  return '单机'
}

export function useRedisBindings(bridge: WorkspaceBridge, connection: Connection, refreshToken = 0, catalogRoot = ''): StandardSourceBindings {
  const selectedDatabase = redisSelectedDatabase(connection, catalogRoot)
  const commandDatabase = redisCommandDatabase(connection, catalogRoot)
  const [history, setHistory] = useState<string[]>([])
  const [suggestion, setSuggestion] = useState<Suggestion>('partial')
  const [keys, setKeys] = useState<string[]>([])
  const identity = `${connection.id}\0${connection.generation || ''}\0${selectedDatabase}`
  const identityRef = React.useRef(identity)
  identityRef.current = identity
  useEffect(() => { setHistory([]); setSuggestion('partial'); setKeys([]) }, [connection.id, connection.generation])
  useEffect(() => { setKeys([]); setSuggestion('partial') }, [selectedDatabase])
  const onKeys = (found: readonly string[]) => { if (identityRef.current === identity) setKeys(previous => mergeCachedKeys(previous, found)) }
  const onKeyChange = (change: { operation: 'add' | 'remove' | 'rename'; name: string; next?: string }) => {
    if (identityRef.current !== identity) return
    setKeys(previous => change.operation === 'add' ? mergeCachedKeys(previous, [change.name])
      : change.operation === 'rename' ? mergeCachedKeys(removeCachedKey(previous, change.name), change.next ? [change.next] : [])
        : removeCachedKey(previous, change.name))
  }
  return { sourceName: 'Redis', queryTabLabel: '命令台', initialQuery: 'PING', status: redisStatus(connection),
    executionContext: { database: commandDatabase }, executionContextKey: commandDatabase, executionContextLabel: `Redis · DB ${commandDatabase}`,
    editorContext: { bridge, connection, database: commandDatabase, keys, onSuggestion: (value: Suggestion) => { if (identityRef.current === identity) setSuggestion(value) } },
    overview: () => <RedisOverview bridge={bridge} connection={connection} refreshToken={refreshToken} database={selectedDatabase} onKeys={onKeys} onKeyChange={onKeyChange} />,
    Editor: RedisQueryEditor, Result: RedisResultView, hint: text => hintFor(text, suggestion),
    queryFooter: setText => history.length > 0 ? <details className="db-redis-command-history"><summary>本页命令历史</summary>{history.map((item, index) => <button key={`${item}:${index}`} type="button" className="db-text-button" onClick={() => setText(item)}>{item.slice(0, 100)}</button>)}</details> : null,
    runText: async (text, signal) => {
        if (!bridge.redis || !connection.live) throw new Error('请先连接 Redis。')
        const result = await bridge.redis(connection, 'redis-command', { command: text, database: commandDatabase }, signal)
        if (identityRef.current === identity && !signal?.aborted) setHistory(previous => [text, ...previous.filter(item => item !== text)].slice(0, 30))
        return result
      } }
}

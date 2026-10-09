import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { kafkaSource } from '../../shared/data-sources/kafka.ts'
import { kafkaConnectionForm } from '../kafka/connection-fields.tsx'
import { KafkaOverview } from '../kafka/overview.tsx'
import { KafkaCommandEditor } from '../kafka/editor.tsx'
import { KafkaResultView } from '../kafka/results.tsx'
import { kafkaParameterHint } from '../kafka/completion.ts'
import type { KafkaNames } from '../kafka/completion.ts'
import { mergeKafkaNames, namesFromKafkaResult } from '../kafka/name-cache.ts'
import type { WorkspaceSourceContext } from '../workspace-sources.tsx'
import type { StandardSourceBindings } from './types.ts'
import type { ClientSourceModule } from './types.ts'
import { kafkaHistory } from '../kafka/history-view.tsx'

const logo = { viewBox: '0 0 32 32', artwork: (
<><circle cx="7" cy="16" r="4" fill="currentColor"/><circle cx="24" cy="7" r="4" fill="currentColor"/><circle cx="24" cy="25" r="4" fill="currentColor"/><path d="M10 14 21 8M10 18l11 6" stroke="currentColor" strokeWidth="2"/></>
) }

const writeCommand = /^\s*(PRODUCE|PRODUCE_BATCH|TOMBSTONE|CREATE_TOPIC|SET_GROUP_OFFSETS)\s+/i

function confirmPublish(text: string): boolean {
  const match = writeCommand.exec(text)
  if (!match) return true
  let detail = '目标待校验'
  try {
    const input = JSON.parse(text.slice(match[0].length)) as { topic?: string; groupId?: string; expected?: Record<string, string | null>; offsets?: Record<string, string>; timestamp?: number; messages?: unknown[] }
    detail = `${input.topic || '未知 Topic'}${input.groupId ? ` / 消费组 ${input.groupId}` : ''}`
    if (match[1].toUpperCase() === 'PRODUCE_BATCH') detail += ` / ${input.messages?.length || 0} 条`
    if (match[1].toUpperCase() === 'SET_GROUP_OFFSETS') detail += `\n旧位置 ${JSON.stringify(input.expected)}\n目标 ${input.offsets ? JSON.stringify(input.offsets) : `时间 ${input.timestamp}`}`
  } catch { /* Host validates the command. */ }
  return window.confirm(`在 SIT 执行 ${match[1].toUpperCase()}：${detail}？\n写入结果未知时请先核对，勿直接重试。`)
}

function useKafkaBindings({ host, connection, catalogRoot, refreshToken }: WorkspaceSourceContext): StandardSourceBindings {
  const identity = `${connection.id}\0${connection.generation || ''}`
  const currentIdentity = useRef(identity)
  currentIdentity.current = identity
  const [cache, setCache] = useState<{ identity: string; names: KafkaNames }>({ identity, names: { topics: [], groups: [] } })
  const names = cache.identity === identity ? cache.names : { topics: [], groups: [] }
  const onNames = useCallback((incoming: Partial<KafkaNames>) => {
    if (currentIdentity.current !== identity) return
    setCache(previous => {
      const before = previous.identity === identity ? previous.names : { topics: [], groups: [] }
      const next = mergeKafkaNames(before, incoming)
      return previous.identity === identity && before === next ? previous : { identity, names: next }
    })
  }, [identity])
  const Result = useMemo(() => function CachedKafkaResult(props: React.ComponentProps<typeof KafkaResultView>) {
    useEffect(() => {
      // A generation switch clears the previous result in the parent effect. Do not cache its names under the new identity.
      const timer = window.setTimeout(() => onNames(namesFromKafkaResult(props.result)), 0)
      return () => window.clearTimeout(timer)
    }, [props.result])
    return <KafkaResultView {...props} snapshotScope={identity} canWrite={connection.environment === 'sit'} />
  }, [onNames, connection.environment])
  return { sourceName: 'Kafka', editorContext: names,
    overview: onUse => <KafkaOverview bridge={host} connection={connection} catalog={catalogRoot === 'groups' ? 'groups' : 'topics'} refreshToken={refreshToken} onUse={onUse} onNames={onNames} />,
    Editor: KafkaCommandEditor, Result, hint: kafkaParameterHint, confirmDocumentRun: confirmPublish,
    runText: (text, signal) => {
      if (!host.executeText) throw new Error('Kafka 执行通道不可用。')
      if (writeCommand.test(text) && connection.environment !== 'sit') throw new Error('Kafka 写操作仅在 SIT 开放。')
      if (!confirmPublish(text)) throw new Error('已取消发布。')
      return host.executeText(connection, text, {}, signal)
    } }
}

export const kafkaModule: ClientSourceModule = {
  id: 'kafka', descriptor: kafkaSource, connection: kafkaConnectionForm, history: kafkaHistory, logo,
  tree: { filterNoun: '分类', roots: [{ id: 'topics', label: 'Topics' }, { id: 'groups', label: '消费组' }] },
  workspace: { mode: 'standard', useBindings: useKafkaBindings },
}

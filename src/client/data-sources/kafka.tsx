import React from 'react'
import { kafkaSource } from '../../shared/data-sources/kafka.ts'
import { kafkaConnectionForm } from '../kafka/connection-fields.tsx'
import { KafkaOverview } from '../kafka/overview.tsx'
import { KafkaCommandEditor } from '../kafka/editor.tsx'
import { KafkaResultView } from '../kafka/results.tsx'
import { kafkaParameterHint } from '../kafka/completion.ts'
import type { ClientSourceModule } from './types.ts'
import { kafkaHistory } from '../kafka/history-view.tsx'

const logo = { viewBox: '0 0 32 32', artwork: (
<><circle cx="7" cy="16" r="4" fill="currentColor"/><circle cx="24" cy="7" r="4" fill="currentColor"/><circle cx="24" cy="25" r="4" fill="currentColor"/><path d="M10 14 21 8M10 18l11 6" stroke="currentColor" strokeWidth="2"/></>
) }

export const kafkaModule: ClientSourceModule = {
  id: 'kafka', descriptor: kafkaSource, connection: kafkaConnectionForm, history: kafkaHistory, logo,
  tree: { filterNoun: '分类', roots: [{ id: 'topics', label: 'Topics' }, { id: 'groups', label: '消费组' }] },
  workspace: { mode: 'standard', useBindings: ({ host, connection, catalogRoot, refreshToken }) => ({ sourceName: 'Kafka',
    overview: onUse => <KafkaOverview bridge={host} connection={connection} catalog={catalogRoot === 'groups' ? 'groups' : 'topics'} refreshToken={refreshToken} onUse={onUse} />,
    Editor: KafkaCommandEditor, Result: KafkaResultView, hint: kafkaParameterHint,
    runText: (text, signal) => {
      if (!host.executeText) throw new Error('Kafka 执行通道不可用。')
      return host.executeText(connection, text, {}, signal)
    } }) },
}

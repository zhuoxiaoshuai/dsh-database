import { normalizeKafkaConfig, kafkaFingerprint, kafkaCaDigest } from './connection.mjs'
import { kafkaRuntime } from './runtime.mjs'
import { kafkaExplorer } from './explorer.ts'
import { kafkaKnowledge } from './knowledge.ts'
import { kafkaExecution } from './execution.ts'
import type { HostSourceModule } from '../module-types.ts'
import type { KafkaConnectionInput, SourceConnectionSettings } from '../../../shared/workbench.ts'
import { registerKafkaAiTools } from './ai-tools.ts'

export const kafkaModule: HostSourceModule = {
  id: 'kafka', family: 'kafka', runtime: kafkaRuntime,
  connection: {
    validate: (input, options) => normalizeKafkaConfig(input, options) as KafkaConnectionInput,
    fingerprint: input => kafkaFingerprint(input),
    sameLogin: (saved, input) => kafkaFingerprint(saved) === kafkaFingerprint({ ...input,
      caDigest: input.caPem ? undefined : 'caDigest' in saved ? saved.caDigest : undefined }),
    requiresPassword: input => (input as KafkaConnectionInput).saslMechanism !== 'none',
    toSavedSettings: (input, caPem) => {
      const { password: _password, caPem: _caPem, rememberPassword: _remember, useSavedPassword: _use, ...settings } = input
      return { ...settings, caDigest: kafkaCaDigest(caPem) } as SourceConnectionSettings
    },
    normalizeStoredSettings: raw => {
      const input = normalizeKafkaConfig({ ...raw, password: '', useSavedPassword: true }, { passwordOptional: true })
      const { password: _password, caPem: _caPem, rememberPassword: _remember, useSavedPassword: _use, ...settings } = input
      const digest = 'caDigest' in raw && typeof raw.caDigest === 'string' && /^[0-9a-f]{64}$/.test(raw.caDigest) ? raw.caDigest : ''
      return { ...settings, caDigest: digest } as SourceConnectionSettings
    },
  },
  ai: { key: 'kafka', register: registerKafkaAiTools },
  explorer: kafkaExplorer, knowledge: kafkaKnowledge, execution: { mode: 'standard-text', ...kafkaExecution },
}

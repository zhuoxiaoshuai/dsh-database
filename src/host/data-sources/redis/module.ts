import { validateConnection, connectionFingerprint } from '../../../shared/connection-input.ts'
import { redisRuntime } from './runtime.mjs'
import { redisExplorer } from './explorer.ts'
import { redisKnowledge } from './knowledge.ts'
import type { HostSourceModule } from '../module-types.ts'
import { registerRedisAiTools } from '../../redis-ai-tools.ts'
import { normalizeLegacyStoredSettings } from '../stored-config.ts'
import { redisExecution } from './execution.ts'

export const redisModule: HostSourceModule = {
  id: 'redis', family: 'redis', runtime: redisRuntime,
  connection: { validate: validateConnection, fingerprint: connectionFingerprint, normalizeStoredSettings: normalizeLegacyStoredSettings },
  ai: { key: 'redis', register: registerRedisAiTools },
  explorer: redisExplorer, knowledge: redisKnowledge, execution: { mode: 'standard-text', ...redisExecution },
}

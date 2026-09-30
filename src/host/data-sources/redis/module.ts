import { validateConnection, connectionFingerprint } from '../../../shared/connection-input.ts'
import { redisRuntime } from './runtime.mjs'
import { redisExplorer } from './explorer.ts'
import { redisKnowledge } from './knowledge.ts'
import type { HostSourceModule } from '../module-types.ts'
import { registerRedisAiTools } from '../../redis-ai-tools.ts'
import { normalizeLegacyStoredSettings } from '../stored-config.ts'
import { assertRedisDatabaseId, assertRedisClusterDatabase } from '../../redis-request.ts'

export const redisModule: HostSourceModule = {
  id: 'redis', family: 'redis', runtime: redisRuntime,
  connection: { validate: validateConnection, fingerprint: connectionFingerprint, normalizeStoredSettings: normalizeLegacyStoredSettings },
  ai: { key: 'redis', register: registerRedisAiTools },
  explorer: redisExplorer, knowledge: redisKnowledge, execution: { mode: 'legacy-adapter', normalizeContext(raw, binding) {
    if (!raw || typeof raw !== 'object' || Array.isArray(raw) || Object.keys(raw).some(key => key !== 'database')) throw new Error('Redis 执行目标无效。')
    const database = assertRedisDatabaseId(String((raw as { database?: unknown }).database ?? binding.database ?? '0'))
    assertRedisClusterDatabase(database, binding.settings && 'redisMode' in binding.settings ? binding.settings.redisMode : undefined)
    return { database }
  } },
}

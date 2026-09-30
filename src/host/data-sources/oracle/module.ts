import { validateConnection, connectionFingerprint } from '../../../shared/connection-input.ts'
import { oracleRuntime } from './runtime.mjs'
import { oracleExplorer } from './explorer.ts'
import { oracleKnowledge } from './knowledge.ts'
import type { HostSourceModule } from '../module-types.ts'
import { sqlAi } from '../sql-ai.ts'
import { normalizeLegacyStoredSettings } from '../stored-config.ts'

export const oracleModule: HostSourceModule = {
  id: 'oracle', family: 'sql', runtime: oracleRuntime,
  connection: { validate: validateConnection, fingerprint: connectionFingerprint, normalizeStoredSettings: normalizeLegacyStoredSettings },
  ai: sqlAi,
  explorer: oracleExplorer, knowledge: oracleKnowledge, execution: { mode: 'legacy-adapter' },
}

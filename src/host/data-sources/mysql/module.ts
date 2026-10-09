import { validateConnection, connectionFingerprint } from '../../../shared/connection-input.ts'
import { mysqlRuntime } from './runtime.mjs'
import { mysqlExplorer } from './explorer.ts'
import { mysqlKnowledge } from './knowledge.ts'
import type { HostSourceModule } from '../module-types.ts'
import { sqlAi } from '../sql-ai.ts'
import { normalizeLegacyStoredSettings } from '../stored-config.ts'
import { createSqlTextExecution } from '../sql-execution.ts'

export const mysqlModule: HostSourceModule = {
  id: 'mysql', family: 'sql', runtime: mysqlRuntime,
  connection: { validate: validateConnection, fingerprint: connectionFingerprint, normalizeStoredSettings: normalizeLegacyStoredSettings },
  ai: sqlAi,
  explorer: mysqlExplorer, knowledge: mysqlKnowledge, execution: createSqlTextExecution('mysql'),
}

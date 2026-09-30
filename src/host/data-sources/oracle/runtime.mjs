import { sqlRuntimeActions } from '../sql-runtime-actions.mjs'
export const oracleRuntime = Object.freeze({
  id: 'oracle', workerEntry: 'connection-worker.mjs', requiresPassword: true, usesCustomCa: () => false, actions: sqlRuntimeActions, documentKind: 'sql',
})

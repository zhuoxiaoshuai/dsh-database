import { sqlRuntimeActions } from '../sql-runtime-actions.mjs'
export const mysqlRuntime = Object.freeze({
  id: 'mysql', workerEntry: 'connection-worker.mjs', requiresPassword: true, usesCustomCa: () => false, actions: sqlRuntimeActions, documentKind: 'sql',
})

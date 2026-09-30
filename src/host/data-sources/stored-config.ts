import { validateConnection } from '../../shared/connection-input.ts'
import type { SourceConnectionSettings } from '../../shared/workbench.ts'

/** Retain the existing persisted shape for SQL and Redis connections. */
export function normalizeLegacyStoredSettings(raw: SourceConnectionSettings): SourceConnectionSettings {
  const input = validateConnection({ ...raw, password: 'x', rememberPassword: false, useSavedPassword: false })
  const { password: _password, rememberPassword: _remember, useSavedPassword: _saved, caPem: _caPem, ...settings } = input
  return settings as SourceConnectionSettings
}

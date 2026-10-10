import { registerNacosAiTools } from './ai-tools.ts'
import { nacosEndpoint } from '../../../shared/data-sources/nacos-endpoints.mjs'
import { validateConnection } from '../../../shared/connection-input.ts'
import { nacosRuntime } from './runtime.mjs'
import { normalizeLegacyStoredSettings } from '../stored-config.ts'
import type { HostSourceModule } from '../module-types.ts'

function validateNacosConnection(value: unknown, options?: { passwordOptional?: boolean }) {
  const input = validateConnection(value, options)
  if (input.dialect !== 'nacos') throw new Error('请选择 Nacos。')
  nacosEndpoint(input)
  if (input.password && !input.username) throw new Error('请填写用户名。')
  return input
}

export const nacosModule: HostSourceModule = {
  id: 'nacos', family: 'nacos', runtime: nacosRuntime,
  connection: { validate: validateNacosConnection, fingerprint: input => { const value = input as unknown as import('../../../shared/workbench.ts').ConnectionInput; return [nacosEndpoint(value), value.username].join('\0') }, normalizeStoredSettings: normalizeLegacyStoredSettings },
  ai: { key: 'nacos', register: registerNacosAiTools },

}

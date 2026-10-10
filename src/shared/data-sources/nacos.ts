import type { NacosClientDescriptor } from './types.ts'
export const nacosSource: NacosClientDescriptor = Object.freeze({
  id: 'nacos', family: 'nacos', showsSchemaTree: false, displayName: 'Nacos', badge: 'NACOS', defaultPort: 8848,
  connection: {
    requiresUsername: false, requiresPassword: false,
    validateConnectionTarget(database: string) {
      if (/[\u0000-\u001f]/.test(database)) throw new Error('命名空间无效。')
    },
    connectionExtras: (input: Record<string, unknown>) => {
      if(input.protocol !== undefined && !['http','https'].includes(String(input.protocol))) throw new Error('Nacos 协议无效。')
      return {protocol: input.protocol ?? 'http', contextPath: input.contextPath ?? '/nacos'}
    },
    connectionFingerprintSuffix: () => [],
  },
})

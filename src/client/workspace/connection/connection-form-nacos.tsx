import React from 'react'
import type { ConnectionFormSource } from './connection-form-types.ts'
import { hostPortConnectionInput, hostPortRow } from './connection-form-host-port.tsx'
import { nacosSource } from '../../../shared/data-sources/nacos.ts'

export const nacosConnectionForm: ConnectionFormSource = {
  id: 'nacos', displayName: nacosSource.displayName,
  optionalUser: true, optionalPassword: true,
  permissionNote: '人工配置写入需预览确认；AI 仅在 SIT 写入。未填密码时使用匿名访问。',
  createInput: options => hostPortConnectionInput('nacos', nacosSource.defaultPort, '', options),
  showCredentials: () => true,
  fields(input, patch) {
    if (input.dialect !== 'nacos') return null
    return <>
      {hostPortRow(input, patch)}
      <label className="db-form-label">协议<select value={input.protocol || 'http'} onChange={event => patch({ protocol: event.target.value as 'http' | 'https' })}><option value="http">HTTP</option><option value="https">HTTPS</option></select></label>
      <label className="db-form-label">Context path<input value={input.contextPath ?? '/nacos'} maxLength={256} onChange={event => patch({ contextPath: event.target.value })} /></label>
      <label className="db-form-label">命名空间 · 可选<input value={input.database} maxLength={128} onChange={event => patch({ database: event.target.value })} placeholder="public，可留空" /></label>
    </>
  },
}

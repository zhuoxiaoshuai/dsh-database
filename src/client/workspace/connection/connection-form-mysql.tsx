import React from 'react'
import { sqlConnectionPermissionNote, type ConnectionFormSource } from './connection-form-types.ts'
import { hostPortConnectionInput, hostPortRow } from './connection-form-host-port.tsx'
import { mysqlSource } from '../../../shared/data-sources/mysql.ts'

export const mysqlConnectionForm: ConnectionFormSource = {
  id: 'mysql', displayName: mysqlSource.displayName,
  optionalUser: false, optionalPassword: false,
  permissionNote: sqlConnectionPermissionNote,
  createInput: options => hostPortConnectionInput('mysql', mysqlSource.defaultPort, '', options),
  showCredentials: () => true,
  fields(input, patch) {
    if (input.dialect !== 'mysql') return null
    return <>
      {hostPortRow(input, patch)}
      <label className="db-form-label">数据库 · 可选<input value={input.database} maxLength={128} onChange={event => patch({ database: event.target.value })} placeholder="可留空，先连接服务器" /></label>
    </>
  },
}

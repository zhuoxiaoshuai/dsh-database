import React from 'react'
import { sqlConnectionPermissionNote, type ConnectionFormSource } from './connection-form-types.ts'
import { hostPortConnectionInput, hostPortRow } from './connection-form-host-port.tsx'
import { oracleSource } from '../../../shared/data-sources/oracle.ts'

export const oracleConnectionForm: ConnectionFormSource = {
  id: 'oracle', displayName: oracleSource.displayName,
  optionalUser: false, optionalPassword: false,
  permissionNote: sqlConnectionPermissionNote,
  createInput: options => hostPortConnectionInput('oracle', oracleSource.defaultPort, '', options),
  showCredentials: () => true,
  fields(input, patch) {
    if (input.dialect !== 'oracle') return null
    return <>
      {hostPortRow(input, patch)}
      <label className="db-form-label">连接方式<select value={input.oracleMode} onChange={event => patch({ oracleMode: event.target.value as 'service' | 'sid' })}><option value="service">Service Name</option><option value="sid">SID</option></select></label>
      <label className="db-form-label">{input.oracleMode === 'service' ? 'Service Name' : 'SID'}<input required value={input.database} maxLength={128} onChange={event => patch({ database: event.target.value })} placeholder={input.oracleMode === 'service' ? '例如：ORCLPDB1' : '例如：ORCL'} /></label>
    </>
  },
}

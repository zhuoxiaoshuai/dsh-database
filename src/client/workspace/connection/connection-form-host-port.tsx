import React from 'react'
import { normalizeEnvironment } from '../../../shared/connection-permission.ts'
import type { Connection, ConnectionInput } from '../../../shared/workbench.ts'

export function hostPortRow(input: ConnectionInput, patch: (value: Partial<ConnectionInput>) => void) {
  return <div className="db-form-row"><label className="db-form-label">主机地址<input required value={input.host} maxLength={253} onChange={event => patch({ host: event.target.value })} placeholder="localhost 或数据库服务器地址" autoComplete="off" /></label><label className="db-form-label db-port">端口<input required type="number" min={1} max={65535} value={input.port || ''} onChange={event => patch({ port: Number(event.target.value) })} /></label></div>
}

export function hostPortConnectionInput(
  dialect: ConnectionInput['dialect'],
  port: number,
  database: string,
  options: { passwordStorage?: boolean; editing?: Connection },
  extras?: Partial<ConnectionInput>,
): ConnectionInput {
  const blank: ConnectionInput = {
    name: '',
    dialect,
    host: '',
    port,
    database,
    oracleMode: 'service',
    username: '',
    password: '',
    environment: 'sit',
    rememberPassword: options.passwordStorage !== false,
    ...extras,
  }
  const editing = options.editing
  if (!editing || editing.dialect !== dialect) return blank
  const settings = editing.settings
  const identity = {
    name: editing.name,
    dialect,
    password: '',
    environment: normalizeEnvironment(editing.environment) as ConnectionInput['environment'],
    rememberPassword: !!editing.hasPassword,
  }
  if (!settings || !('host' in settings)) return { ...blank, ...identity }
  return { ...blank, ...settings, ...identity }
}

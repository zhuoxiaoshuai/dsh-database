import React from 'react'
import type { ConnectionFormSource } from './connection-form-types.ts'
import type { ConnectionInput } from '../../../shared/workbench.ts'
import { hostPortConnectionInput, hostPortRow } from './connection-form-host-port.tsx'
import { redisSource } from '../../../shared/data-sources/redis.ts'

const modePort = { standalone: redisSource.defaultPort, sentinel: 26379, cluster: redisSource.defaultPort }

function redisMode(input: ConnectionInput): 'standalone' | 'sentinel' | 'cluster' {
  return input.redisMode === 'sentinel' || input.redisMode === 'cluster' ? input.redisMode : 'standalone'
}

function applyRedisMode(input: ConnectionInput, mode: 'standalone' | 'sentinel' | 'cluster', patch: (value: Partial<ConnectionInput>) => void) {
  const current = redisMode(input)
  patch({
    redisMode: mode,
    ...(input.port === modePort[current] ? { port: modePort[mode] } : {}),
    ...(mode === 'cluster' ? { database: '0' } : {}),
  })
}

export const redisConnectionForm: ConnectionFormSource = {
  id: 'redis', displayName: redisSource.displayName,
  optionalUser: true, optionalPassword: true,
  permissionNote: '人工命令台在三种环境均可执行命令；AI 仅在 SIT 可执行任意命令。',
  createInput: options => hostPortConnectionInput('redis', redisSource.defaultPort, '0', options, {
    tls: false, caPem: '', redisMode: 'standalone', sentinelMaster: '',
  }),
  showCredentials: () => true,
  fields(input, patch, editing) {
    if (input.dialect !== 'redis') return null
    const mode = redisMode(input)
    return <>
      {hostPortRow(input, patch)}
      <label className="db-form-label">连接方式<select value={mode} onChange={event => applyRedisMode(input, event.target.value as 'standalone' | 'sentinel' | 'cluster', patch)}><option value="standalone">单机</option><option value="sentinel">哨兵</option><option value="cluster">集群</option></select></label>
      {mode === 'sentinel' && <label className="db-form-label">Master 名称<input required value={input.sentinelMaster || ''} maxLength={128} onChange={event => patch({ sentinelMaster: event.target.value })} placeholder="例如：mymaster" /></label>}
      {mode !== 'cluster' && <label className="db-form-label">DB 编号<input required value={input.database} maxLength={128} onChange={event => patch({ database: event.target.value })} placeholder="0" /></label>}
      <label className="db-remember"><input type="checkbox" checked={!!input.tls} onChange={event => patch({ tls: event.target.checked, caPem: event.target.checked ? input.caPem : '' })} />使用 TLS（验证服务器证书）</label>
      {input.tls && <label className="db-form-label">自定义 CA · 可选<textarea value={input.caPem || ''} maxLength={65536} rows={4} onChange={event => patch({ caPem: event.target.value })} placeholder={editing?.hasCa ? '已保存 CA，留空继续使用' : '-----BEGIN CERTIFICATE-----'} /></label>}
    </>
  },
}

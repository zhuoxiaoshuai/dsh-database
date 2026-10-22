import React from 'react'
import { normalizeEnvironment } from '../../shared/connection-permission.ts'
import type { KafkaConnectionInput } from '../../shared/workbench.ts'
import type { ConnectionFormSource } from '../workspace/connection/connection-form-types.ts'
import { kafkaSource } from '../../shared/data-sources/kafka.ts'

export const kafkaConnectionForm: ConnectionFormSource = {
  id: 'kafka', displayName: kafkaSource.displayName, optionalUser: false, optionalPassword: false,
  permissionNote: '读取使用临时消费组，不提交业务消费位置；发布及消费位置修复仅在 SIT 开放，并保留确认。',
  createInput({ passwordStorage, editing }): KafkaConnectionInput {
    if (editing?.dialect === 'kafka') {
      const settings = editing.settings
      return {
        name: editing.name, dialect: 'kafka', brokers: settings && 'brokers' in settings ? settings.brokers : [],
        tls: settings?.tls === true, saslMechanism: settings && 'saslMechanism' in settings ? settings.saslMechanism : 'none',
        username: settings?.username || '', password: '', environment: normalizeEnvironment(editing.environment),
        rememberPassword: !!editing.hasPassword,
      }
    }
    return {
      name: '', dialect: 'kafka', brokers: [], tls: false, saslMechanism: 'none', username: '', password: '',
      environment: 'sit', rememberPassword: passwordStorage !== false,
    }
  },
  showCredentials(input) {
    return input.dialect === 'kafka' && input.saslMechanism !== 'none'
  },
  fields(input, patch) {
    if (input.dialect !== 'kafka') return null
    return <>
      <label className="db-form-label">Broker 地址 · 每行一个<textarea required rows={3} value={input.brokers.join('\n')} onChange={event => patch({ brokers: event.target.value.split(/[\s,]+/).filter(Boolean) })} placeholder={'broker1.example:9092\nbroker2.example:9092'} /></label>
      <details className="db-form-advanced"><summary>高级连接设置</summary><label className="db-remember"><input type="checkbox" checked={input.tls} onChange={event => patch({ tls: event.target.checked, ...(!event.target.checked ? { caPem: '' } : {}) })} />启用 TLS 并验证证书</label>
      {input.tls && <label className="db-form-label">自定义 CA 证书 · 可选<textarea rows={4} value={input.caPem || ''} onChange={event => patch({ caPem: event.target.value })} placeholder="-----BEGIN CERTIFICATE-----" /></label>}
      </details>
      <label className="db-form-label">认证机制<select value={input.saslMechanism} onChange={event => patch({ saslMechanism: event.target.value as KafkaConnectionInput['saslMechanism'], ...(event.target.value === 'none' ? { username: '', password: '' } : {}) })}>
        <option value="none">无认证</option><option value="plain">SASL PLAIN</option><option value="scram-sha-256">SCRAM-SHA-256</option><option value="scram-sha-512">SCRAM-SHA-512</option>
      </select></label>
      {input.saslMechanism === 'plain' && !input.tls && <p className="db-muted">凭据通过未加密连接传输，请用于可信网络。</p>}
    </>
  },
}

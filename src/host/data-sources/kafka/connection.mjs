import { createHash } from 'node:crypto'
import { isIP } from 'node:net'

const MECHANISMS = new Set(['none', 'plain', 'scram-sha-256', 'scram-sha-512'])
const HOST = /^(?:[a-z\d](?:[a-z\d.-]{0,251}[a-z\d])?)$/i

function brokerAddress(value) {
  if (typeof value !== 'string') throw new Error('Broker 地址无效。')
  const text = value.trim()
  const match = /^(\[[^\]]+\]|[^:]+):(\d{1,5})$/.exec(text)
  if (!match || Number(match[2]) < 1 || Number(match[2]) > 65535) throw new Error('Broker 应写为主机:端口或 [IPv6]:端口。')
  const rawHost = match[1]
  const host = rawHost.startsWith('[') ? rawHost.slice(1, -1) : rawHost
  if (rawHost.startsWith('[') ? isIP(host) !== 6 : !HOST.test(host) && !isIP(host)) throw new Error('Broker 主机无效。')
  return `${rawHost.toLowerCase()}:${Number(match[2])}`
}

export function normalizeKafkaConfig(raw, options = {}) {
  if (!raw || typeof raw !== 'object') throw new Error('Kafka 连接信息无效。')
  const brokers = Array.isArray(raw.brokers) ? raw.brokers : typeof raw.brokers === 'string' ? raw.brokers.split(/[\s,]+/).filter(Boolean) : []
  if (!brokers.length || brokers.length > 16) throw new Error('请填写 1 到 16 个 Broker 地址。')
  const unique = [...new Set(brokers.map(brokerAddress))].sort()
  const tls = raw.tls === true
  if (raw.tls !== undefined && typeof raw.tls !== 'boolean') throw new Error('TLS 选项无效。')
  const saslMechanism = raw.saslMechanism ?? 'none'
  if (!MECHANISMS.has(saslMechanism)) throw new Error('不支持此 Kafka 认证机制。')
  const username = typeof raw.username === 'string' ? raw.username.trim() : ''
  const password = typeof raw.password === 'string' ? raw.password : ''
  const caPem = typeof raw.caPem === 'string' ? raw.caPem : ''
  if (username.length > 128 || password.length > 4096 || caPem.length > 131072) throw new Error('Kafka 连接字段超出长度限制。')
  if (saslMechanism !== 'none' && (!username || (!password && !raw.useSavedPassword && !options.passwordOptional))) throw new Error('SASL 需要用户名和密码。')
  if (caPem && (!tls || !/-----BEGIN CERTIFICATE-----[\s\S]+-----END CERTIFICATE-----/.test(caPem))) throw new Error('自定义 CA 证书无效。')
  const name = typeof raw.name === 'string' && raw.name.trim() ? raw.name.trim().slice(0, 80) : `Kafka · ${unique[0]}`
  const environment = ['sit', 'uat', 'pvt'].includes(String(raw.environment || '').toLowerCase()) ? String(raw.environment).toLowerCase() : 'sit'
  return { name, dialect: 'kafka', brokers: unique, tls, saslMechanism, username: saslMechanism === 'none' ? '' : username,
    password: saslMechanism === 'none' ? '' : password, caPem, environment,
    rememberPassword: raw.rememberPassword === true, useSavedPassword: raw.useSavedPassword === true }
}

export function kafkaFingerprint(config) {
  const value = normalizeKafkaConfig(config, { passwordOptional: true })
  const caDigest = value.caPem ? kafkaCaDigest(value.caPem) : String(config.caDigest || '')
  return ['kafka', ...value.brokers, String(value.tls), value.saslMechanism, value.username, caDigest].join('\0')
}

export const kafkaCaDigest = caPem => caPem ? createHash('sha256').update(caPem).digest('hex') : ''

export function kafkaWorkerConfig(config) {
  const value = normalizeKafkaConfig(config)
  return {
    clientId: `dsh-kafka-${Math.random().toString(36).slice(2, 10)}`,
    brokers: value.brokers,
    allowAutoTopicCreation: false,
    connectionTimeout: 8000,
    requestTimeout: 10000,
    retry: { retries: 0 },
    ...(value.tls ? { ssl: value.caPem ? { rejectUnauthorized: true, ca: [value.caPem] } : { rejectUnauthorized: true } } : {}),
    ...(value.saslMechanism !== 'none' ? { sasl: { mechanism: value.saslMechanism, username: value.username, password: value.password } } : {}),
  }
}

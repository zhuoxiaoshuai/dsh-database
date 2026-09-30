/** Runtime copy for host worker threads (shipped as lib/shared/connection-permission.mjs). */

export const environmentLabel = {
  sit: 'SIT · 可编辑',
  uat: 'UAT · 人工 SQL 可写',
  pvt: 'PVT · 人工 SQL 可写',
}

export function normalizeEnvironment(value) {
  const raw = String(value || '').toLowerCase()
  if (raw === 'sit' || raw === 'uat' || raw === 'pvt') return raw
  if (raw === 'dev' || raw === 'test') return 'sit'
  if (raw === 'staging') return 'uat'
  if (raw === 'prod') return 'pvt'
  return 'uat'
}

export function isWritableEnvironment(env) {
  return normalizeEnvironment(env) === 'sit'
}

export type Environment = 'sit' | 'uat' | 'pvt'

export { environmentLabel, normalizeEnvironment, isWritableEnvironment } from './connection-permission.mjs'

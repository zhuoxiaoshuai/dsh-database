export type ConnectionFailureCategory = 'network' | 'authentication' | 'configuration' | 'permission' | 'operation' | 'cancelled' | 'internal'
export interface ConnectionLifecycle {
  operationId: string
  kind: 'connect' | 'update' | 'recover'
  status: 'queued' | 'running' | 'succeeded' | 'failed' | 'cancelled'
  category?: ConnectionFailureCategory
  message?: string
  nextRetryAt?: number
}
export interface ConnectionStart { connectionId: string; operationId: string }

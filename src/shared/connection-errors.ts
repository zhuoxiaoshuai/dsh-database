export const CONNECTION_ERROR_CODES = {
  offline: 'connection_offline',
  stale: 'connection_stale',
  closed: 'connection_closed',
  session: 'session_invalid',
  busy: 'connection_busy',
  timeout: 'connection_timeout',
  cancelled: 'request_cancelled',
} as const

export type ConnectionErrorCode = typeof CONNECTION_ERROR_CODES[keyof typeof CONNECTION_ERROR_CODES]

const OFFLINE_CODES = new Set<string>([
  CONNECTION_ERROR_CODES.offline,
  CONNECTION_ERROR_CODES.closed,
])

export class ConnectionRequestError extends Error {
  readonly code?: ConnectionErrorCode | string
  readonly connectionId?: string
  constructor(message: string, code?: ConnectionErrorCode | string, connectionId?: string) {
    super(message)
    this.name = 'ConnectionRequestError'
    this.code = code
    this.connectionId = connectionId
  }
}

export class ServiceError extends Error {
  readonly code: ConnectionErrorCode
  constructor(message: string, code: ConnectionErrorCode) {
    super(message)
    this.name = 'ServiceError'
    this.code = code
  }
}

export function inferConnectionErrorCode(message: string): ConnectionErrorCode | undefined {
  if (/当前对话已失效|不属于当前对话/.test(message)) return CONNECTION_ERROR_CODES.session
  if (/请先连接数据库|连接不存在/.test(message)) return CONNECTION_ERROR_CODES.offline
  if (/连接已变化|连接或对话已变化|原连接已变化/.test(message)) return CONNECTION_ERROR_CODES.stale
  if (/连接已关闭|连接已中断/.test(message)) return CONNECTION_ERROR_CODES.closed
  if (/正在保存|正在维护|维护操作正在执行|正在处理请求|排队已满|已有查询正在执行/.test(message)) return CONNECTION_ERROR_CODES.busy
  if (/超时|维护超时/.test(message)) return CONNECTION_ERROR_CODES.timeout
  if (/已取消|aborted/i.test(message)) return CONNECTION_ERROR_CODES.cancelled
  return undefined
}

export function errorCodeOf(error: unknown): string | undefined {
  if (error && typeof error === 'object' && 'code' in error && typeof (error as { code?: unknown }).code === 'string') {
    return (error as { code: string }).code
  }
  return undefined
}

export function connectionIdOf(error: unknown): string | undefined {
  if (error && typeof error === 'object' && 'connectionId' in error && typeof (error as { connectionId?: unknown }).connectionId === 'string') {
    return (error as { connectionId: string }).connectionId
  }
  return undefined
}

export function isAbortError(error: unknown, signal?: AbortSignal): boolean {
  if (signal?.aborted) return true
  if (errorCodeOf(error) === CONNECTION_ERROR_CODES.cancelled) return true
  if (error && typeof error === 'object' && 'name' in error && (error as { name?: string }).name === 'AbortError') return true
  const message = error instanceof Error ? error.message : typeof error === 'string' ? error : ''
  return /aborted|AbortError|请求已取消|读取已取消/i.test(message)
}

export function shouldMarkConnectionOffline(code?: string, message = ''): boolean {
  if (code === CONNECTION_ERROR_CODES.cancelled || isAbortError(message ? new Error(message) : undefined)) return false
  if (code === CONNECTION_ERROR_CODES.stale || code === CONNECTION_ERROR_CODES.session || code === CONNECTION_ERROR_CODES.busy || code === CONNECTION_ERROR_CODES.timeout) return false
  if (code && OFFLINE_CODES.has(code)) return true
  return /请先连接数据库|连接不存在|连接已关闭|连接已中断/.test(message)
}

export function keepResultOnFailure(message: string, code?: string): boolean {
  if (code === CONNECTION_ERROR_CODES.stale || code === CONNECTION_ERROR_CODES.session) return true
  return shouldMarkConnectionOffline(code, message) || /结果未知|维护超时|连接已变化|当前对话已失效/.test(message)
}

export function httpStatusForConnectionError(code?: string): number {
  return code === CONNECTION_ERROR_CODES.session ? 404 : 400
}

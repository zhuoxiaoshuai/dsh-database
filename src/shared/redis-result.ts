/** Redis RESP values remain distinct from SQL Result rows and columns. */
export type RedisValue =
  | { type: 'nil' | 'truncated' }
  | { type: 'integer' | 'string' | 'error'; value: string; length?: number }
  | { type: 'binary'; value: string; length: number; encoding: 'base64' }
  | { type: 'array' | 'set'; value: RedisValue[] }
  | { type: 'map'; value: [RedisValue, RedisValue][] }

export interface RedisEncodedResult { result: RedisValue; truncated: boolean }
export interface RedisCommandResult extends RedisEncodedResult { elapsedMs: number; failed?: boolean }
export interface RedisScanResult { cursor: string; keys: string[]; scanned: number; complete: boolean }
export interface RedisKeySuggestResult { keys: string[]; complete: boolean; scannedPages: number }
export interface RedisKeyRow { id: string; cells: Record<string, string> }
export interface RedisKeyCardLine { label: string; value: string }
export interface RedisKeyCard { count?: string; lines?: RedisKeyCardLine[] }
export interface RedisKeyResult { key: string; keyType: string; ttl: number; value: RedisEncodedResult; cursor?: string; offset: number; more: boolean; rows?: RedisKeyRow[]; card?: RedisKeyCard }
export interface RedisMutationResult { result: RedisEncodedResult }
export type RedisResponse = RedisCommandResult | RedisScanResult | RedisKeySuggestResult | RedisKeyResult | RedisMutationResult

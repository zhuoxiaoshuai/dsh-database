/** Redis RESP values remain distinct from SQL Result rows and columns. */
export type RedisValue =
  | { type: 'nil' | 'truncated' }
  | { type: 'integer' | 'string' | 'error'; value: string; length?: number }
  | { type: 'binary'; value: string; length: number; encoding: 'base64' }
  | { type: 'array' | 'set'; value: RedisValue[] }
  | { type: 'map'; value: [RedisValue, RedisValue][] }

export interface RedisEncodedResult { result: RedisValue; truncated: boolean }
export interface RedisCommandResult extends RedisEncodedResult { elapsedMs: number; failed?: boolean }
/** keys 是 latin1 字节串（码点 0x00–0xFF 与字节 1:1），展示前用 displayBytes 转义，回传时原样使用。 */
export interface RedisScanResult { cursor: string; keys: string[]; scanned: number; complete: boolean }
export interface RedisKeySuggestResult { keys: string[]; complete: boolean; scannedPages: number }
export interface RedisKeyRow { id: string; cells: Record<string, string> }
export interface RedisKeyCardLine { label: string; value: string }
export interface RedisKeyCard { count?: string; lines?: RedisKeyCardLine[] }
/** key 与 rows[].cells 同为 latin1 字节串；value 仍是 UTF-8 / base64 编码的 RedisValue。 */
export interface RedisKeyResult { key: string; keyType: string; ttl: number; value: RedisEncodedResult; cursor?: string; offset: number; more: boolean; rows?: RedisKeyRow[]; card?: RedisKeyCard }
export interface RedisMutationResult { result: RedisEncodedResult }
export type RedisResponse = RedisCommandResult | RedisScanResult | RedisKeySuggestResult | RedisKeyResult | RedisMutationResult

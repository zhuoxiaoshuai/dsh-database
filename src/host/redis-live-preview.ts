/** In-memory workbench event only. Large values stay in the tool response, never in execution history. */
export function redisLivePreview(result: Record<string, unknown>): Record<string, unknown> {
  const size = Buffer.byteLength(JSON.stringify(result))
  return size <= 64 * 1024 ? result : { result: { type: 'truncated' }, truncated: true, elapsedMs: result.elapsedMs }
}

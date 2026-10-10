export type ToolExecution = {callId?: string; rootCallId?: string; signal?: AbortSignal; agent?: {session?: {id?: string}}}
export function toolOwner(execution: ToolExecution, validOwner: (id: string) => boolean): string {
  const id = execution.agent?.session?.id || ''
  if (!validOwner(id)) throw new Error('当前工具调用缺少有效对话身份。')
  if (execution.signal?.aborted) throw new Error('请求已取消。')
  return id
}

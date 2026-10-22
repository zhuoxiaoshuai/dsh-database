export type KnowledgeRunStatus = 'running' | 'stopping' | 'succeeded' | 'failed' | 'cancelled' | 'unknown'

export type KnowledgeExecutionSnapshot = {
  editorText: string
  executedText: string
  target: string
  status: KnowledgeRunStatus
}

export type KnowledgeRunTicket = {
  readonly owner: symbol
  readonly epoch: number
  readonly identity: string
  readonly controller: AbortController
  readonly receiptController: AbortController
  readonly snapshot: KnowledgeExecutionSnapshot
}

/** Selection and editing do not invalidate an execution. Only its lifecycle and ticket do. */
export class KnowledgeExecutionScope {
  private epoch = 0
  private ticket?: KnowledgeRunTicket
  private identity: string
  constructor(identity: string) { this.identity = identity }
  setIdentity(identity: string): void {
    if (identity !== this.identity) { this.invalidate(); this.identity = identity }
  }
  get current(): KnowledgeRunTicket | undefined { return this.ticket }
  begin(owner: symbol, editorText: string, executedText: string, target: string): KnowledgeRunTicket | undefined {
    if (this.ticket) return undefined
    const ticket: KnowledgeRunTicket = { owner, epoch: this.epoch, identity: this.identity,
      controller: new AbortController(), receiptController: new AbortController(), snapshot: { editorText, executedText, target, status: 'running' } }
    this.ticket = ticket
    return ticket
  }
  owns(ticket: KnowledgeRunTicket): boolean {
    return this.ticket === ticket && ticket.epoch === this.epoch && ticket.identity === this.identity
  }
  finish(ticket: KnowledgeRunTicket): boolean {
    if (!this.owns(ticket)) return false
    this.ticket = undefined
    return true
  }
  stop(): void { this.ticket?.controller.abort() }
  invalidate(): void {
    const previous = this.ticket
    this.ticket = undefined; this.epoch += 1
    previous?.controller.abort()
    previous?.receiptController.abort()
  }
}

export type KnowledgeCommandReceipt = {
  result?: unknown
  error: string
  status: KnowledgeRunStatus
  executionId?: string
}

/** Keep source-native payloads, including trusted partial results attached to errors. */
export function knowledgeCommandReceipt(value: unknown, failed = false): KnowledgeCommandReceipt {
  const receipt = value && typeof value === 'object' ? value as Record<string, unknown> : {}
  const declared = receipt.executionStatus ?? receipt.status
  const status: KnowledgeRunStatus = receipt.effect === 'unknown' || receipt.trustedReceipt === false && receipt.effect !== 'none' ? 'unknown'
    : declared === 'failed' || declared === 'cancelled' || declared === 'unknown' || declared === 'succeeded' ? declared
    : failed || receipt.failed === true ? 'failed' : 'succeeded'
  const result = failed ? receipt.trustedReceipt !== false && receipt.sourceResult && typeof receipt.sourceResult === 'object' ? receipt.sourceResult : undefined : value
  const error = failed || status !== 'succeeded' ? value instanceof Error ? value.message
    : typeof receipt.message === 'string' ? receipt.message : status === 'unknown' ? '执行结果未知，请核验，勿重复提交。' : '命令未成功完成。' : ''
  return { result, error, status, executionId: typeof receipt.executionId === 'string' ? receipt.executionId : undefined }
}

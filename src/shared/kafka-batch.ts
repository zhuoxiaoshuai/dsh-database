import { KAFKA_BATCH_MAX_COMMANDS, KAFKA_DOCUMENT_MAX_LENGTH, isKafkaWrite, parseKafkaCommand } from './kafka-command.mjs'

export type KafkaOperation = ReturnType<typeof parseKafkaCommand>
export type KafkaStepStatus = 'pending' | 'running' | 'succeeded' | 'failed' | 'skipped' | 'cancelled' | 'unknown'
export type KafkaCommandRange = { text: string; from: number; to: number; operation: KafkaOperation }
export type KafkaStep = KafkaCommandRange & { index: number; status: KafkaStepStatus; result?: Record<string, any>; error?: string; executionId?: string }
export const kafkaStepLabel = (status: KafkaStepStatus) => ({ pending: '待执行', running: '执行中', succeeded: '成功', failed: '失败', skipped: '未执行', cancelled: '已取消', unknown: '结果未知' })[status]

/** Newlines/semicolons delimit commands only outside JSON and quoted strings. */
export function splitKafkaCommands(text: string): KafkaCommandRange[] {
  if (text.length > KAFKA_DOCUMENT_MAX_LENGTH) throw new Error('查询内容不能超过 512 KiB 字符。')
  const ranges: KafkaCommandRange[] = []
  let start = 0, quoted = false, escaped = false
  const stack: string[] = []
  const location = (at: number) => `第 ${text.slice(0, at).split('\n').length} 行`
  const append = (end: number) => {
    const raw = text.slice(start, end), value = raw.trim()
    if (!value) return
    const from = start + raw.indexOf(value)
    if (ranges.length >= KAFKA_BATCH_MAX_COMMANDS) throw new Error(`一次最多执行 ${KAFKA_BATCH_MAX_COMMANDS} 条 Kafka 命令。`)
    try { ranges.push({ text: value, from, to: from + value.length, operation: parseKafkaCommand(value) }) }
    catch (error) { throw new Error(`${location(from)}，命令 ${ranges.length + 1}：${error instanceof Error ? error.message : '参数无效'}`) }
  }
  for (let i = 0; i < text.length; i++) {
    const char = text[i]
    if (quoted) {
      if (escaped) escaped = false
      else if (char === '\\') escaped = true
      else if (char === '"') quoted = false
      continue
    }
    if (char === '"') quoted = true
    else if (char === '{' || char === '[') stack.push(char)
    else if (char === '}' || char === ']') {
      if (stack.pop() !== (char === '}' ? '{' : '[')) throw new Error(`${location(i)}：JSON 括号不匹配。`)
    } else if (!stack.length && (char === '\n' || char === '\r' || char === ';')) { append(i); start = i + 1 }
  }
  if (quoted || stack.length) throw new Error(`${location(start)}：命令不完整，请选择完整命令；检查引号和 JSON 括号。`)
  append(text.length)
  return ranges
}

export function createKafkaBatch(text: string): KafkaStep[] {
  const commands = splitKafkaCommands(text)
  if (!commands.length) throw new Error('请先输入或生成 Kafka 命令。')
  return commands.map((range, index) => ({ ...range, index, status: 'pending' }))
}

export function kafkaWriteSummary(steps: KafkaCommandRange[]): string[] {
  return steps.flatMap((step, index) => {
    const operation = step.operation as Record<string, any>
    if (!isKafkaWrite(operation.kind)) return []
    const label = step.text.split(/\s/, 1)[0].toUpperCase()
    let detail = `${index + 1}. ${label} · ${operation.topic}`
    if (operation.kind === 'produce-batch') detail += ` · ${operation.messages.length} 条`
    if (operation.kind === 'create-topic') detail += ` · ${operation.partitions} 分区 / ${operation.replicationFactor} 副本 / ${operation.cleanupPolicy}`
    if (operation.kind === 'set-group-offsets') detail += ` · 消费组 ${operation.groupId}\n旧位置 ${JSON.stringify(operation.expected)}\n目标 ${operation.offsets ? JSON.stringify(operation.offsets) : `时间 ${operation.timestamp} / 分区 ${operation.partitions.join(', ')}`}`
    return [detail]
  })
}

/** UI sequencing only. Each command still owns one authoritative Host execution. */
export async function runKafkaBatch(input: {
  steps: KafkaStep[]; signal: AbortSignal
  execute(text: string, signal: AbortSignal): Promise<unknown>
  onChange?(steps: KafkaStep[]): void
}): Promise<KafkaStep[]> {
  const steps = input.steps.map(step => ({ ...step }))
  const emit = () => input.onChange?.(steps.map(step => ({ ...step })))
  for (const step of steps) {
    if (input.signal.aborted) break
    step.status = 'running'; emit()
    try {
      const reply = await input.execute(step.text, input.signal)
      const result = reply && typeof reply === 'object' ? reply as Record<string, any> : {}
      step.result = result
      step.executionId = result.executionId
      // A resolved HTTP request is not a successful Kafka operation.
      step.status = ['succeeded', 'failed', 'cancelled', 'unknown'].includes(result.executionStatus) ? result.executionStatus : 'unknown'
      if (step.status !== 'succeeded') step.error = result.message || (step.status === 'unknown' ? '未收到可信成功回执，请核验。' : '命令未成功完成。')
    } catch (error) {
      const failure = error as { executionStatus?: string; executionId?: string; effect?: string; trustedReceipt?: boolean; sourceResult?: Record<string, any> }
      const status = failure?.executionStatus
      step.executionId = failure?.executionId
      if (failure?.trustedReceipt !== false && failure?.sourceResult && typeof failure.sourceResult === 'object') step.result = failure.sourceResult
      step.status = failure?.effect === 'unknown' || failure?.trustedReceipt === false && failure?.effect !== 'none' ? 'unknown'
        : status && ['failed', 'cancelled', 'unknown'].includes(status) ? status as KafkaStepStatus
        : failure?.effect === 'none' ? (input.signal.aborted ? 'cancelled' : 'failed')
        : isKafkaWrite(step.operation.kind) ? 'unknown' : input.signal.aborted ? 'cancelled' : 'failed'
      step.error = error instanceof Error ? error.message : '命令执行失败。'
    }
    emit()
    if (step.status !== 'succeeded') break
  }
  for (const step of steps) if (step.status === 'pending') { step.status = 'skipped'; step.error = input.signal.aborted ? '已停止，未派发。' : '前序命令未成功，未派发。' }
  emit()
  return steps
}

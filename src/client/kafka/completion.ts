import type { CompletionSource } from '@codemirror/autocomplete'

const HELP = [
  { label: 'TOPICS', detail: '列出当前账号可见的 Topic', help: '读取 Topic 名称列表；结果按页显示。示例：TOPICS' },
  { label: 'DESCRIBE', detail: '查看 Topic 的分区、水位与副本', help: '后面输入 JSON 双引号包裹的 Topic 名称。示例：DESCRIBE "orders"' },
  { label: 'PEEK', detail: '有界读取单个分区消息', help: '指定 Topic、分区、起点和条数。示例：PEEK "orders" PARTITION 0 FROM LATEST LIMIT 20' },
  { label: 'PARTITION', detail: '指定一个分区编号', help: 'PEEK 一次只读取一个分区。分区编号从 0 开始。' },
  { label: 'FROM', detail: '指定读取起点', help: '支持 BEGINNING、LATEST 或 OFFSET 后跟十进制 offset。' },
  { label: 'BEGINNING', detail: '从当前低水位开始读取', help: '从本次读取开始时可用的最早位置开始。' },
  { label: 'LATEST', detail: '读取靠近高水位的消息', help: '从 max(低水位, 高水位 - LIMIT) 开始。压缩或 offset 空洞可能让返回条数不足。' },
  { label: 'OFFSET', detail: '从指定 offset 开始', help: '后面输入非负十进制整数；高精度 offset 不会被转成浮点数。' },
  { label: 'LIMIT', detail: '限制最多返回的消息条数', help: '可省略，默认 20；范围是 1～200。' },
  { label: 'GROUPS', detail: '列出消费组', help: '读取可见消费组，不含内部临时读取组。示例：GROUPS' },
  { label: 'GROUP', detail: '查看消费组或某个 Topic 的进度', help: 'GROUP "组名" 查看成员；再写 TOPIC 和 Topic 名查看分区消费进度。示例：GROUP "billing" TOPIC "orders"' },
  { label: 'TOPIC', detail: '在 GROUP 后指定 Topic', help: '只计算这一个 Topic 的水位和积压。示例：GROUP "billing" TOPIC "orders"' },
] as const

const ROOT = new Set(['TOPICS', 'DESCRIBE', 'PEEK', 'GROUPS', 'GROUP'])
const PEEK_WORDS = new Set(['PARTITION', 'FROM', 'BEGINNING', 'LATEST', 'OFFSET', 'LIMIT'])

export const kafkaHelp = HELP

export const createKafkaCompletionSource = (): CompletionSource => context => {
  const before = context.state.sliceDoc(0, context.pos)
  const current = context.matchBefore(/[A-Za-z-]*/)
  if (!current || (!context.explicit && !current.text)) return null
  const tokens = before.trimStart().split(/\s+/)
  const command = tokens[0]?.toUpperCase() || ''
  const options = !command || tokens.length <= 1 ? HELP.filter(item => ROOT.has(item.label))
    : command === 'PEEK' ? HELP.filter(item => PEEK_WORDS.has(item.label))
    : command === 'GROUP' ? HELP.filter(item => item.label === 'TOPIC') : []
  const filtered = options.filter(item => item.label.startsWith(current.text.toUpperCase()))
  return filtered.length ? { from: current.from, options: filtered.map(item => ({
    label: item.label, type: 'keyword', detail: item.detail,
    info: item.help,
  })) } : null
}

export function kafkaParameterHint(text: string): string {
  const upper = text.trim().toUpperCase()
  if (!upper) return '输入 TOPICS、DESCRIBE、PEEK、GROUPS 或 GROUP；每次只执行一条只读命令。'
  if (/^DESCRIBE\b/.test(upper)) return 'Topic 使用 JSON 双引号，例如 DESCRIBE "orders"。'
  if (/^PEEK\b/.test(upper)) return '依次输入 Topic、PARTITION 编号、FROM 起点，LIMIT 可省略（默认 20，最多 200）。'
  if (/^TOPICS\b/.test(upper)) return '列出当前账号可见的 Topic，结果可能分页。'
  if (/^GROUPS\b/.test(upper)) return '列出可见消费组，不含 dsh-peek- 临时读取组。'
  if (/^GROUP\b/.test(upper)) return 'GROUP "组名" 查看成员；GROUP "组名" TOPIC "Topic" 查看该 Topic 的分区消费进度。'
  return '只支持 TOPICS、DESCRIBE、PEEK、GROUPS 和 GROUP 只读命令。'
}

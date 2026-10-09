import type { CompletionSource } from '@codemirror/autocomplete'

const HELP = [
  { label: 'TOPICS', detail: '搜索、分页列出账号可见的 Topic', help: 'SEARCH 按名称片段匹配，CURSOR 使用上一页返回的位置。列表变化可能重复或遗漏。示例：TOPICS SEARCH "orders" CURSOR 100' },
  { label: 'DESCRIBE', detail: '查看 Topic 分区、水位与副本', help: 'Topic 使用 JSON 双引号；点击分区可创建有界读取草稿。示例：DESCRIBE "orders"' },
  { label: 'PEEK', detail: '有界读取单个分区消息', help: '指定 Topic、分区、起点和数量；不提交消费位置。示例：PEEK "orders" PARTITION 0 FROM LATEST LIMIT 20' },
  { label: 'PRODUCE', detail: 'SIT 发布单条文本或 Base64 消息', help: '示例：PRODUCE {"topic":"orders","key":"test-1","value":"hello"}；二进制值用 {"base64":"..."}。单条最多 64 KiB。草稿保存内容，未知结果先核对。' },
  { label: 'PRODUCE_BATCH', detail: 'SIT 限量顺序发布', help: '示例：PRODUCE_BATCH {"topic":"orders","messages":[{"value":"a"},{"value":"b"}]}。最多 10 条、合计 256 KiB；部分成功逐条显示。' },
  { label: 'TOMBSTONE', detail: 'SIT 发布压缩 Topic 墓碑', help: '示例：TOMBSTONE {"topic":"dsh-test-events","key":"k"}。需 compact 策略；清理异步发生。' },
  { label: 'CREATE_TOPIC', detail: '创建 SIT 测试 Topic', help: '示例：CREATE_TOPIC {"topic":"dsh-test-events","partitions":1,"replicationFactor":1,"cleanupPolicy":"delete"}。' },
  { label: 'SET_GROUP_OFFSETS', detail: 'SIT 调整无成员消费组位点', help: '填写 groupId、topic、expected，及 offsets 或 timestamp/partitions；执行前比对已提交旧位置。' },
  { label: 'TOPIC_CONFIG', detail: '查看 Topic 配置', help: '示例：TOPIC_CONFIG "orders"。查看清理、保留和副本相关配置。' },
  { label: 'TIME_OFFSETS', detail: '按时间定位各分区', help: '示例：TIME_OFFSETS {"topic":"orders","timestamp":1760000000000}。时间单位毫秒。' },
  { label: 'SCAN', detail: '跨分区有界扫描', help: '示例：SCAN {"topic":"orders","partitions":[0,1],"timestamp":1760000000000}；可加 key 或 header 精确匹配。' },
  { label: 'GROUPS', detail: '搜索、分页列出消费组', help: '不显示 dsh-peek- 临时读取组。示例：GROUPS SEARCH "billing" CURSOR 100' },
  { label: 'GROUP', detail: '查看消费组成员、关联 Topic 或积压', help: 'GROUP "billing" 查看成员；GROUP "billing" TOPICS 列出关联 Topic；GROUP "billing" TOPIC "orders" 查看提交位置和积压。' },
  { label: 'TOPIC', detail: '查看消费组在一个 Topic 的进度', help: '后面填写 Topic 的 JSON 双引号名称；没有提交位置或读取权限时指标显示未知。示例：GROUP "billing" TOPIC "orders"' },
  { label: 'PARTITION', detail: '指定单个分区编号', help: '分区编号从 0 开始，一次只读取一个分区。示例：PARTITION 0' },
  { label: 'FROM', detail: '指定读取起点', help: '支持 BEGINNING、LATEST 或 OFFSET 后跟非负十进制位置。' },
  { label: 'BEGINNING', detail: '从当前低水位读取', help: '从本次操作开始时可用的最早位置读取，不追踪后续写入。' },
  { label: 'LATEST', detail: '读取接近高水位的消息', help: '起点为 max(低水位, 高水位 - LIMIT)。压缩、控制记录或 offset 空洞可能导致条数不足。' },
  { label: 'OFFSET', detail: '指定精确的读取位置', help: '后面填写非负十进制整数；大整数不会转成浮点数。示例：OFFSET 9007199254740993' },
  { label: 'LIMIT', detail: '限制最多返回的消息条数', help: '默认 20，范围 1～200；也受总字节和截止时间限制。' },
  { label: 'SEARCH', detail: '按名称片段筛选列表', help: '后面填写 JSON 双引号字符串；不是正则或通配符。必须放在 CURSOR 之前。示例：SEARCH "orders"' },
  { label: 'CURSOR', detail: '读取列表的下一页', help: '填写上一页的 nextCursor；每页最多 100 项。列表变化时建议从第一页刷新。示例：CURSOR 100' },
] as const
export const kafkaHelp = HELP
export type KafkaNames = { topics: readonly string[]; groups: readonly string[] }
type Token = { from: number; to: number; text: string; quoted: boolean }

/** Tolerant input lexer; Host parsing is authoritative. */
function tokensOf(text: string): Token[] {
  const tokens: Token[] = []
  let i = 0
  while (i < text.length) {
    if (/\s/.test(text[i])) { i += 1; continue }
    const from = i, quoted = text[i] === '"'
    if (quoted) {
      i += 1
      while (i < text.length) {
        if (text[i] === '\\') { i = Math.min(text.length, i + 2); continue }
        if (text[i++] === '"') break
      }
    } else while (i < text.length && !/\s/.test(text[i])) i += 1
    tokens.push({ from, to: i, text: text.slice(from, i), quoted })
  }
  return tokens
}

export function kafkaCompletionSlot(text: string, pos: number): { from: number; to: number; prefix: string; names?: 'topics' | 'groups'; keywords: string[] } | null {
  const tokens = tokensOf(text)
  let index = tokens.findIndex(token => pos >= token.from && pos <= token.to)
  const token = index < 0 ? undefined : tokens[index]
  if (index < 0) index = tokens.filter(item => item.to < pos).length
  const command = tokens[0]?.text.toUpperCase() || ''
  const previous = tokens.slice(0, index).map(item => item.text.toUpperCase())
  let names: 'topics' | 'groups' | undefined, keywords: string[] = []
  if (index === 0) keywords = ['TOPICS', 'DESCRIBE', 'PEEK', 'GROUPS', 'GROUP', 'PRODUCE', 'PRODUCE_BATCH', 'TOMBSTONE', 'CREATE_TOPIC', 'SET_GROUP_OFFSETS', 'TOPIC_CONFIG', 'TIME_OFFSETS', 'SCAN']
  else if (['DESCRIBE', 'PEEK', 'TOPIC_CONFIG'].includes(command) && index === 1) names = 'topics'
  else if (command === 'GROUP' && index === 1) names = 'groups'
  else if (command === 'GROUP' && index === 2) keywords = ['TOPIC', 'TOPICS']
  else if (command === 'GROUP' && previous[2] === 'TOPIC' && index === 3) names = 'topics'
  else if (command === 'GROUP' && previous[2] === 'TOPICS' && index === 3) keywords = ['CURSOR']
  else if (command === 'TOPICS' || command === 'GROUPS') {
    if (index === 1) keywords = ['SEARCH', 'CURSOR']
    else if (previous[1] === 'SEARCH' && index === 3) keywords = ['CURSOR']
  } else if (command === 'PEEK') {
    if (index === 2) keywords = ['PARTITION']
    else if (index === 4) keywords = ['FROM']
    else if (index === 5) keywords = ['BEGINNING', 'LATEST', 'OFFSET']
    else if (index === (previous[5] === 'OFFSET' ? 7 : 6)) keywords = ['LIMIT']
  }
  let prefix = token ? text.slice(token.from, pos) : ''
  if (names && token?.quoted) {
    try { prefix = JSON.parse(prefix.endsWith('"') && prefix.length > 1 ? prefix : prefix + '"') } catch { return null }
  } else if (token?.quoted) return null
  return { from: token?.from ?? pos, to: token?.to ?? pos, prefix, names, keywords }
}

export const createKafkaCompletionSource = (getNames: () => KafkaNames = () => ({ topics: [], groups: [] })): CompletionSource => context => {
  const slot = kafkaCompletionSlot(context.state.doc.toString(), context.pos)
  if (!slot || (!context.explicit && !slot.prefix)) return null
  if (slot.names) {
    const candidates = getNames()[slot.names].filter(name => name.startsWith(slot.prefix)).slice(0, 30)
    return candidates.length ? { from: slot.from, to: slot.to, filter: false, options: candidates.map(name => ({ label: name,
      type: 'variable', detail: '本连接已读取的名称 · 候选可能不完整', apply: JSON.stringify(name) })) } : null
  }
  const options = HELP.filter(item => slot.keywords.includes(item.label) && item.label.startsWith(slot.prefix.toUpperCase()))
    .sort((a, b) => slot.keywords.indexOf(a.label) - slot.keywords.indexOf(b.label))
  return options.length ? { from: slot.from, to: slot.to, options: options.map(item => ({ label: item.label, type: 'keyword', detail: item.detail, info: item.help })) } : null
}

export function kafkaParameterHint(text: string): string {
  const command = text.trim().split(/\s/, 1)[0]?.toUpperCase()
  const item = HELP.find(item => item.label === command)
  return item ? item.help : '输入 Kafka 命令；每次只执行一条。'
}

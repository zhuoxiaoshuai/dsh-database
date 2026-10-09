const MAX_TEXT_LENGTH = 4096;
const MAX_WRITE_TEXT_LENGTH = 512 * 1024;
const MAX_OFFSET = (1n << 63n) - 1n;
const QUOTED = String.raw`"(?:\\.|[^"\\])*"`;
const DESCRIBE = new RegExp(`^DESCRIBE\\s+(${QUOTED})$`, 'i');
const GROUP = new RegExp(`^GROUP\\s+(${QUOTED})(?:\\s+TOPIC\\s+(${QUOTED}))?$`, 'i');
const LIST = new RegExp(`^(TOPICS|GROUPS)(?:\\s+SEARCH\\s+(${QUOTED}))?(?:\\s+CURSOR\\s+(\\d+))?$`, 'i');
const GROUP_TOPICS = new RegExp(`^GROUP\\s+(${QUOTED})\\s+TOPICS(?:\\s+CURSOR\\s+(\\d+))?$`, 'i');
const PEEK = new RegExp(`^PEEK\\s+(${QUOTED})\\s+PARTITION\\s+(\\d+)\\s+FROM\\s+(BEGINNING|LATEST|OFFSET\\s+\\d+)(?:\\s+LIMIT\\s+(\\d+))?$`, 'i');
const PRODUCE = /^PRODUCE\s+(\{[\s\S]*\})$/i;
const JSON_COMMAND = /^(PRODUCE_BATCH|TOMBSTONE|CREATE_TOPIC|SET_GROUP_OFFSETS|TIME_OFFSETS|SCAN)\s+(\{[\s\S]*\})$/i;
const TOPIC_CONFIG = new RegExp(`^TOPIC_CONFIG\\s+(${QUOTED})$`, 'i');

function jsonObject(literal, label) {
  let value;
  try { value = JSON.parse(literal); } catch { throw new Error(`${label} 参数必须是有效 JSON 对象。`); }
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error(`${label} 参数必须是 JSON 对象。`);
  return value;
}

function onlyKeys(value, allowed, label) {
  if (Object.keys(value).some(key => !allowed.includes(key))) throw new Error(`${label} 包含不支持的字段。`);
}

/** Strings remain UTF-8; {base64} carries exact Kafka bytes. */
export function kafkaBytes(value, label, { nullable = false } = {}) {
  if (nullable && value === null) return null;
  if (typeof value === 'string') return Buffer.from(value, 'utf8');
  if (!value || typeof value !== 'object' || Array.isArray(value) || Object.keys(value).length !== 1 || typeof value.base64 !== 'string')
    throw new Error(`${label} 必须是文本或 {base64}。`);
  const encoded = value.base64;
  if (encoded.length % 4 !== 0 || !/^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/.test(encoded)) throw new Error(`${label} Base64 无效。`);
  const bytes = Buffer.from(encoded, 'base64');
  if (bytes.toString('base64') !== encoded) throw new Error(`${label} Base64 无效。`);
  return bytes;
}

function messagePayload(value, label = '消息') {
  onlyKeys(value, ['key', 'value', 'partition', 'headers', 'replayFrom'], label);
  if (value.value === undefined || value.value === null) throw new Error(`${label} Value 必须提供；墓碑请使用 TOMBSTONE。`);
  let bytes = kafkaBytes(value.value, `${label} Value`).length;
  if (value.key !== undefined) bytes += kafkaBytes(value.key, `${label} Key`).length;
  if (value.partition !== undefined && (!Number.isInteger(value.partition) || value.partition < 0 || value.partition > 2147483647)) throw new Error('Partition 超出范围。');
  if (value.headers !== undefined) {
    if (!value.headers || typeof value.headers !== 'object' || Array.isArray(value.headers) || Object.keys(value.headers).length > 16) throw new Error('Headers 必须是最多 16 项的对象。');
    for (const [name, header] of Object.entries(value.headers)) {
      if (!name || Buffer.byteLength(name, 'utf8') > 128 || /[\u0000-\u001f\u007f]/u.test(name)) throw new Error('Header 名称无效。');
      for (const part of Array.isArray(header) ? header : [header]) bytes += kafkaBytes(part, `Header ${name}`).length;
      if (Array.isArray(header) && (header.length < 1 || header.length > 8)) throw new Error('单个 Header 最多 8 个值。');
    }
  }
  if (bytes > 64 * 1024) throw new Error(`${label} 解码后总量不能超过 64 KiB。`);
  if (value.replayFrom !== undefined) {
    const source = value.replayFrom;
    if (!source || typeof source !== 'object' || Array.isArray(source)) throw new Error('重放来源无效。');
    onlyKeys(source, ['topic', 'partition', 'offset'], '重放来源');
    assertKafkaTopic(source.topic);
    if (!Number.isInteger(source.partition) || source.partition < 0 || source.partition > 2147483647) throw new Error('重放来源分区无效。');
    decimal(String(source.offset), '重放来源 Offset');
  }
  return bytes;
}

function producePayload(literal) {
  const value = jsonObject(literal, 'PRODUCE');
  onlyKeys(value, ['topic', 'key', 'value', 'partition', 'headers', 'replayFrom'], 'PRODUCE');
  assertKafkaTopic(value.topic);
  const { topic: _topic, ...message } = value;
  messagePayload(message);
  return { kind: 'produce', topic: value.topic, ...(value.key !== undefined ? { key: value.key } : {}), value: value.value,
    ...(value.partition !== undefined ? { partition: value.partition } : {}), ...(value.headers !== undefined ? { headers: value.headers } : {}),
    ...(value.replayFrom !== undefined ? { replayFrom: value.replayFrom } : {}) };
}

export function assertKafkaTopic(topic) {
  if (typeof topic !== 'string' || !topic || Buffer.byteLength(topic, 'utf8') > 249 || /[\u0000-\u001f\u007f]/u.test(topic)) {
    throw new Error('Topic 名称无效');
  }
}

export function assertKafkaGroupId(groupId) {
  if (typeof groupId !== 'string' || !groupId || Buffer.byteLength(groupId, 'utf8') > 255 || /[\u0000-\u001f\u007f]/u.test(groupId)) {
    throw new Error('消费组名称无效');
  }
}

function parseTopic(literal) {
  let topic;
  try { topic = JSON.parse(literal); } catch { throw new Error('Topic 必须使用有效的 JSON 双引号字符串'); }
  assertKafkaTopic(topic);
  return topic;
}

function parseGroupId(literal) {
  let groupId;
  try { groupId = JSON.parse(literal); } catch { throw new Error('消费组必须使用有效的 JSON 双引号字符串'); }
  assertKafkaGroupId(groupId);
  return groupId;
}

function decimal(value, label) {
  if (!/^(0|[1-9]\d*)$/.test(value)) throw new Error(`${label} 必须是非负十进制整数`);
  const result = BigInt(value);
  if (result > MAX_OFFSET) throw new Error(`${label} 超出 Kafka offset 范围`);
  return result;
}

function pageCursor(value) {
  const cursor = decimal(String(value), 'CURSOR');
  if (cursor > 1000000n) throw new Error('CURSOR 超出页游标范围');
  return cursor.toString();
}

function searchText(literal) {
  let value;
  try { value = JSON.parse(literal); } catch { throw new Error('SEARCH 必须使用有效的 JSON 双引号字符串'); }
  if (typeof value !== 'string' || value.length > 256 || /[\u0000-\u001f\u007f]/u.test(value)) throw new Error('SEARCH 名称片段无效');
  return value;
}

function timestamp(value) {
  if (!Number.isSafeInteger(value) || value < 0 || value > 8640000000000000) throw new Error('时间必须是毫秒时间戳。');
  return value;
}

function partitionList(value) {
  if (!Array.isArray(value) || value.length < 1 || value.length > 8 || new Set(value).size !== value.length
    || value.some(item => !Number.isInteger(item) || item < 0 || item > 2147483647)) throw new Error('分区列表必须包含 1 到 8 个不同分区。');
  return value;
}

function offsetsMap(value, label, { nullable = false } = {}) {
  if (!value || typeof value !== 'object' || Array.isArray(value) || Object.keys(value).length < 1 || Object.keys(value).length > 8) throw new Error(`${label} 必须包含 1 到 8 个分区。`);
  for (const [partition, offset] of Object.entries(value)) {
    if (!/^(0|[1-9]\d*)$/.test(partition) || Number(partition) > 2147483647) throw new Error(`${label} 分区无效。`);
    if (offset === null && nullable) continue;
    decimal(String(offset), `${label} Offset`);
  }
  return value;
}

function jsonOperation(name, literal) {
  const value = jsonObject(literal, name);
  if (name === 'PRODUCE_BATCH') {
    onlyKeys(value, ['topic', 'messages'], name); assertKafkaTopic(value.topic);
    if (!Array.isArray(value.messages) || value.messages.length < 1 || value.messages.length > 10) throw new Error('批量发布必须包含 1 到 10 条消息。');
    let total = 0;
    for (const item of value.messages) {
      if (!item || typeof item !== 'object' || Array.isArray(item)) throw new Error('批量消息无效。');
      total += messagePayload(item, '批量消息');
    }
    if (total > 256 * 1024) throw new Error('批量消息解码后合计不能超过 256 KiB。');
    return { kind: 'produce-batch', topic: value.topic, messages: value.messages };
  }
  if (name === 'TOMBSTONE') {
    onlyKeys(value, ['topic', 'key', 'partition', 'headers'], name); assertKafkaTopic(value.topic);
    if (value.key === undefined || kafkaBytes(value.key, '墓碑 Key').length < 1) throw new Error('墓碑必须提供非空 Key。');
    const { topic: _topic, ...message } = value;
    messagePayload({ ...message, value: '' }, '墓碑');
    return { kind: 'tombstone', ...value };
  }
  if (name === 'CREATE_TOPIC') {
    onlyKeys(value, ['topic', 'partitions', 'replicationFactor', 'cleanupPolicy'], name); assertKafkaTopic(value.topic);
    if (!value.topic.startsWith('dsh-test-')) throw new Error('仅允许创建 dsh-test- 前缀的 Topic。');
    if (!Number.isInteger(value.partitions) || value.partitions < 1 || value.partitions > 32) throw new Error('分区数必须在 1 到 32 之间。');
    if (!Number.isInteger(value.replicationFactor) || value.replicationFactor < 1 || value.replicationFactor > 3) throw new Error('复制因子必须在 1 到 3 之间。');
    if (!['delete', 'compact'].includes(value.cleanupPolicy)) throw new Error('清理策略只能是 delete 或 compact。');
    return { kind: 'create-topic', ...value };
  }
  if (name === 'SET_GROUP_OFFSETS') {
    onlyKeys(value, ['groupId', 'topic', 'expected', 'offsets', 'timestamp', 'partitions'], name);
    assertKafkaGroupId(value.groupId); assertKafkaTopic(value.topic);
    if (value.groupId.startsWith('dsh-peek-')) throw new Error('不能调整插件临时消费组。');
    offsetsMap(value.expected, '预期旧位置', { nullable: true });
    if ((value.offsets === undefined) === (value.timestamp === undefined)) throw new Error('必须且只能指定 offset 或时间。');
    if (value.offsets !== undefined) {
      offsetsMap(value.offsets, '目标位置');
      if (Object.keys(value.expected).sort().join() !== Object.keys(value.offsets).sort().join()) throw new Error('目标分区与预期旧位置分区必须一致。');
    } else {
      timestamp(value.timestamp); partitionList(value.partitions);
      if (Object.keys(value.expected).sort().join() !== value.partitions.map(String).sort().join()) throw new Error('时间目标分区与预期旧位置分区必须一致。');
    }
    return { kind: 'set-group-offsets', ...value };
  }
  if (name === 'TIME_OFFSETS') {
    onlyKeys(value, ['topic', 'timestamp'], name); assertKafkaTopic(value.topic); timestamp(value.timestamp);
    return { kind: 'time-offsets', ...value };
  }
  if (name === 'SCAN') {
    onlyKeys(value, ['topic', 'partitions', 'offsets', 'timestamp', 'key', 'header'], name);
    assertKafkaTopic(value.topic); partitionList(value.partitions);
    if ((value.offsets === undefined) === (value.timestamp === undefined)) throw new Error('扫描必须且只能指定起始 offset 或时间。');
    if (value.offsets !== undefined) {
      offsetsMap(value.offsets, '扫描位置');
      if (Object.keys(value.offsets).sort().join() !== value.partitions.map(String).sort().join()) throw new Error('扫描位置与分区列表必须一致。');
    } else timestamp(value.timestamp);
    if (value.key !== undefined) kafkaBytes(value.key, '搜索 Key');
    if (value.header !== undefined) {
      if (!value.header || typeof value.header !== 'object' || Array.isArray(value.header)) throw new Error('Header 搜索条件无效。');
      onlyKeys(value.header, ['name', 'value'], 'Header 搜索条件');
      if (typeof value.header.name !== 'string' || !value.header.name || value.header.name.length > 128) throw new Error('Header 名称无效。');
      kafkaBytes(value.header.value, '搜索 Header');
    }
    return { kind: 'scan', ...value };
  }
  throw new Error('未知 Kafka JSON 命令。');
}

export function parseKafkaCommand(text) {
  if (typeof text !== 'string' || text.length > (/^\s*(?:PRODUCE|PRODUCE_BATCH|TOMBSTONE)\s+/i.test(text) ? MAX_WRITE_TEXT_LENGTH : MAX_TEXT_LENGTH)) throw new Error('命令长度超出限制');
  const input = text.trim();
  const produce = PRODUCE.exec(input);
  if (produce) return producePayload(produce[1]);
  const json = JSON_COMMAND.exec(input);
  if (json) return jsonOperation(json[1].toUpperCase(), json[2]);
  const config = TOPIC_CONFIG.exec(input);
  if (config) return { kind: 'topic-config', topic: parseTopic(config[1]) };
  const list = LIST.exec(input);
  if (list) return { kind: list[1].toLowerCase(), ...(list[2] !== undefined ? { search: searchText(list[2]) } : {}), ...(list[3] !== undefined ? { cursor: pageCursor(list[3]) } : {}) };
  const groupTopics = GROUP_TOPICS.exec(input);
  if (groupTopics) return { kind: 'group-topics', groupId: parseGroupId(groupTopics[1]), ...(groupTopics[2] !== undefined ? { cursor: pageCursor(groupTopics[2]) } : {}) };
  const describe = DESCRIBE.exec(input);
  if (describe) return { kind: 'describe', topic: parseTopic(describe[1]) };
  const group = GROUP.exec(input);
  if (group) {
    const groupId = parseGroupId(group[1]);
    return group[2] ? { kind: 'group-topic', groupId, topic: parseTopic(group[2]) } : { kind: 'group', groupId };
  }
  const peek = PEEK.exec(input);
  if (!peek) throw new Error('不支持此 Kafka 命令。');
  const partition = decimal(peek[2], 'Partition');
  if (partition > 2147483647n) throw new Error('Partition 超出范围');
  const limit = peek[4] === undefined ? 20 : Number(decimal(peek[4], 'LIMIT'));
  if (limit < 1 || limit > 200) throw new Error('LIMIT 必须在 1 到 200 之间');
  const fromText = peek[3].toUpperCase();
  const from = fromText.startsWith('OFFSET ') ? 'offset' : fromText.toLowerCase();
  const operation = { kind: 'peek', topic: parseTopic(peek[1]), partition: Number(partition), from, limit };
  if (from === 'offset') operation.offset = decimal(fromText.slice(7), 'OFFSET').toString();
  return operation;
}

export function formatKafkaCommand(operation) {
  if (!operation || typeof operation !== 'object') throw new Error('操作参数无效');
  let command;
  if (operation.kind === 'topics') command = 'TOPICS';
  else if (operation.kind === 'groups') command = 'GROUPS';
  else if (operation.kind === 'group-topics') {
    assertKafkaGroupId(operation.groupId);
    command = `GROUP ${JSON.stringify(operation.groupId)} TOPICS`;
  }
  else if (operation.kind === 'produce') {
    const payload = producePayload(JSON.stringify({ topic: operation.topic, ...(operation.key !== undefined ? { key: operation.key } : {}),
      value: operation.value, ...(operation.partition !== undefined ? { partition: operation.partition } : {}),
      ...(operation.headers !== undefined ? { headers: operation.headers } : {}), ...(operation.replayFrom !== undefined ? { replayFrom: operation.replayFrom } : {}) }));
    command = `PRODUCE ${JSON.stringify({ topic: payload.topic, ...(payload.key !== undefined ? { key: payload.key } : {}),
      value: payload.value, ...(payload.partition !== undefined ? { partition: payload.partition } : {}),
      ...(payload.headers !== undefined ? { headers: payload.headers } : {}), ...(payload.replayFrom !== undefined ? { replayFrom: payload.replayFrom } : {}) })}`;
  }
  else if (operation.kind === 'topic-config') { assertKafkaTopic(operation.topic); command = `TOPIC_CONFIG ${JSON.stringify(operation.topic)}`; }
  else if (['produce-batch', 'tombstone', 'create-topic', 'set-group-offsets', 'time-offsets', 'scan'].includes(operation.kind)) {
    const label = { 'produce-batch': 'PRODUCE_BATCH', tombstone: 'TOMBSTONE', 'create-topic': 'CREATE_TOPIC',
      'set-group-offsets': 'SET_GROUP_OFFSETS', 'time-offsets': 'TIME_OFFSETS', scan: 'SCAN' }[operation.kind];
    const { kind: _kind, ...args } = operation;
    command = `${label} ${JSON.stringify(args)}`;
  }
  else if (operation.kind === 'group') {
    assertKafkaGroupId(operation.groupId);
    command = `GROUP ${JSON.stringify(operation.groupId)}`;
  } else if (operation.kind === 'group-topic') {
    assertKafkaGroupId(operation.groupId);
    assertKafkaTopic(operation.topic);
    command = `GROUP ${JSON.stringify(operation.groupId)} TOPIC ${JSON.stringify(operation.topic)}`;
  } else if (operation.kind === 'describe') {
    assertKafkaTopic(operation.topic);
    command = `DESCRIBE ${JSON.stringify(operation.topic)}`;
  } else if (operation.kind === 'peek') {
    assertKafkaTopic(operation.topic);
    const from = operation.from === 'offset' ? `OFFSET ${operation.offset}` : String(operation.from).toUpperCase();
    command = `PEEK ${JSON.stringify(operation.topic)} PARTITION ${operation.partition} FROM ${from} LIMIT ${operation.limit ?? 20}`;
  } else throw new Error('未知 Kafka 操作');
  if (operation.kind === 'topics' || operation.kind === 'groups') {
    if (operation.search !== undefined) command += ` SEARCH ${JSON.stringify(operation.search)}`;
  }
  if (['topics', 'groups', 'group-topics'].includes(operation.kind) && operation.cursor !== undefined) command += ` CURSOR ${pageCursor(operation.cursor)}`;
  parseKafkaCommand(command);
  return command;
}

export function kafkaPeekStart(operation, low, high) {
  if (operation.kind !== 'peek') throw new Error('PEEK 操作必需');
  const first = decimal(String(low), 'low');
  const last = decimal(String(high), 'high');
  if (last < first) throw new Error('Kafka 水位无效');
  if (operation.from === 'beginning') return first.toString();
  if (operation.from === 'latest') return (last - BigInt(operation.limit) > first ? last - BigInt(operation.limit) : first).toString();
  const requested = decimal(operation.offset, 'OFFSET');
  return (requested < first ? first : requested > last ? last : requested).toString();
}

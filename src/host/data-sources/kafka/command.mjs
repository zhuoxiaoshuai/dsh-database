const MAX_TEXT_LENGTH = 4096;
const MAX_OFFSET = (1n << 63n) - 1n;
const QUOTED = String.raw`"(?:\\.|[^"\\])*"`;
const DESCRIBE = new RegExp(`^DESCRIBE\\s+(${QUOTED})$`, 'i');
const GROUP = new RegExp(`^GROUP\\s+(${QUOTED})(?:\\s+TOPIC\\s+(${QUOTED}))?$`, 'i');
const PEEK = new RegExp(`^PEEK\\s+(${QUOTED})\\s+PARTITION\\s+(\\d+)\\s+FROM\\s+(BEGINNING|LATEST|OFFSET\\s+\\d+)(?:\\s+LIMIT\\s+(\\d+))?$`, 'i');

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

export function parseKafkaCommand(text) {
  if (typeof text !== 'string' || text.length > MAX_TEXT_LENGTH) throw new Error('命令长度超出限制');
  const input = text.trim();
  if (/^TOPICS$/i.test(input)) return { kind: 'topics' };
  if (/^GROUPS$/i.test(input)) return { kind: 'groups' };
  const describe = DESCRIBE.exec(input);
  if (describe) return { kind: 'describe', topic: parseTopic(describe[1]) };
  const group = GROUP.exec(input);
  if (group) {
    const groupId = parseGroupId(group[1]);
    return group[2] ? { kind: 'group-topic', groupId, topic: parseTopic(group[2]) } : { kind: 'group', groupId };
  }
  const peek = PEEK.exec(input);
  if (!peek) throw new Error('只支持 TOPICS、DESCRIBE、PEEK、GROUPS 和 GROUP 只读命令');
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

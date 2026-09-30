import { test } from 'node:test';
import assert from 'node:assert/strict';
import { formatKafkaCommand, kafkaPeekStart, parseKafkaCommand } from '../src/host/data-sources/kafka/command.mjs';

test('Kafka 只解析只读命令', () => {
  assert.deepEqual(parseKafkaCommand(' topics '), { kind: 'topics' });
  assert.deepEqual(parseKafkaCommand('GROUPS'), { kind: 'groups' });
  assert.deepEqual(parseKafkaCommand('DESCRIBE "Orders"'), { kind: 'describe', topic: 'Orders' });
  assert.deepEqual(parseKafkaCommand('GROUP "billing"'), { kind: 'group', groupId: 'billing' });
  assert.deepEqual(parseKafkaCommand('GROUP "billing" TOPIC "Orders"'), { kind: 'group-topic', groupId: 'billing', topic: 'Orders' });
  assert.deepEqual(parseKafkaCommand('peek "Orders" partition 0 from beginning'), { kind: 'peek', topic: 'Orders', partition: 0, from: 'beginning', limit: 20 });
  for (const invalid of ['TOPICS; TOPICS', 'DELETE "Orders"', 'GROUP "billing" RESET', 'PEEK "Orders" PARTITION -1 FROM BEGINNING', 'PEEK "Orders" PARTITION 0 FROM BEGINNING LIMIT 201', 'PEEK "Orders" PARTITION 0 FROM BEGINNING LIMIT 0', 'PEEK "Orders" PARTITION 0 FROM BEGINNING LIMIT 2 LIMIT 3']) {
    assert.throws(() => parseKafkaCommand(invalid), invalid);
  }
});

test('Kafka offset 不经过有损 Number，Topic 可安全往返', () => {
  const operation = parseKafkaCommand('PEEK "a\\\"b" PARTITION 4 FROM OFFSET 9007199254740993 LIMIT 2');
  assert.equal(operation.offset, '9007199254740993');
  assert.deepEqual(parseKafkaCommand(formatKafkaCommand(operation)), operation);
  assert.deepEqual(parseKafkaCommand(formatKafkaCommand({ kind: 'group', groupId: 'a"b' })), { kind: 'group', groupId: 'a"b' });
  assert.deepEqual(parseKafkaCommand(formatKafkaCommand({ kind: 'group-topic', groupId: 'g', topic: 'a/b' })), { kind: 'group-topic', groupId: 'g', topic: 'a/b' });
  assert.equal(kafkaPeekStart(operation, '9007199254740990', '9007199254740995'), '9007199254740993');
  assert.equal(kafkaPeekStart({ ...operation, from: 'latest' }, '5', '10'), '8');
  assert.throws(() => parseKafkaCommand('DESCRIBE "bad\\nname"'));
});

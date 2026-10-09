import { test } from 'node:test';
import assert from 'node:assert/strict';
import { formatKafkaCommand, kafkaPeekStart, parseKafkaCommand } from '../src/host/data-sources/kafka/command.mjs';

test('Kafka 解析受限读取与单条发布命令', () => {
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

test('Kafka PRODUCE keeps text compatibility and enforces decoded 64 KiB', () => {
  const operation = { kind: 'produce', topic: 'orders', key: 'case-1', value: 'hello', partition: 0, headers: { trace: 'x' } };
  assert.deepEqual(parseKafkaCommand(formatKafkaCommand(operation)), operation);
  for (const invalid of [
    'PRODUCE {"topic":"orders","value":null}',
    'PRODUCE {"topic":"orders","value":"x","extra":true}',
    'PRODUCE {"topic":"orders","value":"x","partition":-1}',
    'PRODUCE {"topic":"orders","value":"x","headers":{"trace":3}}',
    'PRODUCE {"topic":"orders","value":"' + 'x'.repeat(65537) + '"}',
  ]) assert.throws(() => parseKafkaCommand(invalid), invalid.slice(0, 80));
});

test('Kafka binary and management commands reject malformed or unsafe targets', () => {
  for (const operation of [
    { kind: 'produce', topic: 'orders', value: { base64: '/wA=' }, headers: { trace: [{ base64: 'AA==' }, 'x'] } },
    { kind: 'produce-batch', topic: 'orders', messages: [{ value: 'a' }, { value: { base64: '/wA=' } }] },
    { kind: 'tombstone', topic: 'orders', key: { base64: 'AA==' } },
    { kind: 'create-topic', topic: 'dsh-test-orders', partitions: 1, replicationFactor: 1, cleanupPolicy: 'compact' },
    { kind: 'set-group-offsets', groupId: 'billing', topic: 'orders', expected: { 0: null }, offsets: { 0: '9007199254740993' } },
    { kind: 'time-offsets', topic: 'orders', timestamp: 1760000000000 },
    { kind: 'scan', topic: 'orders', partitions: [0, 1], offsets: { 0: '0', 1: '1' }, key: { base64: 'AA==' } },
  ]) assert.deepEqual(parseKafkaCommand(formatKafkaCommand(operation)), operation);
  for (const invalid of [
    'PRODUCE {"topic":"orders","value":{"base64":"/w"}}',
    'PRODUCE_BATCH {"topic":"orders","messages":[]}',
    'TOMBSTONE {"topic":"orders","key":""}',
    'CREATE_TOPIC {"topic":"orders","partitions":1,"replicationFactor":1,"cleanupPolicy":"delete"}',
    'SET_GROUP_OFFSETS {"groupId":"g","topic":"orders","expected":{"0":"1"},"offsets":{"1":"2"}}',
    'SCAN {"topic":"orders","partitions":[0,0],"timestamp":1}',
  ]) assert.throws(() => parseKafkaCommand(invalid), invalid);
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

test('Kafka lists and group topic lists support ordered search/cursor with canonical round trips', () => {
  for (const operation of [
    { kind: 'topics', search: 'Order "events"', cursor: '100' },
    { kind: 'groups', search: 'billing' },
    { kind: 'group-topics', groupId: 'billing', cursor: '200' },
  ]) assert.deepEqual(parseKafkaCommand(formatKafkaCommand(operation)), operation);
  assert.deepEqual(parseKafkaCommand('TOPICS CURSOR 0'), { kind: 'topics', cursor: '0' });
  for (const text of ['TOPICS CURSOR 1 SEARCH "a"', 'TOPICS SEARCH "a" SEARCH "b"', 'GROUPS CURSOR 01', 'GROUPS CURSOR -1', 'GROUPS CURSOR 1000001', 'GROUP "g" TOPICS SEARCH "x"', 'TOPICS SEARCH "bad\\nname"']) assert.throws(() => parseKafkaCommand(text));
});

import test from 'node:test'
import assert from 'node:assert/strict'
import { createDmlPlan } from '../src/host/dml-plan.mjs'
import { resolvePrimaryKeys } from '../src/shared/primary-keys.ts'
import { resolvePrimaryKeys as resolveHostPrimaryKeys } from '../src/host/primary-keys.mjs'

const metadata = { columns: [{ name: 'id', type: 'bigint', key: 'PRI' }, { name: 'note', type: 'varchar(100)' }] }
test('host and typed shared entry points use one primary-key runtime', () => {
  assert.equal(resolvePrimaryKeys, resolveHostPrimaryKeys)
})
test('DML uses parameters and compares primary key plus changed fields', () => {
  const plan = createDmlPlan('mysql', 'business', 'records', { kind: 'update', original: { id: '9007199254740993', note: null }, values: { note: "' ; DROP TABLE x --" } }, metadata)
  assert.ok(plan.sql.includes('`note` IS NULL'))
  assert.ok(plan.sql.includes('`id`'))
  assert.ok(!plan.sql.includes('DROP'))
  assert.deepEqual(plan.params, ["' ; DROP TABLE x --", '9007199254740993'])
  assert.equal(plan.expectedRows, 1)
})
test('update with only the primary key locates the row and does not require old values', () => {
  const plan = createDmlPlan('mysql', 'business', 'records', { kind: 'update', original: { id: '1' }, values: { note: 'x' } }, metadata)
  assert.match(plan.sql, /WHERE `id`/)
  assert.doesNotMatch(plan.sql, /`note`\s*<=>/)
  assert.match(plan.sql, /SET `note`=\?/)
  assert.deepEqual(plan.params, ['x', '1'])
})
test('missing primary key, primary-key edits and forged columns cannot generate DML', () => {
  for (const operation of [{ kind: 'update', original: { id: '1', note: 'x' }, values: { id: '2' } }, { kind: 'insert', values: { unknown: 'x' } }]) assert.throws(() => createDmlPlan('mysql', 'business', 'records', operation, metadata))
  assert.throws(() => createDmlPlan('oracle', 'business', 'records', { kind: 'delete', original: { id: '1', note: 'x' } }, { columns: metadata.columns.map(c => ({ ...c, key: '' })) }))
  const fromIndex = createDmlPlan('mysql', 'business', 'records', { kind: 'delete', original: { id: '1', note: 'x' }, values: {} }, {
    columns: [{ name: 'id', type: 'bigint', columnKey: '' }, { name: 'note', type: 'varchar(100)' }],
    indexes: { values: [{ INDEX_NAME: 'PRIMARY', COLUMN_NAME: 'id', SEQ_IN_INDEX: 1 }] },
  })
  assert.ok(fromIndex.sql.includes('DELETE'))
})
test('PRIMARY KEY constraints recover keys when COLUMN_KEY is missing', () => {
  assert.deepEqual(resolvePrimaryKeys('mysql', {
    columns: [{ name: 'aircraft_code', type: 'char(3)' }, { name: 'model', type: 'json' }],
    constraints: { values: [{ CONSTRAINT_TYPE: 'PRIMARY KEY', COLUMN_NAME: 'aircraft_code', ORDINAL_POSITION: 1 }] },
  }), ['aircraft_code'])
})
test('tables with json columns can update a scalar field', () => {
  const columns = [
    { name: 'aircraft_code', type: 'char(3)', key: 'PRI' },
    { name: 'model', type: 'json' },
    { name: 'range', type: 'int' },
  ]
  const plan = createDmlPlan('mysql', 'XIE_CHENG', 'aircrafts_data', {
    kind: 'update',
    original: { aircraft_code: '763', model: '{"en":"Boeing"}', range: '7900' },
    values: { range: '8000' },
  }, { columns })
  assert.match(plan.sql, /UPDATE/)
  assert.equal(plan.params[0], '8000')
  const json = createDmlPlan('mysql', 'XIE_CHENG', 'aircrafts_data', {
    kind: 'update',
    original: { aircraft_code: '763', model: '{"en":"Boeing"}', range: '7900' },
    values: { model: '{}' },
  }, { columns })
  assert.match(json.sql, /`model`=\?/)
  assert.doesNotMatch(json.sql, /`model`\s*<=>/)
  assert.deepEqual(json.params, ['{}', '763'])
  const pkOnly = createDmlPlan('mysql', 'XIE_CHENG', 'aircrafts_data', {
    kind: 'update',
    original: { aircraft_code: '763' },
    values: { model: '{}' },
  }, { columns })
  assert.match(pkOnly.sql, /`model`=\?/)
  assert.match(pkOnly.sql, /WHERE BINARY `aircraft_code`/)
  assert.doesNotMatch(pkOnly.sql, /`model`\s*<=>/)
  assert.deepEqual(pkOnly.params, ['{}', '763'])
})
test('Oracle DML binds DATE/TIMESTAMP with conversion functions and still rejects keyless tables', () => {
  const columns = [
    { name: 'ID', type: 'NUMBER' },
    { name: 'CREATED_AT', type: 'DATE', scale: 0 },
    { name: 'TS', type: 'TIMESTAMP(3)', scale: 3 },
    { name: 'TZ', type: 'TIMESTAMP(6) WITH TIME ZONE', scale: 6 },
  ]
  const metadata = { columns, constraints: { values: [{ constraint_type: 'P', column_name: 'ID', position: 1 }] } }
  const update = createDmlPlan('oracle', 'HR', 'EVENTS', {
    kind: 'update',
    original: { ID: '1', CREATED_AT: '2024-01-02 03:04:05', TS: '2024-01-02 03:04:05.12', TZ: '2024-01-02 03:04:05.123456 +08:00' },
    values: { TS: '2024-01-02 03:04:05.999', TZ: '2024-01-02 03:04:05.123456 +00:00' },
  }, metadata)
  assert.match(update.sql, /TO_TIMESTAMP\(:1, 'YYYY-MM-DD HH24:MI:SS\.FF3'\)/)
  assert.match(update.sql, /TO_TIMESTAMP_TZ\(:2, 'YYYY-MM-DD HH24:MI:SS\.FF6 TZH:TZM'\)/)
  assert.match(update.sql, /"ID"=:3/)
  assert.match(update.sql, /TO_TIMESTAMP\(:4, 'YYYY-MM-DD HH24:MI:SS\.FF3'\)/)
  assert.match(update.sql, /TO_TIMESTAMP_TZ\(:5/)
  assert.deepEqual(update.params, [
    '2024-01-02 03:04:05.999',
    '2024-01-02 03:04:05.123456 +00:00',
    '1',
    '2024-01-02 03:04:05.120',
    '2024-01-02 03:04:05.123456 +08:00',
  ])
  const insert = createDmlPlan('oracle', 'HR', 'EVENTS', {
    kind: 'insert',
    values: { ID: '2', CREATED_AT: '2024-01-02 03:04:05' },
  }, metadata)
  assert.match(insert.sql, /TO_DATE\(:2, 'YYYY-MM-DD HH24:MI:SS'\)/)
  assert.throws(() => createDmlPlan('oracle', 'HR', 'EVENTS', {
    kind: 'update',
    original: { ID: '1', CREATED_AT: '2024-01-02 03:04:05', TS: 'bad', TZ: '2024-01-02 03:04:05.123456 +08:00' },
    values: { TS: '2024-01-02 03:04:05.100' },
  }, metadata), /时间值无效/)
  assert.throws(() => createDmlPlan('oracle', 'HR', 'EVENTS', {
    kind: 'delete',
    original: { CREATED_AT: '2024-01-02 03:04:05' },
  }, { columns }))
})

test('Oracle optimistic WHERE uses the original temporal snapshot, not the new value', () => {
  const metadata = {
    columns: [
      { name: 'ID', type: 'NUMBER' },
      { name: 'TS', type: 'TIMESTAMP(6)', scale: 6 },
    ],
    constraints: { values: [{ constraint_type: 'P', column_name: 'ID', position: 1 }] },
  }
  const first = createDmlPlan('oracle', 'HR', 'EVENTS', {
    kind: 'update',
    original: { ID: '1', TS: '2024-01-02 03:04:05.000001' },
    values: { TS: '2024-01-02 03:04:05.000002' },
  }, metadata)
  const stale = createDmlPlan('oracle', 'HR', 'EVENTS', {
    kind: 'update',
    original: { ID: '1', TS: '2024-01-02 03:04:05.000009' },
    values: { TS: '2024-01-02 03:04:05.000002' },
  }, metadata)
  assert.equal(first.params[0], '2024-01-02 03:04:05.000002')
  assert.equal(first.params[2], '2024-01-02 03:04:05.000001')
  assert.equal(stale.params[2], '2024-01-02 03:04:05.000009')
  assert.notEqual(first.params[2], stale.params[2])
})

test('MySQL update/delete without primary keys are rejected, insert still generates parameterized SQL', () => {
  const columns = [{ name: 'aircraft_code', type: 'char(3)' }, { name: 'model', type: 'varchar(200)' }, { name: 'range', type: 'int' }]
  assert.throws(() => createDmlPlan('mysql', 'XIE_CHENG', 'aircrafts_data', {
    kind: 'update',
    original: { aircraft_code: '321', model: 'Airbus A321-200', range: '5600' },
    values: { range: '5700' },
  }, { columns }), /缺少可靠主键/)
  assert.throws(() => createDmlPlan('mysql', 'XIE_CHENG', 'aircrafts_data', {
    kind: 'delete',
    original: { aircraft_code: '321', model: 'Airbus A321-200', range: '5600' },
  }, { columns }), /缺少可靠主键/)
  const insert = createDmlPlan('mysql', 'XIE_CHENG', 'aircrafts_data', {
    kind: 'insert',
    values: { aircraft_code: '321', model: 'Airbus A321-200' },
  }, { columns })
  assert.match(insert.sql, /INSERT INTO `XIE_CHENG`\.`aircrafts_data`/)
  assert.deepEqual(insert.params, ['321', 'Airbus A321-200'])
})

test('wide tables stay editable until the catalog marks the structure truncated', () => {
  const columns = [
    { name: 'id', type: 'bigint', key: 'PRI' },
    ...Array.from({ length: 120 }, (_, index) => ({ name: `c${index}`, type: 'varchar(20)' })),
  ]
  const plan = createDmlPlan('mysql', 'business', 'wide', {
    kind: 'update',
    original: { id: '1' },
    values: { c0: 'next' },
  }, { columns, truncated: false })
  assert.match(plan.sql, /SET `c0`=\?/)
  assert.match(plan.sql, /WHERE `id`/)
  assert.throws(() => createDmlPlan('mysql', 'business', 'wide', {
    kind: 'update',
    original: { id: '1' },
    values: { c0: 'next' },
  }, { columns, truncated: true }), /结构已截断/)
  assert.throws(() => createDmlPlan('mysql', 'business', 'wide', {
    kind: 'update',
    original: { id: '1' },
    values: { c0: 'next' },
  }, { columns: [] }), /缺少表结构/)
})

test('partial SELECT snapshots may delete by complete primary key', () => {
  const plan = createDmlPlan('mysql', 'business', 'records', {
    kind: 'delete',
    values: {},
    original: { id: '9', note: 'visible-old-value' },
  }, {
    columns: [
      { name: 'id', type: 'bigint', key: 'PRI' },
      { name: 'note', type: 'varchar(100)' },
      { name: 'not_selected', type: 'varchar(100)' },
    ],
  })
  assert.match(plan.sql, /DELETE/)
  assert.match(plan.sql, /`id`\s*<=>/)
  assert.match(plan.sql, /`note`\s*<=>/)
  assert.doesNotMatch(plan.sql, /not_selected/)
  assert.deepEqual(plan.params, ['9', 'visible-old-value'])
})

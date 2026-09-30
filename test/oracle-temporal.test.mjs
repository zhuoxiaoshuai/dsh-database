import test from 'node:test'
import assert from 'node:assert/strict'
import {
  ORACLE_TEMPORAL_SESSION_SQL,
  canonicalizeOracleTemporal,
  classifyOracleTemporal,
  normalizeOracleFetchedString,
  oracleTemporalExpression,
} from '../src/host/oracle-temporal.mjs'
import { createDmlPlan } from '../src/host/dml-plan.mjs'
import { buildBrowse } from '../src/host/browse.mjs'

const dateCol = { name: 'D', type: 'DATE', scale: 0 }
const ts0 = { name: 'T0', type: 'TIMESTAMP(0)', scale: 0 }
const ts3 = { name: 'T3', type: 'TIMESTAMP(3)', scale: 3 }
const ts6 = { name: 'T6', type: 'TIMESTAMP(6)', scale: 6 }
const tstz = { name: 'TZ', type: 'TIMESTAMP(6) WITH TIME ZONE', scale: 6 }
const tsltz = { name: 'LTZ', type: 'TIMESTAMP(3) WITH LOCAL TIME ZONE', scale: 3 }

test('Oracle session SQL pins UTC and NLS formats', () => {
  assert.ok(ORACLE_TEMPORAL_SESSION_SQL.some(sql => /TIME_ZONE = 'UTC'/.test(sql)))
  assert.ok(ORACLE_TEMPORAL_SESSION_SQL.some(sql => /NLS_DATE_FORMAT/.test(sql)))
  assert.ok(ORACLE_TEMPORAL_SESSION_SQL.some(sql => /NLS_TIMESTAMP_FORMAT/.test(sql)))
  assert.ok(ORACLE_TEMPORAL_SESSION_SQL.some(sql => /NLS_TIMESTAMP_TZ_FORMAT/.test(sql)))
})

test('canonical DATE keeps second precision and rejects extra fraction or offset', () => {
  assert.equal(canonicalizeOracleTemporal(dateCol, '2024-01-02 03:04:05'), '2024-01-02 03:04:05')
  assert.equal(canonicalizeOracleTemporal(dateCol, '2024-01-02T03:04:05.000'), '2024-01-02 03:04:05')
  assert.throws(() => canonicalizeOracleTemporal(dateCol, '2024-01-02 03:04:05.1'), /精度/)
  assert.throws(() => canonicalizeOracleTemporal(dateCol, '2024-01-02 03:04:05 +08:00'), /DATE/)
  assert.throws(() => canonicalizeOracleTemporal(dateCol, '2024-02-30 00:00:00'), /无效/)
})

test('canonical TIMESTAMP keeps column scale 0/3/6', () => {
  assert.equal(classifyOracleTemporal(ts0).kind, 'timestamp')
  assert.equal(canonicalizeOracleTemporal(ts0, '2024-01-02 03:04:05'), '2024-01-02 03:04:05')
  assert.equal(canonicalizeOracleTemporal(ts3, '2024-01-02 03:04:05.12'), '2024-01-02 03:04:05.120')
  assert.equal(canonicalizeOracleTemporal(ts3, '2024-01-02 03:04:05.123000000'), '2024-01-02 03:04:05.123')
  assert.equal(canonicalizeOracleTemporal(ts6, '2024-01-02 03:04:05.123456'), '2024-01-02 03:04:05.123456')
  assert.throws(() => canonicalizeOracleTemporal(ts3, '2024-01-02 03:04:05.1234'), /精度/)
})

test('canonical TSTZ keeps offset; TSLTZ only accepts UTC', () => {
  assert.equal(canonicalizeOracleTemporal(tstz, '2024-01-02 03:04:05.123456+08:00'), '2024-01-02 03:04:05.123456 +08:00')
  assert.equal(canonicalizeOracleTemporal(tstz, '2024-01-02 03:04:05.123456 Z'), '2024-01-02 03:04:05.123456 +00:00')
  assert.throws(() => canonicalizeOracleTemporal(tstz, '2024-01-02 03:04:05.123456'), /偏移/)
  assert.equal(canonicalizeOracleTemporal(tsltz, '2024-01-02 03:04:05.12'), '2024-01-02 03:04:05.120')
  assert.equal(canonicalizeOracleTemporal(tsltz, '2024-01-02 03:04:05.120 +00:00'), '2024-01-02 03:04:05.120')
  assert.throws(() => canonicalizeOracleTemporal(tsltz, '2024-01-02 03:04:05.120 +08:00'), /UTC/)
})

test('DML expressions use explicit TO_DATE / TO_TIMESTAMP / TO_TIMESTAMP_TZ', () => {
  assert.equal(oracleTemporalExpression({ kind: 'date', scale: 0 }, ':1'), "TO_DATE(:1, 'YYYY-MM-DD HH24:MI:SS')")
  assert.match(oracleTemporalExpression({ kind: 'timestamp', scale: 3 }, ':2'), /TO_TIMESTAMP\(:2, 'YYYY-MM-DD HH24:MI:SS\.FF3'\)/)
  assert.match(oracleTemporalExpression({ kind: 'tstz', scale: 6 }, ':3'), /TO_TIMESTAMP_TZ\(:3, 'YYYY-MM-DD HH24:MI:SS\.FF6 TZH:TZM'\)/)
  assert.match(oracleTemporalExpression({ kind: 'tsltz', scale: 3 }, ':4'), /TIMESTAMP WITH LOCAL TIME ZONE/)
})

test('fetched NLS strings normalize without depending on trailing FF9 zeros', () => {
  assert.equal(normalizeOracleFetchedString('2024-01-02 03:04:05.123000000'), '2024-01-02 03:04:05.123')
  assert.equal(normalizeOracleFetchedString('2024-01-02 03:04:05.123000000 +08:00'), '2024-01-02 03:04:05.123 +08:00')
  assert.equal(normalizeOracleFetchedString('not a date'), 'not a date')
})

test('browse binds Oracle temporal filters with conversion functions', () => {
  const metadata = { columns: [{ name: 'ID', type: 'NUMBER' }, ts3] }
  const plan = buildBrowse('oracle', { schema: 'HR', table: 'EVENTS', page: 0, filters: [{ column: 'T3', operator: 'eq', value: '2024-01-02 03:04:05.12' }] }, metadata)
  assert.ok(plan.sql.includes('TO_TIMESTAMP(:1'))
  assert.deepEqual(plan.params, ['2024-01-02 03:04:05.120'])
  assert.throws(() => buildBrowse('oracle', { schema: 'HR', table: 'EVENTS', page: 0, filters: [{ column: 'T3', operator: 'eq', value: 'nope' }] }, metadata), /时间值无效/)
})

test('time primary keys and changed temporal columns use canonical binds', () => {
  const metadata = {
    columns: [ts6, { name: 'NOTE', type: 'VARCHAR2(40)' }],
    constraints: { values: [{ constraint_type: 'P', column_name: 'T6', position: 1 }] },
  }
  const plan = createDmlPlan('oracle', 'HR', 'EVENTS', {
    kind: 'update',
    original: { T6: '2024-01-02 03:04:05.123456', NOTE: 'old' },
    values: { NOTE: 'new' },
  }, metadata)
  assert.match(plan.sql, /TO_TIMESTAMP\(:2, 'YYYY-MM-DD HH24:MI:SS\.FF6'\)/)
  assert.equal(plan.params[1], '2024-01-02 03:04:05.123456')
})

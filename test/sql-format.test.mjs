import test from 'node:test'
import assert from 'node:assert/strict'
import { format } from 'sql-formatter'
import { EditorState, EditorSelection, Transaction } from '@codemirror/state'
import { history, undo, redo } from '@codemirror/commands'
import { parseSqlFormatRange, prepareSqlFormat } from '../src/shared/sql-format.ts'
import { captureSqlEditorFormat, sqlFormatEdit, sqlFormatTransaction } from '../src/client/sql/editor-format.ts'
import { hasUserTextChange } from '../src/client/workspace/parts/hooks/editor-host.ts'
import { validateBrowserFormat } from '../src/host/sql-browser-request.ts'
import { emptySharedQuery } from '../src/shared/workbench.ts'
import { SQL_FIELD_MAX_LENGTH } from '../src/shared/limits.ts'

for (const dialect of ['mysql', 'oracle']) {
  const language = dialect === 'mysql' ? 'mysql' : 'plsql'
  for (const [source, expected] of [
    ['A001 A002 A003', "'A001', 'A002', 'A003'"],
    ['(001 002)', "('001', '002')"],
    ['甲\n乙', "'甲', '乙'"],
    ['A001 A002, A003', "'A001', 'A002', 'A003'"],
    ['  A001\tA001\r\n0002  ', "  'A001', 'A001', '0002'  "],
    ['( \nA001 A002\t)', "('A001', 'A002')"],
    [',A001 A002,,', "'A001', 'A002'"],
    ['a b', "'a', 'b'"],
  ]) test(`${dialect}: raw selection ${JSON.stringify(source)}`, () => {
    const result = prepareSqlFormat(source, dialect, { from: 0, to: source.length })
    assert.equal(result.kind, 'values')
    assert.equal(result.text, expected)
    const repeated = prepareSqlFormat(result.text, dialect, { from: 0, to: result.text.length })
    assert.equal(repeated.kind, 'sql')
    assert.equal((repeated.text.match(/'/g) || []).length, (expected.match(/'/g) || []).length)
  })
  test(`${dialect}: existing SQL and complex values only receive SQL whitespace formatting`, () => {
    for (const source of ['1, 2', 'A001, A002', '1,\n2', "'New York', 'London'", "'a''b', 'c'", 'a + b', 'SELECT id FROM t',
      'SELECT foo', 'varchar thing', 'count other', 'NULL other', '2026-10-11 2026-10-12', 'uuid-one uuid-two', 'a@b.com c@d.com',
      '(A001, A002)', '((A001, A002))', 'one /* comment */ two', 'A001']) {
      const result = prepareSqlFormat(source, dialect, { from: 0, to: source.length })
      assert.equal(result.kind, 'sql', source)
      assert.equal(result.text, format(source, { language }), source)
    }
    assert.equal(prepareSqlFormat('A001 A002', dialect).kind, 'sql', 'whole document never auto-converts')
  })
  test(`${dialect}: real offsets and edge whitespace preserve everything outside the selection`, () => {
    const sql = 'SELECT * FROM t WHERE x IN ( A001 A002 );\nSELECT * FROM t WHERE x IN ( A001 A002 );'
    const from = sql.lastIndexOf(' A001'), to = from + ' A001 A002 '.length
    const result = prepareSqlFormat(sql, dialect, { from, to })
    assert.equal(result.insert, " 'A001', 'A002' ")
    assert.equal(result.text.slice(0, from), sql.slice(0, from))
    assert.equal(result.text.slice(from + result.insert.length), sql.slice(to))
    assert.ok(result.text.startsWith('SELECT * FROM t WHERE x IN ( A001 A002 );'))
    const blank = '\n \t'
    assert.equal(prepareSqlFormat(blank, dialect, { from: 0, to: blank.length }).text, blank)
    const commentSql = 'SELECT 1;\n-- unchanged\nselect x from t;'
    const start = commentSql.indexOf('--'), end = commentSql.indexOf('select')
    const comment = prepareSqlFormat(commentSql, dialect, { from: start, to: end })
    assert.ok(comment.insert.endsWith('\n'))
    assert.equal(comment.text.slice(start + comment.insert.length), commentSql.slice(end))
  })
  test(`${dialect}: partial SQL regions and tokens cannot be formatted`, () => {
    for (const sql of ["SELECT 'A001 A002'", 'SELECT /* A001 A002 */ 1', 'SELECT -- A001 A002\n1',
      dialect === 'mysql' ? 'SELECT `A001 A002`' : 'SELECT "A001 A002"']) {
      const from = sql.indexOf('A001')
      assert.throws(() => prepareSqlFormat(sql, dialect, { from, to: from + 9 }), /截断/)
    }
    assert.throws(() => prepareSqlFormat('SELECT abc', dialect, { from: 8, to: 10 }), /词元/)
    assert.throws(() => prepareSqlFormat('SELECT abc', dialect, { from: 0, to: 3 }), /词元/)
    assert.throws(() => prepareSqlFormat("SELECT 'unterminated", dialect), /无法格式化/)
  })
  test(`${dialect}: Host re-computes local replacement and its control effect`, () => {
    const sql = 'SELECT * FROM t WHERE code IN (A001 A002); SELECT 9;'
    const current = { ...emptySharedQuery(), sql, schema: 'app', revision: 9, controller: 'ai' }
    const range = { from: sql.indexOf('A001'), to: sql.indexOf('A002') + 4 }
    const result = prepareSqlFormat(sql, dialect, range)
    assert.equal(validateBrowserFormat(current, { sql: result.text }, dialect, 9, range), 'values')
    assert.throws(() => validateBrowserFormat(current, { sql: result.text }, dialect, 8, range), /变化/)
    assert.throws(() => validateBrowserFormat(current, { sql: result.text }, dialect, undefined, range), /修订/)
    assert.throws(() => validateBrowserFormat(current, { sql: result.text.replace('SELECT 9', 'DELETE FROM t') }, dialect, 9, range), /不一致/)
    assert.throws(() => validateBrowserFormat(current, { sql: result.text, schema: 'other' }, dialect, 9, range), /Schema/)
    assert.throws(() => validateBrowserFormat(current, { sql: result.text }, dialect, 9, { from: 0, to: sql.length + 1 }), /选区/)
    const plain = 'select x from t;'
    const doc = { ...current, sql: plain }
    const formatted = prepareSqlFormat(plain, dialect, { from: 0, to: plain.length })
    assert.equal(validateBrowserFormat(doc, { sql: formatted.text }, dialect, 9, { from: 0, to: plain.length }), 'sql')
  })
}

test('format ranges reject malformed values even for unchanged SQL', () => {
  const current = { ...emptySharedQuery(), sql: 'SELECT 1', revision: 1 }
  for (const range of [null, [], '0,1', { from: -1, to: 2 }, { from: 1, to: 1 }, { from: 2, to: 1 },
    { from: 0.5, to: 1 }, { from: '0', to: 1 }, { from: 0, to: 99 }, { from: 0, to: 1, extra: true }, { from: 0 }]) {
    assert.throws(() => parseSqlFormatRange(range, current.sql.length), /选区/)
    assert.throws(() => validateBrowserFormat(current, { sql: current.sql }, 'mysql', 1, range), /选区/)
  }
})

test('format output refuses length expansion beyond the document limit', () => {
  const raw = 'A001 '.repeat(Math.floor(SQL_FIELD_MAX_LENGTH / 5))
  assert.throws(() => prepareSqlFormat(raw, 'mysql', { from: 0, to: raw.length }), /上限/)
})

for (const reversed of [false, true]) test(`format is one isolated undo/redo step with ${reversed ? 'reverse' : 'forward'} selection`, () => {
  const original = 'SELECT * FROM t WHERE code IN (A001 A002);'
  const from = original.indexOf('A001'), to = from + 9
  let state = EditorState.create({ doc: original, selection: EditorSelection.single(reversed ? to : from, reversed ? from : to), extensions: history() })
  // An earlier user edit must not merge with the formatting transaction.
  state = state.update({ changes: { from: state.doc.length, insert: '\n' } }).state
  const before = state.doc.toString()
  const result = prepareSqlFormat(before, 'mysql', { from, to })
  const transaction = state.update(sqlFormatTransaction(state, result))
  assert.equal(transaction.annotation(sqlFormatEdit), true)
  state = transaction.state
  assert.equal(state.selection.main.anchor, reversed ? from + result.insert.length : from)
  assert.equal(state.selection.main.head, reversed ? from : from + result.insert.length)
  const target = { get state() { return state }, dispatch(transaction) {
    assert.equal(transaction.annotation(sqlFormatEdit), undefined, 'undo/redo must be ordinary user edits')
    assert.equal(hasUserTextChange({ transactions: [transaction] }), true)
    state = transaction.state
  } }
  assert.equal(undo(target), true)
  assert.equal(state.doc.toString(), before)
  assert.equal(redo(target), true)
  assert.equal(state.doc.toString(), result.text)
  assert.equal(undo(target), true)
  assert.equal(undo(target), true)
  assert.equal(state.doc.toString(), original)
})

test('editor captures offsets and direction but refuses stale document/owner and multiple selections', () => {
  let state = EditorState.create({ doc: 'A001 A002', selection: { anchor: 9, head: 0 } })
  let owner = true
  const view = { get state() { return state }, dispatch(spec) { state = state.update(spec).state }, focus() {} }
  const captured = captureSqlEditorFormat(view, () => owner)
  state = state.update({ selection: { anchor: 0 } }).state
  captured.apply(prepareSqlFormat(captured.text, 'mysql', captured.range))
  assert.equal(state.selection.main.anchor, state.doc.length)
  assert.equal(state.selection.main.head, 0)
  assert.throws(() => captured.apply(prepareSqlFormat(captured.text, 'mysql', captured.range)), /变化/)
  owner = false
  assert.throws(() => captureSqlEditorFormat(view, () => owner).apply(prepareSqlFormat(state.doc.toString(), 'mysql')), /变化/)
  state = EditorState.create({ doc: 'A001 A002', selection: EditorSelection.create([EditorSelection.range(0, 4), EditorSelection.range(5, 9)]), extensions: EditorState.allowMultipleSelections.of(true) })
  assert.throws(() => captureSqlEditorFormat(view, () => true), /一个连续选区/)
})

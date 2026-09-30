import test from 'node:test'
import assert from 'node:assert/strict'
import { analyzeContext, buildCompletion, buildSuggestions, enumerateStatements, isInsideCommentOrLiteral, locateStatement, opensTableSlot, resolveScope, shouldOfferCompletions, suggestionMatches, suggestionScore } from '../src/client/sql/completion/engine.ts'

const tables = [{ name: 'user', kind: 'table' }, { name: 'order_info', kind: 'table' }, { name: 'v_user', kind: 'view' }]
const columns = {
  user: [{ name: 'id', type: 'bigint' }, { name: 'username', type: 'varchar(100)' }],
  order_info: [{ name: 'id', type: 'bigint' }, { name: 'user_id', type: 'bigint' }, { name: 'order_no', type: 'varchar(32)' }],
}

test('FROM completes tables and views', () => {
  const sql = 'SELECT *\nFROM '
  const suggestions = buildSuggestions({
    context: analyzeContext(sql, sql.length),
    scope: resolveScope(sql),
    schema: 'biz',
    tables,
    columnsOf: name => columns[name],
  })
  assert.deepEqual(suggestions.map(item => item.label).sort(), ['order_info', 'user', 'v_user'])
})

test('JOIN also suggests views', () => {
  const sql = 'SELECT * FROM user JOIN '
  const suggestions = buildSuggestions({
    context: analyzeContext(sql, sql.length),
    scope: resolveScope(sql),
    schema: 'biz',
    tables,
    columnsOf: name => columns[name],
  })
  assert.ok(suggestions.some(item => item.label === 'v_user'))
})

test('INSERT INTO does not suggest views', () => {
  const sql = 'INSERT INTO '
  const suggestions = buildSuggestions({
    context: analyzeContext(sql, sql.length),
    scope: resolveScope(sql),
    schema: 'biz',
    tables,
    columnsOf: name => columns[name],
  })
  assert.deepEqual(suggestions.map(item => item.label).sort(), ['order_info', 'user'])
})

test('alias qualifier only returns that table columns', () => {
  const sql = 'SELECT u.\nFROM user u'
  const offset = sql.indexOf('.') + 1
  const suggestions = buildSuggestions({
    context: analyzeContext(sql, offset),
    scope: resolveScope(sql),
    schema: 'biz',
    tables,
    columnsOf: name => columns[name],
  })
  assert.deepEqual(suggestions.map(item => item.label), ['id', 'username'])
})

test('unqualified SELECT uses scoped alias.column', () => {
  const sql = 'SELECT \nFROM user u\nJOIN order_info o ON o.user_id = u.id'
  const suggestions = buildSuggestions({
    context: analyzeContext(sql, 'SELECT '.length),
    scope: resolveScope(sql),
    schema: 'biz',
    tables,
    columnsOf: name => columns[name],
  })
  assert.ok(suggestions.some(item => item.insert === 'u.id'))
  assert.ok(suggestions.some(item => item.insert === 'o.order_no'))
  assert.ok(suggestions.some(item => item.label === 'u.id'))
  assert.ok(suggestions.some(item => item.label === 'o.id'))
  assert.ok(!suggestions.some(item => item.insert === 'id'))
})

test('should complete bare column names when the single table has no alias', () => {
  const sql = 'SELECT \nFROM user\nWHERE '
  const suggestions = buildSuggestions({
    context: analyzeContext(sql, 'SELECT '.length),
    scope: resolveScope(sql),
    schema: 'biz',
    tables,
    columnsOf: name => columns[name],
  })
  assert.ok(suggestions.some(item => item.insert === 'id'))
  assert.ok(suggestions.some(item => item.insert === 'username'))
  assert.ok(!suggestions.some(item => item.insert === 'user.id'))
})

test('should complete alias-prefixed columns when the single table has an alias', () => {
  const sql = 'SELECT \nFROM user u'
  const suggestions = buildSuggestions({
    context: analyzeContext(sql, 'SELECT '.length),
    scope: resolveScope(sql),
    schema: 'biz',
    tables,
    columnsOf: name => columns[name],
  })
  assert.ok(suggestions.some(item => item.insert === 'u.id'))
  assert.ok(!suggestions.some(item => item.insert === 'id'))
})

test('AND after WHERE completes alias.column', () => {
  const sql = "SELECT * FROM hotels a WHERE id = '1' AND n"
  const suggestions = buildSuggestions({
    context: analyzeContext(sql, sql.length),
    scope: resolveScope(sql),
    schema: 'XIE_CHENG',
    tables: [{ name: 'hotels', kind: 'table' }],
    columnsOf: name => name === 'hotels' ? [{ name: 'id', type: 'int' }, { name: 'name', type: 'varchar(255)' }, { name: 'location', type: 'varchar(255)' }] : undefined,
  })
  const name = suggestions.find(item => item.insert === 'a.name')
  assert.ok(name)
  assert.equal(name.insert, 'a.name')
  assert.ok(suggestionMatches('n', name))
  assert.ok(suggestionMatches('a', name))
  assert.ok(suggestionMatches('a.n', name))
  assert.ok(!suggestionMatches('x', name))
})

test('partial alias.column still uses qualifier columns', () => {
  const sql = 'SELECT u.i FROM user u'
  const offset = sql.indexOf('.i') + 2
  const ctx = analyzeContext(sql, offset)
  assert.equal(ctx.type, 'column')
  assert.equal(ctx.qualifier, 'u')
  const suggestions = buildSuggestions({
    context: ctx,
    scope: resolveScope(sql),
    schema: 'biz',
    tables,
    columnsOf: name => columns[name],
  })
  assert.equal(suggestions.find(item => item.label === 'id')?.insert, 'id')
})

test('empty prefix offers table completions after FROM/JOIN but not after SELECT', () => {
  const fromSql = 'SELECT * FROM '
  assert.equal(shouldOfferCompletions('', false, analyzeContext(fromSql, fromSql.length)), true)
  const joinSql = 'SELECT * FROM user JOIN '
  assert.equal(shouldOfferCompletions('', false, analyzeContext(joinSql, joinSql.length)), true)
  assert.equal(shouldOfferCompletions('u', false, analyzeContext('SELECT * FROM u', 'SELECT * FROM u'.length)), true)
  const selectSql = 'SELECT '
  assert.equal(shouldOfferCompletions('', false, analyzeContext(selectSql, selectSql.length)), false)
  assert.equal(shouldOfferCompletions('', true, analyzeContext(selectSql, selectSql.length)), true)
  const dotted = 'SELECT u.\nFROM user u'
  const offset = dotted.indexOf('.') + 1
  assert.equal(shouldOfferCompletions('', false, analyzeContext(dotted, offset)), true)
  const qualified = 'SELECT * FROM biz.'
  assert.equal(analyzeContext(qualified, qualified.length).type, 'table')
})

test('qualified FROM table then space leaves the table slot', () => {
  const sql = 'SELECT * FROM biz.user '
  const ctx = analyzeContext(sql, sql.length)
  assert.equal(ctx.type, 'keyword')
  const suggestions = buildSuggestions({
    context: ctx,
    scope: resolveScope(sql),
    schema: 'biz',
    tables,
    columnsOf: name => columns[name],
  })
  assert.ok(suggestions.some(item => item.label === 'WHERE'))
})

test('FROM partial token still completes tables', () => {
  const sql = 'SELECT * FROM use'
  const suggestions = buildSuggestions({
    context: analyzeContext(sql, sql.length),
    scope: resolveScope(sql),
    schema: 'biz',
    tables,
    columnsOf: name => columns[name],
  })
  assert.ok(suggestions.some(item => item.label === 'user'))
  assert.ok(!suggestions.some(item => item.kind === 'keyword'))
})

test('SELECT list offers FROM keyword and table-opening keywords insert a trailing space', () => {
  const sql = 'SELECT * '
  const suggestions = buildSuggestions({
    context: analyzeContext(sql, sql.length),
    scope: resolveScope(sql),
    schema: 'biz',
    tables,
    columnsOf: name => columns[name],
  })
  const from = suggestions.find(item => item.label === 'FROM')
  assert.ok(from)
  assert.equal(from.insert, 'FROM ')
  assert.ok(suggestionMatches('f', from))
  assert.ok(suggestionMatches('fr', from))
  assert.ok(!suggestions.some(item => item.label === 'WHERE'))
  assert.equal(opensTableSlot('FROM'), true)
  assert.equal(opensTableSlot('LEFT JOIN'), true)
  assert.equal(opensTableSlot('WHERE'), false)
})

test('INSERT and UPDATE keywords also open a table slot', () => {
  const insertSql = 'INSERT '
  const insert = buildSuggestions({
    context: analyzeContext(insertSql, insertSql.length),
    scope: resolveScope(insertSql),
    schema: 'biz',
    tables,
    columnsOf: name => columns[name],
  }).find(item => item.label === 'INTO')
  assert.ok(insert)
  assert.equal(insert.insert, 'INTO ')
  const updateSql = 'UPDATE '
  assert.equal(analyzeContext(updateSql, updateSql.length).type, 'table')
})

test('multi-word keywords match on any word', () => {
  assert.ok(suggestionMatches('j', { label: 'LEFT JOIN', insert: 'LEFT JOIN', kind: 'keyword', boost: 40 }))
  assert.ok(suggestionMatches('n', { label: 'IS NULL', insert: 'IS NULL', kind: 'keyword', boost: 20 }))
  assert.ok(suggestionMatches('not', { label: 'IS NOT NULL', insert: 'IS NOT NULL', kind: 'keyword', boost: 20 }))
  assert.ok(suggestionMatches('ord', { label: 'order_no', insert: 'o.order_no', kind: 'column', boost: 100 }))
})

test('WHERE suggests IS NOT NULL', () => {
  const sql = 'SELECT * FROM user WHERE '
  const suggestions = buildSuggestions({
    context: analyzeContext(sql, sql.length),
    scope: resolveScope(sql),
    schema: 'biz',
    tables,
    columnsOf: name => columns[name],
  })
  assert.ok(suggestions.some(item => item.label === 'IS NOT NULL'))
  assert.ok(suggestions.some(item => item.label === 'IS NULL'))
})

test('fuzzy match ranks prefix above subsequence and ignores single-char noise', () => {
  const user = { label: 'user', insert: 'user', kind: 'table', boost: 80 }
  const userStatus = { label: 'user_status', insert: 'user_status', kind: 'table', boost: 80 }
  const orderNo = { label: 'order_no', insert: 'o.order_no', kind: 'column', boost: 100 }
  assert.ok(suggestionMatches('usr', user))
  assert.ok(suggestionMatches('ono', orderNo))
  assert.ok(suggestionScore('user', user) > suggestionScore('user', userStatus))
  assert.ok(suggestionScore('usr', user) > suggestionScore('usr', userStatus))
  assert.ok(!suggestionMatches('x', { label: 'AND', insert: 'AND', kind: 'keyword', boost: 20 }))
  assert.ok(!suggestionMatches('i', { label: 'DISTINCT', insert: 'DISTINCT', kind: 'keyword', boost: 45 }))
  assert.ok(suggestionMatches('d', { label: 'DISTINCT', insert: 'DISTINCT', kind: 'keyword', boost: 45 }))
  assert.ok(suggestionMatches('i', { label: 'id', insert: 'u.id', kind: 'column', boost: 100 }))
})

test('statement locator ignores semicolons in strings', () => {
  const sql = "SELECT 'a;b';\nSELECT * FROM user"
  const found = locateStatement(sql, sql.length)
  assert.match(found.sql, /FROM user/)
})

test('enumerateStatements splits executable statements and keeps comment/string semicolons', () => {
  const sql = "SELECT 1; -- skip;\nSELECT 'a;b' FROM dual;   ;\nUPDATE t SET x = 1"
  const all = enumerateStatements(sql)
  assert.equal(all.length, 4)
  const found = locateStatement(sql, sql.indexOf('UPDATE'))
  assert.match(found.sql, /UPDATE t SET x = 1/)
  const comment = "SELECT 1 /* ; inner */ ; SELECT 2"
  const ranges = enumerateStatements(comment)
  assert.equal(ranges.filter(item => item.sql.trim()).length, 2)
})

const oracleTables = [{ name: 'EMP', kind: 'table' }, { name: 'DEPT', kind: 'table' }, { name: 'V_EMP', kind: 'view' }]
const oracleColumns = {
  EMP: [{ name: 'EMPNO', type: 'NUMBER' }, { name: 'ENAME', type: 'VARCHAR2(10)' }],
  DEPT: [{ name: 'DEPTNO', type: 'NUMBER' }],
  V_EMP: [{ name: 'EMPNO', type: 'NUMBER' }],
}
function oracleSuggest(sql, offset = sql.length) {
  return buildSuggestions({
    context: analyzeContext(sql, offset, 'oracle'),
    scope: resolveScope(sql, 'oracle'),
    schema: 'HR',
    dialect: 'oracle',
    tables: oracleTables,
    columnsOf: name => oracleColumns[name] || oracleColumns[name.toUpperCase()],
  })
}

test('Oracle alias columns and unquoted case-insensitive match', () => {
  const sql = 'SELECT e.\nFROM emp e'
  const offset = sql.indexOf('.') + 1
  const suggestions = oracleSuggest(sql, offset)
  assert.deepEqual(suggestions.map(item => item.label), ['EMPNO', 'ENAME'])
})

test('Oracle FROM suggests tables and views', () => {
  const sql = 'SELECT * FROM '
  const labels = oracleSuggest(sql).map(item => item.label).sort()
  assert.deepEqual(labels, ['DEPT', 'EMP', 'V_EMP'])
})

test('Oracle UPDATE does not suggest views', () => {
  const sql = 'UPDATE '
  const labels = oracleSuggest(sql).map(item => item.label).sort()
  assert.deepEqual(labels, ['DEPT', 'EMP'])
})

test('Oracle keyword completion includes FETCH FIRST', () => {
  const sql = 'SELECT * FROM EMP '
  const suggestions = oracleSuggest(sql)
  assert.ok(suggestions.some(item => item.label === 'FETCH FIRST'))
  assert.ok(suggestions.some(item => item.label === 'OFFSET'))
  assert.ok(!suggestions.some(item => item.label === 'LIMIT'))
})

test('Oracle qualified names only load columns for the current schema', () => {
  const current = 'SELECT HR.EMP.\nFROM EMP'
  const currentCols = oracleSuggest(current, current.lastIndexOf('.') + 1)
  assert.deepEqual(currentCols.map(item => item.label), ['EMPNO', 'ENAME'])
  const other = 'SELECT OTHER.EMP.\nFROM EMP'
  assert.deepEqual(oracleSuggest(other, other.lastIndexOf('.') + 1), [])
  const otherFrom = 'SELECT * FROM OTHER.'
  assert.deepEqual(oracleSuggest(otherFrom, otherFrom.length), [])
})

test('qualified columns require the table to be in scope', () => {
  const sql = 'SELECT user.'
  const suggestions = buildSuggestions({
    context: analyzeContext(sql, sql.length),
    scope: resolveScope(sql),
    schema: 'biz',
    tables,
    columnsOf: name => columns[name],
  })
  assert.deepEqual(suggestions, [])
  const other = 'SELECT user. FROM order_info'
  assert.deepEqual(buildSuggestions({
    context: analyzeContext(other, other.indexOf('.') + 1),
    scope: resolveScope(other),
    schema: 'biz',
    tables,
    columnsOf: name => columns[name],
  }), [])
})

test('Oracle q-quote literals do not split statements', () => {
  const sql = "SELECT q'[it's a;test]' FROM dual"
  const quoted = locateStatement(sql, sql.length, 'oracle')
  assert.equal(quoted.sql, sql)
  const naive = locateStatement(sql, sql.length, 'mysql')
  assert.ok(naive.sql.length < sql.length)
})

test('cursor inside comments and string literals blocks completion', () => {
  const line = 'SELECT 1 -- note'
  assert.equal(isInsideCommentOrLiteral(line, line.indexOf('n')), true)
  assert.equal(isInsideCommentOrLiteral(line, line.indexOf('-')), false)
  const block = 'SELECT 1 /* x */ FROM t'
  assert.equal(isInsideCommentOrLiteral(block, block.indexOf('x')), true)
  assert.equal(isInsideCommentOrLiteral(block, block.indexOf('F')), false)
  const open = "SELECT 'abc"
  assert.equal(isInsideCommentOrLiteral(open, open.length), true)
  const closed = "SELECT 'abc' FROM"
  assert.equal(isInsideCommentOrLiteral(closed, closed.indexOf('b')), true)
  assert.equal(isInsideCommentOrLiteral(closed, closed.indexOf('F')), false)
  const after = 'SELECT 1 -- note\nFROM t'
  assert.equal(isInsideCommentOrLiteral(after, after.indexOf('\n')), true)
  assert.equal(isInsideCommentOrLiteral(after, after.indexOf('F')), false)
  const q = "SELECT q'[it's a;test]' FROM dual"
  assert.equal(isInsideCommentOrLiteral(q, q.indexOf('a'), 'oracle'), true)
  assert.equal(isInsideCommentOrLiteral(q, q.indexOf('F'), 'oracle'), false)
  const mysqlDq = 'SELECT "abc'
  assert.equal(isInsideCommentOrLiteral(mysqlDq, mysqlDq.length), true)
  const mysqlDqClosed = 'SELECT "abc" FROM t'
  assert.equal(isInsideCommentOrLiteral(mysqlDqClosed, mysqlDqClosed.indexOf('b')), true)
  assert.equal(isInsideCommentOrLiteral(mysqlDqClosed, mysqlDqClosed.indexOf('F')), false)
})

test('quoted identifiers still complete', () => {
  const mysql = 'SELECT `us'
  assert.equal(isInsideCommentOrLiteral(mysql, mysql.length), false)
  const oracle = 'SELECT "US'
  assert.equal(isInsideCommentOrLiteral(oracle, oracle.length, 'oracle'), false)
})

test('quoted table names stay in scope', () => {
  const sql = 'SELECT u.\nFROM `user` u'
  const offset = sql.indexOf('.') + 1
  const suggestions = buildSuggestions({
    context: analyzeContext(sql, offset),
    scope: resolveScope(sql),
    schema: 'biz',
    tables,
    columnsOf: name => columns[name],
  })
  assert.deepEqual(suggestions.map(item => item.label), ['id', 'username'])
})

test('Oracle quoted table names stay in scope', () => {
  const sql = 'SELECT E.\nFROM "EMP" E'
  const offset = sql.indexOf('.') + 1
  assert.deepEqual(oracleSuggest(sql, offset).map(item => item.label), ['EMPNO', 'ENAME'])
})

test('MySQL hash comments block completion and are not aliases', () => {
  const hash = 'SELECT 1 # note'
  assert.equal(isInsideCommentOrLiteral(hash, hash.indexOf('n')), true)
  assert.equal(isInsideCommentOrLiteral(hash, hash.indexOf('#')), false)
  assert.equal(isInsideCommentOrLiteral('SELECT 1 # n', 'SELECT 1 # n'.length, 'oracle'), false)
  const sql = 'SELECT * FROM user # hidden\nWHERE '
  const suggestions = buildSuggestions({
    context: analyzeContext(sql, sql.length),
    scope: resolveScope(sql),
    schema: 'biz',
    tables,
    columnsOf: name => columns[name],
  })
  assert.equal(suggestions.find(item => item.label === 'username')?.insert, 'username')
  assert.ok(!suggestions.some(item => String(item.insert).startsWith('hidden.')))
  const commented = 'SELECT 1 # a;b\nSELECT 2'
  const ranges = enumerateStatements(commented)
  assert.equal(ranges.length, 1)
  assert.equal(ranges[0].sql, commented)
})

test('USING is not taken as a table alias', () => {
  const sql = 'SELECT \nFROM user JOIN order_info USING (id)'
  const scope = resolveScope(sql)
  assert.equal(scope.tables.find(item => item.table === 'order_info')?.alias, undefined)
  assert.equal(scope.aliases.using, undefined)
  const suggestions = buildSuggestions({
    context: analyzeContext(sql, 'SELECT '.length),
    scope,
    schema: 'biz',
    tables,
    columnsOf: name => columns[name],
  })
  assert.ok(suggestions.some(item => item.insert === 'user.id'))
  assert.ok(suggestions.some(item => item.insert === 'order_info.order_no'))
})

test('comma FROM includes later tables', () => {
  const sql = 'SELECT \nFROM user, order_info o'
  const scope = resolveScope(sql)
  assert.deepEqual(scope.tables.map(item => [item.table, item.alias]), [['user', undefined], ['order_info', 'o']])
  const suggestions = buildSuggestions({
    context: analyzeContext(sql, 'SELECT '.length),
    scope,
    schema: 'biz',
    tables,
    columnsOf: name => columns[name],
  })
  assert.ok(suggestions.some(item => item.insert === 'user.id'))
  assert.ok(suggestions.some(item => item.insert === 'o.order_no'))
})

function suggestAt(sql, offset = sql.length, dialect = 'mysql') {
  return buildSuggestions({
    context: analyzeContext(sql, offset, dialect),
    scope: resolveScope(sql, dialect, offset),
    schema: dialect === 'oracle' ? 'HR' : 'biz',
    dialect,
    tables: dialect === 'oracle' ? oracleTables : tables,
    columnsOf: name => dialect === 'oracle' ? oracleColumns[name] || oracleColumns[name.toUpperCase()] : columns[name],
  })
}

test('FOR UPDATE and NATURAL JOIN are not aliases', () => {
  const locked = 'SELECT * FROM user FOR UPDATE'
  const lockScope = resolveScope(locked)
  assert.equal(lockScope.tables[0]?.alias, undefined)
  assert.equal(lockScope.aliases.for, undefined)
  assert.notEqual(analyzeContext(locked, locked.length).type, 'table')
  const where = 'SELECT * FROM user FOR UPDATE WHERE '
  assert.equal(suggestAt(where).find(item => item.label === 'username')?.insert, 'username')
  const natural = 'SELECT \nFROM user NATURAL JOIN order_info'
  const scope = resolveScope(natural, 'mysql', 'SELECT '.length)
  assert.equal(scope.tables.find(item => item.table === 'user')?.alias, undefined)
  assert.equal(scope.aliases.natural, undefined)
  const suggestions = suggestAt(natural, 'SELECT '.length)
  assert.ok(suggestions.some(item => item.insert === 'user.id'))
  assert.ok(suggestions.some(item => item.insert === 'order_info.order_no'))
})

test('INSERT INTO column list completes columns', () => {
  const sql = 'INSERT INTO user ('
  const ctx = analyzeContext(sql, sql.length)
  assert.equal(ctx.type, 'column')
  const suggestions = suggestAt(sql)
  assert.deepEqual(suggestions.filter(item => item.kind === 'column').map(item => item.insert).sort(), ['id', 'username'])
  assert.ok(!suggestions.some(item => item.kind === 'table'))
  assert.equal(shouldOfferCompletions('', false, ctx), true)
  const partial = 'INSERT INTO user (u'
  assert.ok(suggestAt(partial).some(item => item.insert === 'username'))
})

test('IS and IS NULL stay in the WHERE expression branch', () => {
  const afterIs = 'SELECT * FROM user WHERE id IS '
  assert.equal(analyzeContext(afterIs, afterIs.length).type, 'expression')
  const isLabels = suggestAt(afterIs).map(item => item.label)
  assert.ok(isLabels.includes('IS NULL'))
  assert.ok(isLabels.includes('IS NOT NULL'))
  assert.ok(!suggestAt(afterIs).some(item => item.kind === 'table'))
  const afterNull = 'SELECT * FROM user WHERE id IS NULL '
  assert.equal(analyzeContext(afterNull, afterNull.length).type, 'expression')
  assert.ok(suggestAt(afterNull).some(item => item.label === 'AND'))
  assert.ok(!suggestAt(afterNull).some(item => item.kind === 'table'))
})

test('subquery and CTE tables follow nesting', () => {
  const cte = 'WITH c AS (SELECT id FROM user) SELECT \nFROM c'
  const outer = 'WITH c AS (SELECT id FROM user) SELECT '.length
  assert.deepEqual(resolveScope(cte, 'mysql', outer).tables.map(item => item.table), ['c'])
  assert.ok(suggestAt(cte, outer).some(item => item.insert === 'id'))
  assert.ok(!suggestAt(cte, outer).some(item => item.insert === 'username' || item.insert === 'c.username'))
  const innerSql = 'WITH c AS (SELECT \nFROM user) SELECT * FROM c'
  const inner = 'WITH c AS (SELECT '.length
  assert.deepEqual(resolveScope(innerSql, 'mysql', inner).tables.map(item => item.table), ['user', 'c'])
  assert.ok(suggestAt(innerSql, inner).some(item => item.insert === 'user.id' || item.insert === 'id'))
  const derived = 'SELECT \nFROM (SELECT id FROM user) t'
  const derivedOffset = 'SELECT '.length
  assert.deepEqual(resolveScope(derived, 'mysql', derivedOffset).tables.map(item => item.table), ['t'])
  assert.ok(suggestAt(derived, derivedOffset).some(item => item.insert === 't.id'))
  assert.ok(!suggestAt(derived, derivedOffset).some(item => item.insert === 'username' || item.insert === 'user.username' || item.insert === 't.username'))
  const nested = 'SELECT * FROM (SELECT \nFROM user) t'
  const nestedOffset = 'SELECT * FROM (SELECT '.length
  assert.ok(resolveScope(nested, 'mysql', nestedOffset).tables.some(item => item.table === 'user'))
  assert.ok(suggestAt(nested, nestedOffset).some(item => item.insert === 'user.id' || item.insert === 'id'))
  const siblings = 'SELECT * FROM (SELECT \nFROM user) a, (SELECT id FROM order_info) b'
  const siblingOffset = 'SELECT * FROM (SELECT '.length
  const siblingScope = resolveScope(siblings, 'mysql', siblingOffset)
  assert.ok(siblingScope.tables.some(item => item.table === 'user'))
  assert.ok(!siblingScope.tables.some(item => item.table === 'order_info'))
})

test('UNION branches do not share FROM tables', () => {
  const sql = 'SELECT \nFROM user UNION SELECT id FROM order_info'
  const first = 'SELECT '.length
  assert.deepEqual(resolveScope(sql, 'mysql', first).tables.map(item => item.table), ['user'])
  assert.ok(suggestAt(sql, first).some(item => item.insert === 'id' || item.insert === 'username'))
  assert.ok(!suggestAt(sql, first).some(item => String(item.insert).includes('order')))
  const secondSql = 'SELECT id FROM user UNION SELECT \nFROM order_info'
  const second = 'SELECT id FROM user UNION SELECT '.length
  assert.deepEqual(resolveScope(secondSql, 'mysql', second).tables.map(item => item.table), ['order_info'])
  assert.ok(suggestAt(secondSql, second).some(item => item.insert === 'order_no' || item.label === 'order_no'))
  assert.ok(!suggestAt(secondSql, second).some(item => item.label === 'username'))
  const all = 'SELECT \nFROM user UNION ALL SELECT id FROM order_info'
  assert.deepEqual(resolveScope(all, 'mysql', 'SELECT '.length).tables.map(item => item.table), ['user'])
})

test('derived table comma list keeps later tables', () => {
  const sql = 'SELECT \nFROM (SELECT 1) t, order_info o'
  const offset = 'SELECT '.length
  const scope = resolveScope(sql, 'mysql', offset)
  assert.deepEqual(scope.tables.map(item => [item.table, item.alias]), [['t', 't'], ['order_info', 'o']])
  assert.ok(suggestAt(sql, offset).some(item => item.insert === 'o.order_no'))
  const two = 'SELECT \nFROM (SELECT 1) a, (SELECT 2) b'
  assert.deepEqual(resolveScope(two, 'mysql', 'SELECT '.length).tables.map(item => item.table), ['a', 'b'])
})

test('STRAIGHT_JOIN is a join not an alias', () => {
  const sql = 'SELECT \nFROM user STRAIGHT_JOIN order_info'
  const offset = 'SELECT '.length
  const scope = resolveScope(sql, 'mysql', offset)
  assert.equal(scope.tables.find(item => item.table === 'user')?.alias, undefined)
  assert.ok(scope.tables.some(item => item.table === 'order_info'))
  const suggestions = suggestAt(sql, offset)
  assert.ok(suggestions.some(item => item.insert === 'user.id'))
  assert.ok(suggestions.some(item => item.insert === 'order_info.order_no'))
})

test('MySQL dash-dash comments require whitespace', () => {
  const glued = 'SELECT a--b FROM user'
  assert.equal(isInsideCommentOrLiteral(glued, glued.indexOf('b')), false)
  assert.ok(resolveScope(glued, 'mysql', glued.length).tables.some(item => item.table === 'user'))
  const spaced = 'SELECT 1 -- note\nFROM user'
  assert.equal(isInsideCommentOrLiteral(spaced, spaced.indexOf('n')), true)
  const oracle = 'SELECT a--b FROM EMP'
  assert.equal(isInsideCommentOrLiteral(oracle, oracle.indexOf('b'), 'oracle'), true)
  assert.ok(!resolveScope(oracle, 'oracle', oracle.length).tables.some(item => item.table === 'EMP'))
})

test('no table scope means no column guessing', () => {
  const sql = 'SELECT '
  const suggestions = buildSuggestions({
    context: analyzeContext(sql, sql.length),
    scope: resolveScope(sql),
    schema: 'biz',
    tables,
    columnsOf: name => columns[name],
  })
  assert.ok(!suggestions.some(item => item.kind === 'column'))
})

test('buildCompletion reports tables with unknown columns', () => {
  const sql = 'SELECT \nFROM user JOIN order_info o'
  const result = buildCompletion({
    context: analyzeContext(sql, 'SELECT '.length),
    scope: resolveScope(sql),
    schema: 'biz',
    tables,
    columnsOf: () => undefined,
  })
  assert.deepEqual([...result.pending].sort(), ['order_info', 'user'])
  assert.ok(!result.suggestions.some(item => item.kind === 'column'))
  const again = buildCompletion({
    context: analyzeContext(sql, 'SELECT '.length),
    scope: resolveScope(sql),
    schema: 'biz',
    tables,
    columnsOf: () => undefined,
  })
  assert.equal(again.pending.filter(name => name === 'user').length, 1)
})

test('ORDER BY and GROUP BY suggest columns without WHERE keywords', () => {
  for (const sql of ['SELECT id FROM user ORDER BY ', 'SELECT id FROM user GROUP BY ']) {
    const suggestions = suggestAt(sql)
    assert.ok(suggestions.some(item => item.insert === 'id'))
    assert.ok(!suggestions.some(item => item.label === 'AND' || item.label === 'IS NULL' || item.label === 'IS NOT NULL'))
  }
  const having = 'SELECT id FROM user GROUP BY id HAVING '
  assert.ok(suggestAt(having).some(item => item.label === 'AND'))
})

test('single-letter keyword query does not match DISTINCT', () => {
  const sql = 'SELECT i\nFROM user'
  const matched = suggestAt(sql, 'SELECT i'.length).filter(item => suggestionMatches('i', item))
  assert.ok(matched.some(item => item.insert === 'id'))
  assert.ok(!matched.some(item => item.label === 'DISTINCT'))
})

test('Oracle quoted identifiers keep a backslash', () => {
  const sql = 'SELECT * FROM "id\\x" t WHERE '
  const scope = resolveScope(sql, 'oracle')
  assert.equal(scope.tables[0]?.table, 'id\\x')
  assert.equal(scope.tables[0]?.alias, 't')
  assert.equal(isInsideCommentOrLiteral("SELECT 'a\\'b' FROM EMP", 10, 'oracle'), true)
})

test('derived star and CTE column lists project columns', () => {
  const star = 'SELECT \nFROM (SELECT * FROM user) t'
  assert.ok(suggestAt(star, 'SELECT '.length).some(item => item.insert === 't.username'))
  const named = 'WITH c (a, b) AS (SELECT id, username FROM user) SELECT \nFROM c'
  const labels = suggestAt(named, 'WITH c (a, b) AS (SELECT id, username FROM user) SELECT '.length).map(item => item.insert)
  assert.ok(labels.includes('a'))
  assert.ok(labels.includes('b'))
  assert.ok(!labels.includes('id'))
  const aliased = 'WITH c AS (SELECT id AS user_id FROM user) SELECT \nFROM c'
  assert.ok(suggestAt(aliased, 'WITH c AS (SELECT id AS user_id FROM user) SELECT '.length).some(item => item.insert === 'user_id'))
})

test('FROM other.table completes columns from that schema', () => {
  const sql = 'SELECT \nFROM other.user'
  const suggestions = buildSuggestions({
    context: analyzeContext(sql, 'SELECT '.length),
    scope: resolveScope(sql),
    schema: 'biz',
    tables,
    columnsOf: (name, database) => database === 'other' && name === 'user' ? [{ name: 'remote_id', type: 'int' }] : undefined,
  })
  assert.ok(suggestions.some(item => item.insert === 'remote_id'))
  const dotted = 'SELECT user.\nFROM other.user'
  const qualified = buildSuggestions({
    context: analyzeContext(dotted, dotted.indexOf('.') + 1),
    scope: resolveScope(dotted),
    schema: 'biz',
    tables,
    columnsOf: (name, database) => database === 'other' && name === 'user' ? [{ name: 'remote_id', type: 'int' }] : undefined,
  })
  assert.deepEqual(qualified.map(item => item.label), ['remote_id'])
})

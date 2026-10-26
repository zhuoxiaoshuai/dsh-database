import test from 'node:test'
import assert from 'node:assert/strict'
import { existsSync, readFileSync, readdirSync } from 'node:fs'
import { join, relative } from 'node:path'
import { fileURLToPath } from 'node:url'

const root = fileURLToPath(new URL('..', import.meta.url))
const read = path => readFileSync(join(root, path), 'utf8')
function walk(dir, extensions) {
  const out = []
  for (const entry of readdirSync(join(root, dir), { withFileTypes: true })) {
    const path = `${dir}/${entry.name}`
    if (entry.isDirectory()) out.push(...walk(path, extensions))
    else if (extensions.some(extension => entry.name.endsWith(extension))) out.push(path)
  }
  return out
}

/** Files removed by the D0-D3 cleanup must not come back. */
const REMOVED = [
  'src/host/data-sources/runtime-registry.mjs',
  'src/host/data-sources/types.mjs',
  'src/host/oracle-temporal.mjs',
  'src/connection-service.ts',
  'src/client/search-select.tsx',
  'src/client/workspace/parts/action-menu.tsx',
  'src/client/workspace/parts/dialog-frame.tsx',
  'src/client/workspace/parts/dialog.ts',
  'src/client/workspace/parts/host-theme.ts',
  'src/client/workspace/parts/resource-list.tsx',
  'src/client/workspace/parts/theme-tokens.ts',
  'src/client/workspace/parts/use-drag-resize.ts',
  'src/client/workspace/parts/use-drawer-focus.ts',
  'src/client/workspace/parts/use-panel-size.ts',
  'src/client/workspace/parts/use-workbench-theme.ts',
  'src/client/workspace/parts/workbench-theme.ts',
  'src/client/workspace/parts/feedback/resource-list.tsx',
  'src/client/workspace/source/editor-host.ts',
  'src/client/workspace/source/editor-theme.ts',
  'src/client/workspace/source/query-result-frame.tsx',
  'src/client/workspace/source/text-editor-extensions.ts',
  'src/client/workspace/source/workspace-tabs.tsx',
]

/** Retained on purpose: build path mirrors and the client/Host boundary. */
const RETAINED = [
  'src/host/shared/connection-permission.mjs',
  'src/host/shared/limits.mjs',
  'src/shared/connection-permission.ts',
  'src/shared/limits.ts',
  'src/shared/primary-keys.ts',
]

test('removed compatibility aliases stay removed and retained facades stay', () => {
  for (const path of REMOVED) assert.equal(existsSync(join(root, path)), false, `${path} must not return`)
  for (const path of RETAINED) assert.equal(existsSync(join(root, path)), true, `${path} is a required facade`)
})

/** Single-statement re-export, possibly multi-line `export { ... } from '...'`. */
const shimStatement = /^\s*export\s+(?:\*|\{[^}]*\}|type\s+\{[^}]*\})\s+from\s+['"][^'"]+['"];?\s*$/
const shimBlockOpen = /^\s*export\s+(?:type\s+)?\{$/
const shimBlockClose = /^\s*\}\s*from\s+['"][^'"]+['"];?\s*$/

/** A file is a shim only when every statement is a re-export; partial re-exports keep their own exports. */
function isReExportShim(source) {
  const lines = source.split('\n').map(line => line.trim()).filter(line => line && !line.startsWith('//') && !line.startsWith('/*') && !line.startsWith('*'))
  if (!lines.length) return false
  let inBlock = false
  for (const line of lines) {
    if (inBlock) {
      if (shimBlockClose.test(line)) inBlock = false
      continue
    }
    if (shimStatement.test(line)) continue
    if (shimBlockOpen.test(line)) { inBlock = true; continue }
    return false
  }
  return !inBlock
}

test('client and host have no compatibility re-export shims', () => {
  for (const dir of ['src/client', 'src/host']) {
    for (const path of walk(dir, ['.ts', '.tsx', '.mjs'])) {
      if (RETAINED.includes(path)) continue
      assert.ok(!isReExportShim(read(path)), `${path} 是兼容性 re-export 垫片`)
    }
  }
})

// ---------------------------------------------------------------------------
// 跨文件重复实现门禁：函数体与常量字面量不得在不同文件重复
// ---------------------------------------------------------------------------

/** 函数体空白归一化后达到该长度才判定重复，短助手不拦。 */
const DUPLICATE_FUNCTION_MIN_LENGTH = 100
/** 常量字面量至少包含这么多个字符串才判定重复。 */
const DUPLICATE_CONST_MIN_STRINGS = 3

/**
 * 已知的跨文件重复实现豁免名单（按 函数/常量 名 + 所在文件精确匹配）。
 * 当前为空：nativeDriverError／driverErrorFields 与 maintenance 的 wanted 均已收敛为共享实现。
 * 只有确属有意重复时才在此登记，并先写进 docs/cleanup-facades.md。
 */
const KNOWN_DUPLICATES = []

const functionHeader = /(?:^|[\s;}])(?:export\s+)?(?:default\s+)?(?:async\s+)?function\s*\*?\s*([A-Za-z_$][\w$]*)\s*\(/g
const constantHeader = /(?:^|[\s;}])(?:export\s+)?const\s+([A-Za-z_$][\w$]*)\s*(?::[^=]*)?=\s*([\[{])/g
const stringLiteral = /'(?:[^'\\\n]|\\.)*'|"(?:[^"\\\n]|\\.)*"|`(?:[^`\\]|\\.)*`/g
const regexKeywords = new Set(['return', 'typeof', 'case', 'in', 'of', 'new', 'delete', 'void', 'instanceof', 'do', 'else', 'yield', 'await'])
const typeStart = new Set([':', '|', ',', '<', '('])
const normalizeBody = text => text.replace(/\s+/g, ' ').trim()

function skipString(source, index, quote) {
  let i = index + 1
  while (i < source.length) {
    const ch = source[i]
    if (ch === '\\') { i += 2; continue }
    if (ch === quote) return i + 1
    if (quote === '`' && ch === '$' && source[i + 1] === '{') { i = matchBracket(source, i + 1, '{', '}'); continue }
    i += 1
  }
  return i
}

function skipRegex(source, index) {
  let i = index + 1
  let inClass = false
  while (i < source.length) {
    const ch = source[i]
    if (ch === '\\') { i += 2; continue }
    if (ch === '[') inClass = true
    else if (ch === ']') inClass = false
    else if (ch === '/' && !inClass) return i + 1
    else if (ch === '\n') return i
    i += 1
  }
  return i
}

function regexAllowed(source, index) {
  let j = index - 1
  while (j >= 0 && /\s/.test(source[j])) j -= 1
  if (j < 0) return true
  if (/[A-Za-z0-9_$)\]]/.test(source[j])) {
    let k = j
    while (k >= 0 && /[A-Za-z0-9_$]/.test(source[k])) k -= 1
    return regexKeywords.has(source.slice(k + 1, j + 1))
  }
  return true
}

/** Index just past the bracket matching source[index]; strings, comments and regex literals are skipped. */
function matchBracket(source, index, open, close) {
  let depth = 0
  let i = index
  while (i < source.length) {
    const ch = source[i]
    if (ch === open) { depth += 1; i += 1 }
    else if (ch === close) { depth -= 1; i += 1; if (!depth) return i }
    else if (ch === '"' || ch === "'" || ch === '`') i = skipString(source, i, ch)
    else if (ch === '/' && source[i + 1] === '/') { const end = source.indexOf('\n', i); i = end === -1 ? source.length : end }
    else if (ch === '/' && source[i + 1] === '*') { const end = source.indexOf('*/', i); i = end === -1 ? source.length : end + 2 }
    else if (ch === '/' && regexAllowed(source, i)) i = skipRegex(source, i)
    else i += 1
  }
  return i
}

function previousSignificant(source, index) {
  let j = index - 1
  while (j >= 0 && /\s/.test(source[j])) j -= 1
  return j < 0 ? '' : source[j]
}

/** Body text of `function NAME(...) { ... }`, skipping a typed return annotation before the body. */
function functionBody(source, paramsOpen) {
  let i = matchBracket(source, paramsOpen, '(', ')')
  while (i < source.length) {
    const ch = source[i]
    if (ch === '"' || ch === "'" || ch === '`') { i = skipString(source, i, ch); continue }
    if (ch === '/' && source[i + 1] === '/') { const end = source.indexOf('\n', i); i = end === -1 ? source.length : end; continue }
    if (ch === '/' && source[i + 1] === '*') { const end = source.indexOf('*/', i); i = end === -1 ? source.length : end + 2; continue }
    if (ch === '{') {
      if (typeStart.has(previousSignificant(source, i))) { i = matchBracket(source, i, '{', '}'); continue }
      const end = matchBracket(source, i, '{', '}')
      return source.slice(i + 1, end - 1)
    }
    i += 1
  }
  return null
}

function collectDuplicates(entries) {
  const groups = new Map()
  const add = (kind, name, path, text) => {
    const key = `${kind}\u0000${text}`
    if (!groups.has(key)) groups.set(key, { kind, text, occurrences: [] })
    groups.get(key).occurrences.push({ path, name })
  }
  for (const { path, source } of entries) {
    for (const match of source.matchAll(functionHeader)) {
      const body = functionBody(source, match.index + match[0].length - 1)
      if (body === null) continue
      const text = normalizeBody(body)
      if (text.length >= DUPLICATE_FUNCTION_MIN_LENGTH) add('function', match[1], path, text)
    }
    for (const match of source.matchAll(constantHeader)) {
      const open = match.index + match[0].length - 1
      const end = matchBracket(source, open, source[open], source[open] === '[' ? ']' : '}')
      const literal = source.slice(open, end)
      const strings = literal.match(stringLiteral) || []
      if (strings.length >= DUPLICATE_CONST_MIN_STRINGS) add('constant', match[1], path, normalizeBody(literal))
    }
  }
  return [...groups.values()].filter(group => new Set(group.occurrences.map(occurrence => occurrence.path)).size > 1)
}

function isKnownDuplicate(group, known = KNOWN_DUPLICATES) {
  return group.occurrences.every(occurrence =>
    known.some(entry => entry.name === occurrence.name && entry.files.includes(occurrence.path)))
}

test('no duplicated implementations across source files', () => {
  const entries = walk('src', ['.ts', '.tsx', '.mjs']).map(path => ({ path, source: read(path) }))
  for (const group of collectDuplicates(entries)) {
    const files = [...new Set(group.occurrences.map(occurrence => occurrence.path))]
    const names = [...new Set(group.occurrences.map(occurrence => occurrence.name))]
    const kind = group.kind === 'function' ? '函数体' : '常量字面量'
    assert.ok(isKnownDuplicate(group),
      `${files.join(' 与 ')} 的${kind} ${names.join('、')} 完全相同（归一化后 ${group.text.length} 字符），请提取共享实现`)
  }
})

test('duplicate implementation gate catches new cross-file repeats', () => {
  const body = [
    "const text = String(input ?? '').trim()",
    'if (!text) return null',
    'const [head, ...rest] = text.split(/\\s+/)',
    "return [head.toLowerCase(), ...rest.map(part => part.toUpperCase())].join(' ')",
  ].join('\n')
  const withFunction = name => `export function ${name}(input) {\n  ${body.replace(/\n/g, '\n  ')}\n}\n`
  const withTypedFunction = name => `export function ${name}(input: string): { status: string; message: string } | undefined {\n  ${body.replace(/\n/g, '\n  ')}\n}\n`
  const withConstant = name => `export const ${name} = ['read', 'write', 'delete', 'truncate']\n`

  assert.equal(collectDuplicates([
    { path: 'src/a.ts', source: withFunction('alpha') },
    { path: 'src/b.ts', source: withFunction('beta') },
  ]).length, 1, '不同文件的相同函数体应被拦住')
  assert.equal(collectDuplicates([
    { path: 'src/a.ts', source: withTypedFunction('alpha') },
    { path: 'src/b.ts', source: withTypedFunction('beta') },
  ]).length, 1, '带对象返回类型的相同函数体应被拦住')
  assert.equal(collectDuplicates([
    { path: 'src/a.ts', source: withConstant('KINDS') },
    { path: 'src/b.ts', source: withConstant('MODES') },
  ]).length, 1, '不同文件的相同常量字面量应被拦住')
  assert.equal(collectDuplicates([
    { path: 'src/a.ts', source: withFunction('alpha') + withFunction('beta') },
  ]).length, 0, '同一文件内的重复不算跨文件重复')
  assert.equal(collectDuplicates([
    { path: 'src/a.ts', source: 'export function tiny(x) {\n  return x\n}\n' },
    { path: 'src/b.ts', source: 'export function small(x) {\n  return x\n}\n' },
  ]).length, 0, '归一化后不足 100 字符的函数体不拦')
  assert.equal(collectDuplicates([
    { path: 'src/a.ts', source: "export const KINDS = ['read', 'write']\n" },
    { path: 'src/b.ts', source: "export const MODES = ['read', 'write']\n" },
  ]).length, 0, '不足 3 个字符串的常量字面量不拦')
  assert.equal(isKnownDuplicate({
    kind: 'function', text: 'body', occurrences: [
      { path: 'src/a.ts', name: 'alpha' },
      { path: 'src/b.ts', name: 'alpha' },
    ],
  }, [{ name: 'alpha', files: ['src/a.ts', 'src/b.ts'] }]), true, '豁免名单内的重复应放行')
  assert.equal(isKnownDuplicate({
    kind: 'function', text: 'body', occurrences: [
      { path: 'src/a.ts', name: 'alpha' },
      { path: 'src/c.ts', name: 'alpha' },
    ],
  }, [{ name: 'alpha', files: ['src/a.ts', 'src/b.ts'] }]), false, '豁免名单之外的新重复仍应拦住')
})

test('host policy delegates SQL splitting to the shared lexer', () => {
  const policy = read('src/host/data-sources/sql-policy-common.mjs')
  assert.match(policy, /import \{ splitStatements \} from '\.\.\/\.\.\/shared\/sql-lex\.ts'/)
  assert.doesNotMatch(policy, /export function splitStatements/)
  assert.match(read('src/shared/sql-lex.ts'), /export function splitStatements/)
})

test('standalone entries share direct-run detection', () => {
  for (const path of ['src/launch.ts', 'src/serve.ts']) {
    const source = read(path)
    assert.doesNotMatch(source, /function isDirectRun/, `${path} must use the shared helper`)
    assert.match(source, /isDirectRun\(import\.meta\.url\)/, `${path} must compare its own entry`)
  }
})

test('client code never imports the host', () => {
  const hostImport = /from ['"](?:\.{1,2}\/)+host(?:\/[^'"]*)?['"]/
  for (const path of walk('src/client', ['.ts', '.tsx'])) {
    assert.doesNotMatch(read(path), hostImport, `${path} imports the host`)
  }
})

test('package exports stay the three public entries', () => {
  assert.deepEqual(Object.keys(JSON.parse(read('package.json')).exports), ['.', './client', './package.json'])
})

test('sharedQuery is read only by its public projection and legacy migration', () => {
  // sharedQuery 只剩两个身份：① publicConnection 的公共兼容投影；② 旧持久化数据的迁移输入。
  // 白名单（读取原因）：
  // - src/host/saved-connections.ts：公共兼容投影，把执行文档投影回 sharedQuery 供旧客户端。
  // - src/host/conversation-workbench-store.ts：旧持久化数据迁移，sanitize 删除已迁移字段并重置旧模型会话字段。
  // - src/shared/workbench.ts：SharedQuery 类型与 sanitizeSharedQuery/migrateSharedQuery/legacySharedQueryDocument，旧数据还要读。
  // 其余 src/** 一律读 aiDocument 或文档派生值。
  const allowed = new Set(['src/host/saved-connections.ts', 'src/host/conversation-workbench-store.ts', 'src/shared/workbench.ts'])
  const access = /\.\s*sharedQuery\b|\[\s*['"]sharedQuery['"]\s*\]/
  const offenders = walk('src', ['.ts', '.tsx', '.mjs', '.js']).filter(path => !allowed.has(path) && access.test(read(path)))
  assert.deepEqual(offenders, [], '只有公共投影与旧数据迁移允许读取 sharedQuery')
})

import React, { useEffect, useMemo, useRef, useState } from 'react'
import { Folder, KeyRound, Plus, X } from 'lucide-react'
import type { Connection, WorkspaceBridge } from '../../shared/workbench.ts'
import type { RedisValue } from '../../shared/redis-result.ts'
import { RedisValueView as Value } from './value.tsx'
import { formatValue } from '../workspace/parts/formatted-cell-value.ts'
import { useDialog } from '../workspace/parts/dialog.ts'
import { useDragResize } from '../workspace/parts/use-drag-resize.ts'
import { usePagedList } from '../workspace/parts/use-paged-list.ts'
import { SearchTree, SearchTreeNode, SearchTreeSplit } from '../workspace/tree/search-tree.tsx'
import { redisKeyMatches, redisScanMatch } from '../../shared/redis-scan-match.ts'
import { buildKeyTree, type KeyFolder } from './key-tree.ts'
import { detailCard, detailRows, nextPage, rejectStringSave, rowSubmittable, stringFromDetail, tableColumns, viewKind, type KeyRow, type StringEncoding } from './key-model.ts'
import { RedisKeyToolbar } from './key-toolbar.tsx'
import { RedisKeyString } from './key-string.tsx'
import { RedisKeyTable } from './key-table.tsx'
import { RedisKeyStream } from './key-stream.tsx'
import { RedisKeyBitmap } from './key-bitmap.tsx'
import { RedisKeyCard } from './key-card.tsx'

const SCAN_ALL_PAGES = 200
type KeyKind = 'string' | 'hash' | 'list' | 'set' | 'zset'
type KeyView = StringEncoding | 'bit'
type KeyDraft = {
  name: string
  detail?: Record<string, unknown>
  value: string
  view: KeyView
  pageCursor: string
  offset: number
  dirty: boolean
}

function bytes(text: string): number {
  return new TextEncoder().encode(text).length
}
function blankDraft(name: string): KeyDraft {
  return { name, value: '', view: 'text', pageCursor: '0', offset: 0, dirty: false }
}
function flagText(payload: Record<string, unknown> | undefined): string {
  const encoded = payload?.result as { result?: { value?: string } } | undefined
  return String(encoded?.result?.value ?? '')
}

function RedisKeyBranch({ folder, depth, active, onOpen }: { folder: KeyFolder; depth: number; active?: string; onOpen(name: string): void }): React.ReactElement {
  const icon = <Folder size={12} className="db-search-tree-icon" />
  const keyIcon = <KeyRound size={12} className="db-search-tree-icon" />
  if (!folder.children.length && folder.key) {
    return <SearchTreeNode text={folder.label} title={folder.key} depth={depth} selected={active === folder.key} icon={keyIcon} onSelect={() => onOpen(folder.key!)} />
  }
  return <SearchTreeNode folder defaultOpen text={folder.label} depth={depth} icon={icon}>
    {folder.key && <SearchTreeNode text={folder.label} title={folder.key} depth={depth + 1} selected={active === folder.key} icon={keyIcon} onSelect={() => onOpen(folder.key!)} />}
    {folder.children.map(child => <RedisKeyBranch key={child.path} folder={child} depth={depth + 1} active={active} onOpen={onOpen} />)}
  </SearchTreeNode>
}

export function RedisOverview({ bridge, connection, refreshToken = 0, database = '', onKeys, onKeyChange }: {
  bridge: WorkspaceBridge; connection: Connection; refreshToken?: number; database?: string
  onKeys?(names: readonly string[]): void
  onKeyChange?(change: { operation: 'add' | 'remove' | 'rename'; name: string; next?: string }): void
}): React.ReactElement {
  const [pattern, setPattern] = useState('')
  const [created, setCreated] = useState<string[]>([])
  const [removed, setRemoved] = useState<ReadonlySet<string>>(new Set())
  const [started, setStarted] = useState(false)
  const [selected, setSelected] = useState<string>()
  const [draft, setDraft] = useState<KeyDraft>()
  const [writing, setWriting] = useState(false)
  const [detailError, setDetailError] = useState('')
  const [creating, setCreating] = useState(false)
  const [createError, setCreateError] = useState('')
  const [newName, setNewName] = useState('')
  const [newType, setNewType] = useState<KeyKind>('string')
  const [newField, setNewField] = useState('')
  const [newScore, setNewScore] = useState('0')
  const [newValue, setNewValue] = useState('')
  const [treeWidth, setTreeWidth] = useState(220)
  const [drawerOpen, setDrawerOpen] = useState(false)
  const patternRef = useRef(pattern)
  const patternTimer = useRef<ReturnType<typeof setTimeout> | undefined>(undefined)
  const patternReady = useRef(false)
  const scanMode = useRef<'page' | 'all'>('page')
  const scanToken = useRef(0)
  const readAbort = useRef<AbortController | null>(null)
  const readToken = useRef(0)
  const shownKey = useRef('')
  const databaseRef = useRef(database)
  databaseRef.current = database
  const pageRef = useRef({ cursor: '0', offset: 0, bits: false })
  const writingRef = useRef(false)
  const createDialog = useRef<HTMLDivElement>(null)
  patternRef.current = pattern
  useDialog(createDialog, () => { if (!writing) setCreating(false) }, creating)
  const startTreeResize = useDragResize((start, next) => {
    setTreeWidth(Math.min(480, Math.max(160, treeWidth + (next.clientX - start.clientX))))
  })
  const loadKeys = async (cursor: string | undefined, signal: AbortSignal) => {
    if (!databaseRef.current) return { items: [], nextCursor: undefined }
    if (!bridge.explorer) throw new Error('Redis 对象读取通道不可用。')
    const all = scanMode.current === 'all'
    scanMode.current = 'page'
    const match = redisScanMatch(patternRef.current)
    let next = cursor ?? '0'
    const items: string[] = []
    for (let page = 0; page < (all ? SCAN_ALL_PAGES : 1); page++) {
      if (signal.aborted) throw new DOMException('The operation was aborted.', 'AbortError')
      const result = await bridge.explorer(connection, 'list', { cursor: next, search: match, database: databaseRef.current }, signal)
      items.push(...result.nodes.map(node => node.title).filter(name => redisKeyMatches(name, patternRef.current)))
      next = result.nextCursor || '0'
      if (next === '0') break
    }
    if (!signal.aborted) onKeys?.(items)
    return { items, nextCursor: next === '0' ? undefined : next }
  }
  const paged = usePagedList(loadKeys)
  const redisKey = async (input: Record<string, unknown>, signal?: AbortSignal) => {
    if (!bridge.redis || !connection.live) throw new Error('请先连接 Redis。')
    return bridge.redis(connection, 'redis-key', { ...input, database: databaseRef.current }, signal) as unknown as Record<string, unknown>
  }
  const fresh = async () => {
    if (patternTimer.current) clearTimeout(patternTimer.current)
    const token = ++scanToken.current
    setCreated([])
    setRemoved(new Set())
    scanMode.current = 'page'
    const ok = await paged.replace()
    if (ok && token === scanToken.current) setStarted(true)
  }
  const more = async (all: boolean) => {
    const token = ++scanToken.current
    scanMode.current = all ? 'all' : 'page'
    const ok = started && paged.nextCursor ? await paged.append() : await paged.replace()
    if (ok && token === scanToken.current) setStarted(true)
  }

  useEffect(() => {
    const token = ++scanToken.current
    setStarted(false)
    setCreated([])
    setRemoved(new Set())
    setSelected(undefined)
    setDraft(undefined)
    shownKey.current = ''
    setDetailError('')
    setCreating(false)
    paged.reset()
    if (!connection.live || !database) return () => { scanToken.current += 1; paged.reset(); readAbort.current?.abort() }
    void paged.replace().then(ok => { if (ok && token === scanToken.current) setStarted(true) })
    return () => { scanToken.current += 1; paged.reset(); readAbort.current?.abort(); readToken.current += 1 }
  }, [connection.id, connection.generation, connection.live, refreshToken, database])

  useEffect(() => {
    if (!patternReady.current) { patternReady.current = true; return }
    if (!connection.live || !database) return
    if (patternTimer.current) clearTimeout(patternTimer.current)
    patternTimer.current = setTimeout(() => { void fresh() }, 300)
    return () => { if (patternTimer.current) clearTimeout(patternTimer.current) }
  }, [pattern])

  const read = async (name: string, nextCursor = '0', nextOffset = 0, mode: { bits?: boolean } = {}) => {
    if (!bridge.redis || !connection.live) { setDetailError('请先连接 Redis。'); return }
    readAbort.current?.abort()
    const controller = new AbortController()
    readAbort.current = controller
    const token = ++readToken.current
    pageRef.current = { cursor: nextCursor, offset: nextOffset, bits: !!mode.bits }
    setDetailError('')
    try {
      const result = await redisKey({ key: name, operation: 'read', cursor: nextCursor, offset: nextOffset, ...(mode.bits ? { bits: true } : {}) }, controller.signal)
      if (token !== readToken.current || controller.signal.aborted || shownKey.current !== name) return
      const loaded = stringFromDetail(result)
      setDraft(current => {
        if (!current || shownKey.current !== name) return current
        const keyName = String(result.keyType || '')
        const view = keyName === 'bitmap' ? 'bit' : current.view === 'bit' && keyName === 'string' ? 'text' : current.view
        return {
          ...current, detail: result, dirty: false, view,
          value: view === 'json' ? formatValue(loaded.text, 'json') : loaded.text,
          pageCursor: typeof result.cursor === 'string' ? result.cursor : '0',
          offset: Number(result.offset) || nextOffset,
        }
      })
    } catch (caught) {
      if (token === readToken.current && !controller.signal.aborted) setDetailError(caught instanceof Error ? caught.message : '读取 Key 失败。')
    }
  }
  const openKey = (name: string) => {
    if (writingRef.current) return
    setDrawerOpen(false)
    shownKey.current = name
    setSelected(name)
    setDraft(blankDraft(name))
    void read(name)
  }
  const edit = async (name: string, operation: string, extra: Record<string, unknown> = {}) => {
    if (writingRef.current || !name) return { ok: false as const }
    writingRef.current = true
    setWriting(true)
    setDetailError('')
    try {
      if (operation === 'rename') {
        const next = String(extra.value || '').trim()
        if (!next || next === name) return { ok: true as const }
        await redisKey({ key: name, operation: 'rename', value: next })
        shownKey.current = next
        setRemoved(previous => new Set(previous).add(name))
        setCreated(previous => [...previous.filter(key => key !== name && key !== next), next])
        onKeyChange?.({ operation: 'rename', name, next })
        setSelected(next)
        setDraft(blankDraft(next))
        await read(next)
        return { ok: true as const }
      }
      const written = await redisKey({ key: name, operation, ...extra })
      if (operation === 'delete') {
        setRemoved(previous => new Set(previous).add(name))
        setCreated(previous => previous.filter(key => key !== name))
        onKeyChange?.({ operation: 'remove', name })
        if (shownKey.current === name) { shownKey.current = ''; setSelected(undefined); setDraft(undefined) }
        return { ok: true as const, result: written }
      }
      if (operation !== 'bfexists') {
        const page = pageRef.current
        await read(name, page.cursor, page.offset, { bits: page.bits })
      }
      return { ok: true as const, result: written }
    } catch (caught) {
      setDetailError(caught instanceof Error ? caught.message : '编辑失败，执行结果可能未知，请核验。')
      return { ok: false as const }
    } finally { writingRef.current = false; setWriting(false) }
  }
  const createKey = async () => {
    if (writingRef.current) return
    const name = newName.trim()
    if (!name) { setCreateError('请填写 Key。'); return }
    if (newType === 'hash' && !newField.trim()) { setCreateError('请填写字段。'); return }
    if (newType !== 'string' && !newValue) { setCreateError('请填写初始值。'); return }
    writingRef.current = true
    setWriting(true)
    setCreateError('')
    setDetailError('')
    try {
      const operation = { string: 'set', hash: 'hset', list: 'lpush', set: 'sadd', zset: 'zadd' }[newType]
      await redisKey({ key: name, operation, value: newValue, field: newField.trim(), score: Number(newScore) })
      setRemoved(previous => { const next = new Set(previous); next.delete(name); return next })
      setCreated(previous => previous.includes(name) ? previous : [...previous, name])
      onKeyChange?.({ operation: 'add', name })
      shownKey.current = name
      setSelected(name)
      setDraft(blankDraft(name))
      setCreating(false)
      await read(name)
    } catch (caught) { setCreateError(caught instanceof Error ? caught.message : '新建 Key 失败，执行结果可能未知，请核验。') }
    finally { writingRef.current = false; setWriting(false) }
  }
  const copyText = async (text: string) => {
    try { await navigator.clipboard.writeText(text) }
    catch { setDetailError('复制失败，请选中文字复制') }
  }
  const names = [...new Set([...paged.items, ...created].filter(name => !removed.has(name) && redisKeyMatches(name, pattern)))]
  const tree = buildKeyTree(names)
  const keyType = String(draft?.detail?.keyType || '')
  const kind = draft?.detail ? viewKind(keyType, draft.view) : undefined
  const rows = useMemo(() => draft?.detail ? detailRows(draft.detail) : [], [draft?.detail])
  const card = useMemo(() => draft?.detail ? detailCard(draft.detail) : undefined, [draft?.detail])
  const loaded = draft?.detail ? stringFromDetail(draft.detail) : { text: '' }
  const reported = draft?.detail?.value && typeof draft.detail.value === 'object' && draft.detail.value !== null && 'result' in draft.detail.value && typeof (draft.detail.value as { result?: { length?: number } }).result?.length === 'number'
    ? (draft.detail.value as { result: { length: number } }).result.length : undefined
  const size = draft?.dirty ? bytes(draft.value) : (loaded.binary?.length ?? reported ?? bytes(draft?.value || ''))
  const encoding: StringEncoding = draft?.view === 'json' || draft?.view === 'hex' || draft?.view === 'binary' ? draft.view : 'text'
  const live = connection.live === true
  const operable = !!draft?.detail && keyType !== 'none' && live && !writing
  const scanDone = started && !paged.nextCursor
  const ttl = typeof draft?.detail?.ttl === 'number' ? draft.detail.ttl : undefined
  const encoded = draft?.detail?.value as { result?: { type?: string }; truncated?: boolean } | undefined
  const saveString = () => {
    if (!draft) return
    const reason = rejectStringSave(encoding, draft.value)
    if (reason) { setDetailError(reason); return }
    void edit(draft.name, keyType === 'json' ? 'jsonset' : 'set', { value: draft.value })
  }
  const fieldTtl = (values: Record<string, string>, previous?: string) => {
    if (!values.ttl || values.ttl === '-1' || values.ttl === previous) return undefined
    const seconds = Number(values.ttl)
    if (!Number.isInteger(seconds) || seconds < 1) { setDetailError('TTL 秒数无效。'); return false as const }
    return seconds
  }
  const saveCreate = (items: Record<string, string>[]) => {
    if (!draft || items.some(item => !rowSubmittable(keyType, item))) return
    const values = items[0]
    if (keyType === 'hash') {
      const seconds = fieldTtl(values)
      if (seconds === false) return
      void edit(draft.name, 'hset', { field: values.field, value: values.value ?? '', ...(seconds ? { seconds } : {}) })
    } else if (keyType === 'list') void edit(draft.name, 'lpush', { value: values.value })
    else if (keyType === 'set') void edit(draft.name, 'sadd', { value: values.member })
    else if (keyType === 'zset') void edit(draft.name, 'zadd', { value: values.member, score: Number(values.score) })
    else if (keyType === 'geo') void edit(draft.name, 'geoadd', { value: values.member, lon: values.lon, lat: values.lat })
    else if (keyType === 'timeseries') void edit(draft.name, 'tsadd', { value: values.value, timestamp: values.time })
  }
  const saveEdit = (row: KeyRow, values: Record<string, string>) => {
    if (!draft || !rowSubmittable(keyType, values)) return
    if (keyType === 'hash') {
      const seconds = fieldTtl(values, row.cells.ttl)
      if (seconds === false) return
      void edit(draft.name, 'hset', { field: values.field, value: values.value ?? '', ...(row.cells.field !== values.field ? { previous: row.cells.field } : {}), ...(seconds ? { seconds } : {}) })
    } else if (keyType === 'list') void edit(draft.name, 'lset', { index: Number(row.cells.index), value: values.value })
    else if (keyType === 'set') void edit(draft.name, 'sadd', { value: values.member, ...(row.cells.member !== values.member ? { previous: row.cells.member } : {}) })
    else if (keyType === 'zset') void edit(draft.name, 'zadd', { value: values.member, score: Number(values.score), ...(row.cells.member !== values.member ? { previous: row.cells.member } : {}) })
    else if (keyType === 'geo') void edit(draft.name, 'geoadd', { value: values.member, lon: values.lon, lat: values.lat, ...(row.cells.member !== values.member ? { previous: row.cells.member } : {}) })
  }
  const deleteRow = (row: KeyRow) => {
    if (!draft) return
    if (keyType === 'hash') void edit(draft.name, 'hdel', { field: row.cells.field })
    else if (keyType === 'list') void edit(draft.name, 'lrem', { value: row.cells.value })
    else if (keyType === 'set') void edit(draft.name, 'srem', { value: row.cells.member })
    else if (keyType === 'zset' || keyType === 'geo') void edit(draft.name, 'zrem', { value: row.cells.member })
    else if (keyType === 'stream') void edit(draft.name, 'xdel', { id: row.cells.id || row.id })
  }
  const loadPage = () => {
    if (!draft?.detail) return
    const page = nextPage(keyType, String(draft.detail.cursor || draft.pageCursor || '0'), Number(draft.detail.offset ?? draft.offset) || 0)
    void read(draft.name, page.cursor, page.offset, { bits: keyType === 'bitmap' || draft.view === 'bit' })
  }
  const keyIcon = <KeyRound size={12} className="db-search-tree-icon" />

  return <>
    <SearchTreeSplit open={drawerOpen} onOpenChange={setDrawerOpen} openLabel="打开 Key 列表" toggle={<><KeyRound size={13} />Key</>}
      tree={<SearchTree label="搜索 Key" searchPlaceholder="搜索 Key" resetSearchValue="" refreshLabel="重新扫描" title={database ? `db${database}${started ? ` · ${names.length}${paged.nextCursor ? ' · 未扫完' : ''}` : ''}` : '数据库'}
        width={treeWidth} onResize={startTreeResize} search={pattern} onSearch={setPattern} onSubmitSearch={() => void fresh()} onRefresh={() => void fresh()}
        busy={paged.loading} disabled={!connection.live || !database} error={paged.error}
        action={<><button className="db-search-tree-close db-icon-button" type="button" aria-label="关闭 Key 列表" onClick={() => setDrawerOpen(false)}><X size={13} /></button><button className="db-redis-btn" type="button" disabled={!connection.live || !database || writing} onClick={() => { setCreateError(''); setNewName(''); setNewType('string'); setNewField(''); setNewScore('0'); setNewValue(''); setCreating(true) }}><Plus size={13} />新建 Key</button></>}
        empty={<p className="db-muted">{!database ? '在左侧选择数据库。' : (paged.loading || !started ? '正在扫描 Key…' : '没有匹配的 Key。')}</p>}
        footer={<><button className="db-redis-btn" type="button" disabled={paged.loading || !connection.live || !database || scanDone} title="SCAN 可能返回空页或重复 Key。" onClick={() => void more(false)}>加载更多</button>
          <button className="db-redis-btn" type="button" disabled={paged.loading || !connection.live || !database || scanDone} title="连续 SCAN 直到本轮结束或达到上限。" onClick={() => void more(true)}>加载全部</button></>}>
        {names.length ? <>
          {tree.folders.map(folder => <RedisKeyBranch key={folder.path} folder={folder} depth={0} active={selected} onOpen={openKey} />)}
          {tree.leaves.map(name => <SearchTreeNode key={name} text={name} title={name} selected={selected === name} icon={keyIcon} onSelect={() => openKey(name)} />)}
        </> : null}
      </SearchTree>}
      detail={<div className="db-redis-key-detail">
        {detailError && <p className="db-error" role="alert">{detailError}</p>}
        {draft && <RedisKeyToolbar key={draft.name} name={draft.name} keyType={draft.detail ? keyType : ''} ttl={ttl} operable={operable} canRefresh={live && !writing}
          onRename={async next => (await edit(draft.name, 'rename', { value: next })).ok}
          onExpire={seconds => { void edit(draft.name, 'expire', { seconds }) }}
          onPersist={() => { void edit(draft.name, 'persist') }}
          onDelete={() => { void edit(draft.name, 'delete') }}
          onRefresh={() => { void read(draft.name, '0', 0, { bits: draft.view === 'bit' }) }}
          onCopy={() => { void copyText(draft.name) }}
          onTtlError={setDetailError} />}
        {draft && <div className="db-redis-key-body">
          {!draft.detail && !detailError && <p className="db-muted db-redis-empty">正在读取 Key…</p>}
          {keyType === 'none' && <p className="db-muted db-redis-empty">该 Key 不存在。</p>}
          {kind === 'string' && <RedisKeyString encoding={encoding} value={draft.value} dirty={draft.dirty} binary={loaded.binary} size={size} busy={writing} readOnly={!!loaded.binary}
            onEncoding={next => setDraft(current => current ? { ...current, view: next, value: next === 'json' ? formatValue(current.value, 'json') : current.value } : current)}
            onBit={() => { setDraft(current => current ? { ...current, view: 'bit' } : current); void read(draft.name, '0', 0, { bits: true }) }}
            onChange={value => setDraft(current => current ? { ...current, value, dirty: true } : current)}
            onSave={saveString} onCopy={text => { void copyText(text) }} />}
          {kind === 'table' && <RedisKeyTable name={draft.name} kind={keyType} columns={tableColumns(keyType)} rows={rows} more={draft.detail?.more === true} revision={draft.detail} writing={writing}
            scoreSort={keyType === 'zset'} timeFilter={keyType === 'timeseries'} allowEdit={keyType !== 'timeseries'} allowDelete={keyType !== 'timeseries'}
            createFields={tableColumns(keyType)} onCreate={saveCreate} onEdit={saveEdit} onDelete={deleteRow} onCopy={text => { void copyText(text) }} />}
          {kind === 'stream' && <RedisKeyStream name={draft.name} rows={rows} more={draft.detail?.more === true} revision={draft.detail} writing={writing}
            onCreate={items => { if (items.some(item => !rowSubmittable('stream', item))) return; void edit(draft.name, 'xadd', { entries: items.flatMap(item => [item.field ?? '', item.value ?? '']) }) }}
            onDelete={deleteRow} onCopy={text => { void copyText(text) }} />}
          {kind === 'bitmap' && <RedisKeyBitmap name={draft.name} rows={rows} more={draft.detail?.more === true} revision={draft.detail} writing={writing}
            onCreate={values => { if (!rowSubmittable('bitmap', values)) return; void edit(draft.name, 'setbit', { offset: Number(values.offset), value: values.bit }) }}
            onToggle={row => { void edit(draft.name, 'setbit', { offset: Number(row.cells.offset), value: row.cells.bit === '1' ? '0' : '1' }) }}
            onText={() => { setDraft(current => current ? { ...current, view: 'text' } : current); void read(draft.name, '0', 0) }}
            onCopy={text => { void copyText(text) }} />}
          {kind === 'card' && (keyType === 'hyperloglog' || keyType === 'bloom') && <RedisKeyCard kind={keyType} card={card} writing={writing}
            onAdd={value => { if (!value) return; void edit(draft.name, keyType === 'hyperloglog' ? 'pfadd' : 'bfadd', { value }) }}
            onExists={async value => {
              const done = await edit(draft.name, 'bfexists', { value })
              if (!done.ok) return undefined
              return flagText('result' in done ? done.result : undefined) === '1' ? '存在' : '不存在'
            }} />}
          {kind === 'raw' && <div className="db-redis-value"><div className="db-redis-reply-body"><Value data={encoded?.result as RedisValue | undefined} />{encoded?.truncated && <p className="db-muted">值已截断。</p>}</div><p className="db-muted">此类型没有专用编辑区，可在命令台操作。</p></div>}
          {draft.detail?.more === true && (kind === 'table' || kind === 'stream' || kind === 'bitmap') && <div className="db-redis-value-more"><button className="db-redis-btn" type="button" disabled={writing} onClick={loadPage}>加载更多</button></div>}
        </div>}
        {!draft && <p className="db-muted db-redis-empty">{!database ? '在左侧选择数据库后显示 Key。' : (started ? '选择 Key 查看类型、TTL 和内容。' : '正在扫描 Key…')}</p>}
      </div>} />
    {creating && <div className="db-overlay db-modal"><div ref={createDialog} className="db-dialog" role="dialog" aria-modal="true" aria-label="新建 Key">
      <div className="db-dialog-heading"><h2>新建 Key</h2></div>
      {createError && <p className="db-error" role="alert">{createError}</p>}
      <label className="db-form-label">Key<input value={newName} onChange={event => setNewName(event.target.value)} /></label>
      <label className="db-form-label">类型<select value={newType} onChange={event => setNewType(event.target.value as KeyKind)}><option value="string">String</option><option value="hash">Hash</option><option value="list">List</option><option value="set">Set</option><option value="zset">ZSet</option></select></label>
      {newType === 'hash' && <label className="db-form-label">字段<input value={newField} onChange={event => setNewField(event.target.value)} /></label>}
      {newType === 'zset' && <label className="db-form-label">分数<input value={newScore} onChange={event => setNewScore(event.target.value)} /></label>}
      <label className="db-form-label">初始值<textarea className="db-redis-create-value" value={newValue} onChange={event => setNewValue(event.target.value)} /></label>
      <div className="db-dialog-footer">
        <button type="button" disabled={writing} onClick={() => setCreating(false)}>取消</button>
        <button type="button" className="db-primary" disabled={writing || !connection.live} onClick={() => void createKey()}>{writing ? '正在创建…' : '创建'}</button>
      </div>
    </div></div>}
  </>
}

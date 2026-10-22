import React, { useMemo, useRef, useState } from 'react'
import { createPortal } from 'react-dom'
import type { Connection, WorkspaceBridge } from '../../shared/workbench.ts'
import { DialogFrame } from '../workspace/parts/overlay/dialog-frame.tsx'
import { FormField } from '../workspace/parts/controls/form-field.tsx'
import { SearchSelect, type SearchSelectFieldProps } from '../workspace/parts/controls/search-select.tsx'
import { KafkaNameInput, useKafkaPartitions } from './builder-candidates.tsx'
import { byteDraft, generateKafkaCommand, kafkaBuilderOperations, messageDraft, newBuilderDraft, partitionDraft, type BuilderDraft, type BuilderErrors, type BuilderKind, type ByteDraft, type MessageDraft } from './builder-model.ts'
import type { KafkaNames } from './completion.ts'
import { isKafkaWrite } from '../../shared/kafka-command.mjs'

function Field({ label, path, errors, help, children }: { label: string; path: string; errors: BuilderErrors; help?: string; children: React.ReactElement }) {
  return <div data-builder-field={path}><FormField label={label} error={errors[path]} help={help}>{children}</FormField></div>
}
function BytesFields({ label, path, value, onChange, errors }: { label: string; path: string; value: ByteDraft; onChange(value: ByteDraft): void; errors: BuilderErrors }) {
  return <div className="db-kafka-byte-fields">
    <Field label={`${label}格式`} path={`${path}.encoding`} errors={errors}><select aria-label={`${label}格式`} value={value.encoding} onChange={event => onChange({ ...value, encoding: event.target.value as ByteDraft['encoding'] })}><option value="utf8">文本 · UTF-8</option><option value="base64">二进制 · Base64</option></select></Field>
    <Field label={label} path={path} errors={errors}><textarea aria-label={label} rows={3} value={value.value} onChange={event => onChange({ ...value, value: event.target.value })} /></Field>
  </div>
}
function Toggle({ label, checked, onChange }: { label: string; checked: boolean; onChange(value: boolean): void }) {
  return <label className="db-kafka-builder-toggle"><input type="checkbox" checked={checked} onChange={event => onChange(event.target.checked)} />{label}</label>
}
function PartitionInput({ value, onChange, candidates, label, ...inputProps }: { value: string; onChange(value: string): void; candidates: number[]; label: string } & SearchSelectFieldProps) {
  return <SearchSelect {...inputProps} value={value} onPick={onChange} options={candidates.map(String)} allowCustom placeholder="选择或输入分区编号" ariaLabel={label} />
}
function MessageFields({ value, onChange, path, errors, partitions, tombstone = false, title }: { value: MessageDraft; onChange(value: MessageDraft): void; path: string; errors: BuilderErrors; partitions: number[]; tombstone?: boolean; title: string }) {
  const patch = (next: Partial<MessageDraft>) => onChange({ ...value, ...next })
  const headers = value.headers
  return <div className="db-kafka-message-fields">
    {tombstone ? <BytesFields label={`${title}Key`} path={`${path}.key`} value={value.key} onChange={key => patch({ key })} errors={errors} />
      : <BytesFields label={`${title}Value`} path={`${path}.value`} value={value.value} onChange={next => patch({ value: next })} errors={errors} />}
    <details className="db-resource-disclosure db-kafka-builder-advanced"><summary>高级参数{title ? ` · ${title}` : ''}</summary><div className="db-kafka-builder-stack">
      {!tombstone && <><Toggle label="提供 Key（允许空文本）" checked={value.keyEnabled} onChange={keyEnabled => patch({ keyEnabled })} />{value.keyEnabled && <BytesFields label={`${title}Key`} path={`${path}.key`} value={value.key} onChange={key => patch({ key })} errors={errors} />}</>}
      <Toggle label="指定分区" checked={value.partitionEnabled} onChange={partitionEnabled => patch({ partitionEnabled })} />
      {value.partitionEnabled && <Field label={`${title}分区`} path={`${path}.partition`} errors={errors}><PartitionInput label={`${title}分区`} value={value.partition} onChange={partition => patch({ partition })} candidates={partitions} /></Field>}
      <Toggle label="提供 Headers" checked={value.headersEnabled} onChange={headersEnabled => patch({ headersEnabled })} />
      {value.headersEnabled && <div data-builder-field={`${path}.headers`} className="db-kafka-builder-stack">
        <p className="db-muted">同名 Header 自动合并为多个值；最多 16 个名称，每个名称最多 8 个值。</p>
        {errors[`${path}.headers`] && <p className="db-error">{errors[`${path}.headers`]}</p>}
        {headers.map((header, index) => <fieldset className="db-kafka-builder-card" key={index}><legend>Header {index + 1}</legend>
          <Field label="Header 名称" path={`${path}.headers.${index}.name`} errors={errors}><input aria-label={`Header ${index + 1} 名称`} value={header.name} onChange={event => patch({ headers: headers.map((item, at) => at === index ? { ...item, name: event.target.value } : item) })} /></Field>
          <BytesFields label={`Header ${index + 1} 值`} path={`${path}.headers.${index}.value`} value={header.bytes} onChange={bytes => patch({ headers: headers.map((item, at) => at === index ? { ...item, bytes } : item) })} errors={errors} />
          <button type="button" onClick={() => patch({ headers: headers.filter((_, at) => at !== index) })}>移除此 Header 值</button>
        </fieldset>)}
        <button type="button" onClick={() => patch({ headers: [...headers, { name: '', bytes: byteDraft() }] })}>添加 Header 值</button>
      </div>}
      {!tombstone && <><Toggle label="记录重放来源" checked={value.replayEnabled} onChange={replayEnabled => patch({ replayEnabled })} />{value.replayEnabled && <div className="db-kafka-builder-grid">
        <Field label="来源 Topic" path={`${path}.replayTopic`} errors={errors}><input aria-label={`${title}来源 Topic`} value={value.replayTopic} onChange={event => patch({ replayTopic: event.target.value })} /></Field>
        <Field label="来源分区" path={`${path}.replayPartition`} errors={errors}><input aria-label={`${title}来源分区`} inputMode="numeric" value={value.replayPartition} onChange={event => patch({ replayPartition: event.target.value })} /></Field>
        <Field label="来源 Offset" path={`${path}.replayOffset`} errors={errors}><input aria-label={`${title}来源 Offset`} inputMode="numeric" value={value.replayOffset} onChange={event => patch({ replayOffset: event.target.value })} /></Field>
      </div>}</>}
    </div></details>
  </div>
}

/** Only this selected form is mounted; candidate requests cannot leak across operations. */
function OperationForm({ kind, draft, onChange, errors, bridge, connection, names }: { kind: BuilderKind; draft: BuilderDraft; onChange(value: BuilderDraft): void; errors: BuilderErrors; bridge: WorkspaceBridge; connection: Connection; names: KafkaNames }) {
  const patch = (next: Partial<BuilderDraft>) => onChange({ ...draft, ...next })
  const draftRef = useRef(draft); draftRef.current = draft
  const lookup = useRef<AbortController | null>(null)
  const [offsetLoading, setOffsetLoading] = useState(false), [offsetError, setOffsetError] = useState('')
  React.useEffect(() => () => lookup.current?.abort(), [])
  React.useEffect(() => { lookup.current?.abort(); setOffsetLoading(false); setOffsetError('') }, [draft.topic, draft.groupId])
  const partitionFields = ['peek', 'scan', 'set-group-offsets'].includes(kind)
    || (kind === 'produce' || kind === 'tombstone') && draft.message.partitionEnabled
    || kind === 'produce-batch' && draft.messages.some(item => item.partitionEnabled)
  const partitions = useKafkaPartitions(bridge, connection, draft.topic, partitionFields)
  const needsTopic = !['topics', 'groups', 'group', 'group-topics'].includes(kind)
  const needsGroup = ['group', 'group-topics', 'group-topic', 'set-group-offsets'].includes(kind)
  const timeField = <Field label="日期时间" path="time" errors={errors} help={`时区：${Intl.DateTimeFormat().resolvedOptions().timeZone}，自动转换为毫秒时间戳。`}><input aria-label="日期时间" type="datetime-local" step="0.001" value={draft.time} onChange={event => patch({ time: event.target.value })} /></Field>
  const loadOffsets = async () => {
    lookup.current?.abort()
    const controller = new AbortController(); lookup.current = controller
    const topic = draft.topic, groupId = draft.groupId
    setOffsetLoading(true); setOffsetError('')
    try {
      if (!bridge.explorer || !connection.live) throw new Error('当前位点读取不可用，请手工填写。')
      const result = await bridge.explorer(connection, 'read', { ref: `gtopic:${encodeURIComponent(groupId)}:${encodeURIComponent(topic)}`, refresh: true }, controller.signal) as { partitions?: { partition: number; current?: string | null; status?: string }[] }
      if (controller.signal.aborted) return
      const latest = draftRef.current
      if (latest.topic !== topic || latest.groupId !== groupId) return
      const rows = latest.partitions.map(row => {
        const found = result.partitions?.find(item => String(item.partition) === row.partition)
        if (!found || found.status === 'unreadable' || found.current === undefined || found.current === null && found.status !== 'uncommitted') throw new Error(`分区 ${row.partition} 的旧位置未知，请核验后手填；未填入任何读取值。`)
        return { ...row, expected: found.current ?? '', uncommitted: found.current === null }
      })
      onChange({ ...latest, partitions: rows })
    } catch (caught) { if (!controller.signal.aborted) setOffsetError(caught instanceof Error ? caught.message : '读取失败。') }
    finally { if (!controller.signal.aborted) setOffsetLoading(false) }
  }
  return <div className="db-kafka-builder-stack">
    {needsGroup && <Field label="消费组" path="groupId" errors={errors}><KafkaNameInput bridge={bridge} connection={connection} category="groups" value={draft.groupId} onChange={groupId => patch({ groupId })} names={names.groups} label="消费组" /></Field>}
    {needsTopic && <Field label={kind === 'create-topic' ? '测试 Topic 名称' : 'Topic'} path="topic" errors={errors} help={kind === 'create-topic' ? '名称必须以 dsh-test- 开头。' : undefined}>{kind === 'create-topic'
      ? <input aria-label="测试 Topic 名称" value={draft.topic} onChange={event => patch({ topic: event.target.value })} />
      : <KafkaNameInput bridge={bridge} connection={connection} category="topics" value={draft.topic} onChange={topic => patch({ topic })} names={names.topics} label="Topic" />}</Field>}
    {partitionFields && (partitions.loading || partitions.error) && <p className="db-muted" role="status">{partitions.loading ? '正在读取分区候选…' : <>{partitions.error} <button type="button" onClick={partitions.retry}>重试分区读取</button></>}</p>}
    {['topics', 'groups'].includes(kind) && <Field label="名称片段（可选）" path="search" errors={errors}><input aria-label="名称片段" value={draft.search} onChange={event => patch({ search: event.target.value })} /></Field>}
    {['topics', 'groups', 'topic-groups', 'group-topics'].includes(kind) && <details className="db-resource-disclosure"><summary>高级参数</summary><Field label="分页游标（可选）" path="cursor" errors={errors} help="填写上一页结果提供的 nextCursor；留空读取第一页。"><input aria-label="分页游标" inputMode="numeric" value={draft.cursor} onChange={event => patch({ cursor: event.target.value })} /></Field></details>}
    {kind === 'peek' && <>
      <div className="db-kafka-builder-grid"><Field label="分区" path="partition" errors={errors}><PartitionInput label="分区" value={draft.partition} onChange={partition => patch({ partition })} candidates={partitions.items} /></Field>
        <Field label="读取起点" path="from" errors={errors}><select aria-label="读取起点" value={draft.from} onChange={event => patch({ from: event.target.value as BuilderDraft['from'] })}><option value="latest">最近的消息</option><option value="beginning">当前最早位置</option><option value="offset">指定 Offset</option></select></Field>
        <Field label="最多读取条数" path="limit" errors={errors}><input aria-label="最多读取条数" inputMode="numeric" value={draft.limit} onChange={event => patch({ limit: event.target.value })} /></Field>
      </div>
      {draft.from === 'offset' && <Field label="起始 Offset" path="offset" errors={errors}><input aria-label="起始 Offset" inputMode="numeric" value={draft.offset} onChange={event => patch({ offset: event.target.value })} /></Field>}
      <p className="db-muted">最多 200 条；有界读取，不提交业务消费位点。</p>
    </>}
    {kind === 'time-offsets' && timeField}
    {(kind === 'scan' || kind === 'set-group-offsets') && <>
      <Field label={kind === 'scan' ? '扫描起点' : '目标位置类型'} path="targetMode" errors={errors}><select aria-label="位置类型" value={draft.targetMode} onChange={event => patch({ targetMode: event.target.value as BuilderDraft['targetMode'] })}><option value="time">指定日期时间</option><option value="offset">逐分区指定 Offset</option></select></Field>
      {draft.targetMode === 'time' && timeField}
      <div className="db-kafka-builder-stack" data-builder-field="partitions">
        <p className="db-muted">添加 1～8 个不同分区。{kind === 'set-group-offsets' && '仅无运行成员的消费组可执行；旧位置将在执行前再次比对。'}</p>
        {errors.partitions && <p className="db-error">{errors.partitions}</p>}
        {draft.partitions.map((row, index) => {
          const edit = (next: Partial<typeof row>) => patch({ partitions: draft.partitions.map((item, at) => at === index ? { ...item, ...next } : item) })
          return <fieldset className="db-kafka-builder-card" key={index}><legend>分区设置 {index + 1}</legend><div className="db-kafka-builder-grid">
            <Field label="分区" path={`partitions.${index}.partition`} errors={errors}><PartitionInput label={`分区 ${index + 1} 编号`} value={row.partition} onChange={partition => edit({ partition })} candidates={partitions.items} /></Field>
            {draft.targetMode === 'offset' && <Field label="目标 Offset" path={`partitions.${index}.offset`} errors={errors}><input aria-label={`分区 ${index + 1} 目标 Offset`} inputMode="numeric" value={row.offset} onChange={event => edit({ offset: event.target.value })} /></Field>}
            {kind === 'set-group-offsets' && <div><Toggle label="预期当前尚未提交" checked={row.uncommitted} onChange={uncommitted => edit({ uncommitted })} />{!row.uncommitted && <Field label="预期旧 Offset" path={`partitions.${index}.expected`} errors={errors}><input aria-label={`分区 ${index + 1} 预期旧 Offset`} inputMode="numeric" value={row.expected} onChange={event => edit({ expected: event.target.value })} /></Field>}</div>}
          </div><button type="button" disabled={draft.partitions.length === 1} onClick={() => patch({ partitions: draft.partitions.filter((_, at) => at !== index) })}>移除此分区</button></fieldset>
        })}
        <div className="db-kafka-builder-actions"><button type="button" disabled={draft.partitions.length >= 8} onClick={() => patch({ partitions: [...draft.partitions, { ...partitionDraft(), partition: String(Math.max(-1, ...draft.partitions.map(row => Number(row.partition) || 0)) + 1) }] })}>添加分区</button>
          {kind === 'set-group-offsets' && <button type="button" disabled={offsetLoading || !draft.topic || !draft.groupId} onClick={() => void loadOffsets()}>{offsetLoading ? '正在读取位点…' : '读取当前位点'}</button>}</div>
        {offsetError && <p className="db-error" role="status">{offsetError}</p>}
      </div>
      {kind === 'scan' && <details className="db-resource-disclosure"><summary>高级筛选</summary><div className="db-kafka-builder-stack">
        <Toggle label="匹配 Key（允许空文本）" checked={draft.keyEnabled} onChange={keyEnabled => patch({ keyEnabled })} />{draft.keyEnabled && <BytesFields label="搜索 Key" path="key" value={draft.key} onChange={key => patch({ key })} errors={errors} />}
        <Toggle label="匹配 Header" checked={draft.headerEnabled} onChange={headerEnabled => patch({ headerEnabled })} />{draft.headerEnabled && <>
          <Field label="Header 名称" path="header.name" errors={errors}><input aria-label="搜索 Header 名称" value={draft.header.name} onChange={event => patch({ header: { ...draft.header, name: event.target.value } })} /></Field>
          <BytesFields label="搜索 Header 值" path="header.value" value={draft.header.bytes} onChange={bytes => patch({ header: { ...draft.header, bytes } })} errors={errors} />
        </>}
      </div></details>}
    </>}
    {(kind === 'produce' || kind === 'tombstone') && <><MessageFields title="" path="message" value={draft.message} onChange={message => patch({ message })} errors={errors} partitions={partitions.items} tombstone={kind === 'tombstone'} />
      <p className="db-muted">{kind === 'tombstone' ? '墓碑用于 compact Topic，清理异步发生。' : 'Value 可为空文本；单条消息解码后总量最多 64 KiB。'}</p></>}
    {kind === 'produce-batch' && <div className="db-kafka-builder-stack" data-builder-field="messages">
      <p className="db-muted">1～10 条，合计最多 256 KiB；单条最多 64 KiB。</p>{errors.messages && <p className="db-error">{errors.messages}</p>}
      {draft.messages.map((item, index) => <fieldset key={index} className="db-kafka-builder-card"><legend>消息 {index + 1}</legend><MessageFields title={`消息 ${index + 1} `} path={`messages.${index}`} value={item} onChange={next => patch({ messages: draft.messages.map((previous, at) => at === index ? next : previous) })} errors={errors} partitions={partitions.items} />
        <button type="button" disabled={draft.messages.length === 1} onClick={() => patch({ messages: draft.messages.filter((_, at) => at !== index) })}>移除此消息</button>
      </fieldset>)}
      <button type="button" disabled={draft.messages.length >= 10} onClick={() => patch({ messages: [...draft.messages, messageDraft()] })}>添加消息</button>
    </div>}
    {kind === 'create-topic' && <div className="db-kafka-builder-grid">
      <Field label="分区数" path="partitionCount" errors={errors}><input aria-label="分区数" inputMode="numeric" value={draft.partitionCount} onChange={event => patch({ partitionCount: event.target.value })} /></Field>
      <Field label="复制因子" path="replicationFactor" errors={errors}><input aria-label="复制因子" inputMode="numeric" value={draft.replicationFactor} onChange={event => patch({ replicationFactor: event.target.value })} /></Field>
      <Field label="清理策略" path="cleanupPolicy" errors={errors}><select aria-label="清理策略" value={draft.cleanupPolicy} onChange={event => patch({ cleanupPolicy: event.target.value as BuilderDraft['cleanupPolicy'] })}><option value="delete">delete · 按保留策略删除</option><option value="compact">compact · 按 Key 压缩</option></select></Field>
    </div>}
  </div>
}

export function KafkaCommandBuilder({ bridge, connection, names, disabled, onGenerate }: { bridge: WorkspaceBridge; connection: Connection; names: KafkaNames; disabled: boolean; onGenerate(command: string): void }) {
  const [open, setOpen] = useState(false), [kind, setKind] = useState<BuilderKind>('peek')
  const [drafts, setDrafts] = useState<Partial<Record<BuilderKind, BuilderDraft>>>({ peek: newBuilderDraft('peek') })
  const [submitted, setSubmitted] = useState(false), [appendError, setAppendError] = useState('')
  const root = useRef<HTMLDivElement>(null)
  const trigger = useRef<HTMLButtonElement>(null)
  const draft = drafts[kind] || newBuilderDraft(kind)
  const generated = useMemo(() => generateKafkaCommand(kind, draft), [kind, draft])
  const writeDisabled = connection.environment !== 'sit' && isKafkaWrite(kind)
  const showErrors = submitted ? generated.errors : {}
  const submit = () => {
    setSubmitted(true); setAppendError('')
    if (writeDisabled) { setAppendError('Kafka 写操作仅在 SIT 开放。'); return }
    if (Object.keys(generated.errors).length) {
      const path = Object.keys(generated.errors)[0]
      const field = [...(root.current?.querySelectorAll<HTMLElement>('[data-builder-field]') || [])].find(item => item.dataset.builderField === path)
      if (field) {
        for (let parent = field.parentElement; parent; parent = parent.parentElement) if (parent instanceof HTMLDetailsElement) parent.open = true
        field.scrollIntoView({ block: 'nearest' }); field.querySelector<HTMLElement>('input,select,textarea,button')?.focus()
      }
      return
    }
    try { onGenerate(generated.command); setOpen(false) }
    catch (caught) { setAppendError(caught instanceof Error ? caught.message : '追加命令失败。') }
  }
  return <><button ref={trigger} type="button" className="db-sql-toolbar-btn" disabled={disabled} onClick={() => { setOpen(true); setSubmitted(false); setAppendError('') }}>生成命令</button>
    {open && createPortal(<DialogFrame title="生成 Kafka 命令" size="wide" className="db-kafka-builder" context={`${connection.name} · ${connection.environment.toUpperCase()} · 生成后追加到当前查询，不自动执行`} close={() => setOpen(false)} onSubmit={event => { event.preventDefault(); submit() }}
      footer={<><button type="button" onClick={() => setOpen(false)}>取消</button><button type="submit" className="db-primary" disabled={writeDisabled}>生成</button></>}>
      <div ref={root} className="db-kafka-builder-stack">
        <Field label="操作" path="kind" errors={{}}><select aria-label="Kafka 命令操作" value={kind} onChange={event => {
          const next = event.target.value as BuilderKind; setKind(next); setDrafts(previous => ({ ...previous, [next]: previous[next] || newBuilderDraft(next) })); setSubmitted(false); setAppendError('')
        }}>{['Topic', '消息', '消费组'].map(group => <optgroup key={group} label={group}>{kafkaBuilderOperations.filter(item => item.group === group).map(item => <option key={item.kind} value={item.kind} disabled={'write' in item && connection.environment !== 'sit'}>{item.label} · {item.command}{'write' in item ? '（仅 SIT）' : ''}</option>)}</optgroup>)}</select></Field>
        <OperationForm key={kind} kind={kind} draft={draft} onChange={value => setDrafts(previous => ({ ...previous, [kind]: value }))} errors={showErrors} bridge={bridge} connection={connection} names={names} />
        <div className="db-kafka-builder-preview"><strong>命令预览</strong><pre aria-label="生成命令预览">{generated.command || '填写有效参数后显示命令。'}</pre></div>
        {(showErrors.form || appendError) && <p className="db-error" role="alert">{showErrors.form || appendError}</p>}
      </div>
    </DialogFrame>, trigger.current?.closest('.db-source-workspace') || document.body)}
  </>
}

import React, { useEffect, useRef, useState } from 'react'
import { Play, Square } from 'lucide-react'
import type { ManualQueryProps } from '../workspace/source/source-workspace.tsx'
import { ExecutionWorkbench } from '../workspace/source/execution-workbench.tsx'
import { QueryResultFrame, type QueryResultPane } from '../workspace/parts/layout/query-result-frame.tsx'
import { ResourceError } from '../workspace/parts/feedback/resource-error.tsx'
import { useWorkbenchConfirm } from '../workspace/parts/overlay/confirm.tsx'
import { KafkaCommandBuilder } from './command-builder.tsx'
import { KafkaCommandEditor, type KafkaEditorApi } from './editor.tsx'
import { kafkaParameterHint, type KafkaNames } from './completion.ts'
import { createKafkaBatch, kafkaStepLabel, kafkaWriteSummary, runKafkaBatch, type KafkaStep } from '../../shared/kafka-batch.ts'

export function KafkaQueryWorkspace({ bridge, connection, value, onChange, onUse, Result, editorContext }: ManualQueryProps) {
  const editor = useRef<KafkaEditorApi | null>(null)
  const [hasSelection, setHasSelection] = useState(false), [busy, setBusy] = useState(false), [stopping, setStopping] = useState(false)
  const [steps, setSteps] = useState<KafkaStep[]>([]), [active, setActive] = useState(0), [pane, setPane] = useState<QueryResultPane>('result')
  const [error, setError] = useState(''), [resultOpen, setResultOpen] = useState(true), [resultKey, setResultKey] = useState('')
  const pending = useRef<AbortController | null>(null), serial = useRef(0), mounted = useRef(true)
  const current = useRef({ bridge, connection, value }); current.current = { bridge, connection, value }
  const { confirm, confirmation, cancel } = useWorkbenchConfirm()
  const cancelConfirm = useRef(cancel); cancelConfirm.current = cancel
  useEffect(() => {
    mounted.current = true
    return () => { mounted.current = false; ++serial.current; pending.current?.abort(); cancelConfirm.current() }
  }, [])
  useEffect(() => { if (!connection.live) { pending.current?.abort(); cancelConfirm.current() } }, [connection.live])
  const run = async () => {
    if (pending.current || !current.current.connection.live) return
    const snapshot = editor.current?.read() || { text: current.current.value, selection: '', from: 0, to: 0 }
    const text = snapshot.selection.length ? snapshot.selection : snapshot.text
    let planned: KafkaStep[]
    try {
      planned = createKafkaBatch(text)
      if (snapshot.selection.length) planned = planned.map(step => ({ ...step, from: step.from + snapshot.from, to: step.to + snapshot.from }))
      if (kafkaWriteSummary(planned).length && current.current.connection.environment !== 'sit') throw new Error('Kafka 写操作仅在 SIT 开放。')
    } catch (caught) { setError(caught instanceof Error ? caught.message : '命令无效。'); setResultOpen(true); setResultKey(`error-${++serial.current}`); return }
    const controller = new AbortController(), runSerial = ++serial.current
    const binding = current.current.connection, executor = current.current.bridge.executeText
    const owns = () => mounted.current && serial.current === runSerial
    pending.current = controller; setBusy(true); setStopping(false); setError('')
    try {
      if (!executor) throw new Error('Kafka 执行通道不可用。')
      const writes = kafkaWriteSummary(planned)
      if (writes.length) {
        const label = planned.length === 1 ? planned[0].text.split(/\s/, 1)[0].toUpperCase() : 'Kafka 写操作'
        const accepted = await confirm({ title: `确认 ${label}`, body: <><p>{binding.name} · SIT · 本次 {planned.length} 条命令，其中 {writes.length} 条写操作</p><pre className="db-kafka-write-summary">{writes.join('\n\n')}</pre><p>依次执行，失败即停止；已成功操作不会回滚。写入结果未知时请先核对，勿直接重试。</p></>, confirmLabel: `执行 ${label}`, danger: true })
        if (!accepted || controller.signal.aborted || !owns()) return
        const latest = editor.current?.read()
        if (!latest || latest.text !== snapshot.text || latest.selection !== snapshot.selection || current.current.connection.id !== binding.id || current.current.connection.generation !== binding.generation || !current.current.connection.live) throw new Error('确认期间查询内容、选区或连接已变化，请重新执行。')
      }
      if (controller.signal.aborted || !owns()) return
      setSteps(planned); setActive(0); setPane('result'); setResultOpen(true); setResultKey(`run-${runSerial}`)
      await runKafkaBatch({ steps: planned, signal: controller.signal,
        execute: (command, signal) => {
          const now = current.current.connection
          if (signal.aborted || !owns() || !now.live || now.id !== binding.id || now.generation !== binding.generation) throw Object.assign(new Error('执行已停止或连接已变化。'), { effect: 'none' })
          return executor(binding, command, {}, signal)
        },
        onChange: next => { if (owns()) setSteps(next) },
      })
    } catch (caught) { if (owns()) setError(caught instanceof Error ? caught.message : '执行失败。') }
    finally { if (owns()) { pending.current = null; setBusy(false); setStopping(false) } }
  }
  const stop = () => { pending.current?.abort(); cancelConfirm.current(); setStopping(true) }
  const selected = steps[active]
  const running = steps.findIndex(step => step.status === 'running')
  const summary = busy ? (stopping ? '正在停止，等待当前操作回执…' : running >= 0 ? `正在执行 ${running + 1}/${steps.length}` : '等待执行确认…')
    : steps.length ? `${steps.filter(step => step.status === 'succeeded').length}/${steps.length} 成功${steps.some(step => step.status === 'unknown') ? ' · 有结果未知，请核验' : ''}` : ''
  return <>
    <ExecutionWorkbench className="db-sql-run-workspace db-command-console" resultKey={resultKey} resultOpen={resultOpen} onResultOpenChange={setResultOpen}
      toolbar={<div className="db-catalog-tools db-sql-toolbar">
        <button type="button" className="db-sql-toolbar-btn db-primary" disabled={busy || !connection.live} onClick={() => void run()}><Play size={14} />{busy ? '执行中…' : hasSelection ? '执行选中' : '执行全部'}</button>
        <KafkaCommandBuilder bridge={bridge} connection={connection} names={(editorContext as KafkaNames) || { topics: [], groups: [] }} disabled={busy} onGenerate={command => { if (!editor.current) throw new Error('查询编辑器尚未就绪。'); editor.current.append(command) }} />
        {busy && <button type="button" className="db-sql-toolbar-btn" disabled={stopping} onClick={stop}><Square size={14} />停止</button>}
      </div>}
      rail={<button type="button" className="db-text-button" disabled={!connection.live || stopping} onClick={busy ? stop : () => void run()}>{busy ? '停止' : hasSelection ? '执行选中' : '执行全部'}</button>}
      editor={<div className="db-command-row"><KafkaCommandEditor value={value} onChange={onChange} onRun={() => void run()} editorContext={editorContext} apiRef={editor} onSelectionChange={selection => setHasSelection(!!selection.length)} onLimit={message => { setError(message); setResultOpen(true) }} /></div>}
      result={<QueryResultFrame pane={pane} onPaneChange={setPane} activeResultTab={String(active)} onResultTabChange={key => setActive(Number(key))}
        resultTabs={steps.map(step => ({ key: String(step.index), label: `结果 ${step.index + 1} · ${step.text.split(/\s/, 1)[0]} · ${kafkaStepLabel(step.status)}` }))}
        summary={summary && <span role="status">{summary}</span>}
        secondaryHeader={<>{error && <ResourceError message={error} />}{selected && <details className="db-kafka-executed-command"><summary>本次执行命令 · {kafkaStepLabel(selected.status)}</summary><pre>{selected.text}</pre></details>}</>}
        message={<div className="db-kafka-batch-messages">{steps.map(step => <section key={step.index}><strong>{step.index + 1}. {step.text.split(/\s/, 1)[0]} · {kafkaStepLabel(step.status)}</strong>{step.executionId && <small>执行 ID：{step.executionId}</small>}{step.error && <p>{step.error}</p>}{step.status === 'unknown' && <p>操作可能已经生效，请核对目标后再决定是否重新提交。</p>}</section>)}</div>}>
        {selected?.result ? <><Result key={`${resultKey}:${selected.index}`} result={selected.result} onUse={onUse} />{selected.error && <ResourceError message={selected.error} />}</>
          : selected ? <p className={selected.status === 'failed' || selected.status === 'unknown' ? 'db-error' : 'db-muted'}>{selected.error || kafkaStepLabel(selected.status)}</p> : undefined}
      </QueryResultFrame>} />
    <p className="db-command-hint">{hasSelection ? '执行选中内容' : '执行全部命令'} · 按换行或分号分隔，依次执行，失败即停止。{kafkaParameterHint(value)}</p>
    {confirmation}
  </>
}

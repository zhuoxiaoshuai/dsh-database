import React, { useEffect, useRef, useState } from 'react'
import type { WorkspaceBridge } from '../../../shared/workbench.ts'
import { useExecutionItems } from '../../ai-query-bus.ts'

export function StorageNotice({ bridge }: { bridge: WorkspaceBridge }) {
  const { storage } = useExecutionItems(bridge)
  const [busy, setBusy] = useState(false)
  const [message, setMessage] = useState('')
  const sawDegraded = useRef(false)
  useEffect(() => { sawDegraded.current = false; setMessage('') }, [bridge])
  useEffect(() => {
    const history = storage?.executionHistory
    if (history?.degraded) {
      if (!sawDegraded.current) setMessage('')
      sawDegraded.current = true
    } else if (history?.degraded === false && !history.retrying && sawDegraded.current) {
      sawDegraded.current = false
      setMessage('执行历史已可靠落盘。')
    }
  }, [bridge, storage?.executionHistory?.degraded, storage?.executionHistory?.retrying])
  const retry = async () => {
    if (busy || !bridge.executions) return
    setBusy(true); setMessage('正在重试历史落盘…')
    try {
      const outcome = await bridge.executions('execution-persistence-retry', {}) as { saved?: boolean }
      setMessage(outcome.saved === true ? '执行历史已可靠落盘。' : '执行历史尚未可靠落盘。')
    } catch (error) { setMessage(error instanceof Error ? error.message : '历史保存失败。') }
    finally { setBusy(false) }
  }
  if (!storage?.executionHistory?.degraded && !storage?.workspace?.degraded && !message) return null
  return <aside className="db-info-note" role="status" aria-label="存储状态">
    {storage?.executionHistory?.degraded && <span>执行结果仍在内存中，历史尚未可靠落盘。{storage.executionHistory.retrying ? ' 正在重试落盘。' : ''}<button type="button" disabled={busy} onClick={() => void retry()}>重试历史保存</button></span>}
    {storage?.workspace?.degraded && <p>工作区保存失败；请保留本地草稿并使用文档的“重试保存”。</p>}
    {message && <p>{message}</p>}
  </aside>
}

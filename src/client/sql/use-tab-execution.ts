import { useEffect, useRef, useState } from 'react'
import { formatSqlBatchStatus, type SqlStep } from '../../shared/sql-batch.ts'
import { ownsSqlRun, type SqlRunSnapshot } from './run-snapshot.ts'

/** One manual tab owns its run and result; hidden tabs do not transfer ownership. */
export function useTabExecution(identity: string, onStatus: (value: { rows?: number; elapsedMs?: number; failed?: boolean; message?: string }) => void) {
  const [busy, setBusy] = useState(false)
  const [steps, setSteps] = useState<SqlStep[]>([])
  const [activeStep, setActiveStep] = useState(0)
  const [resultSnapshot, setResultSnapshot] = useState<SqlRunSnapshot>()
  const snapshotRef = useRef<SqlRunSnapshot>()
  const running = useRef<AbortController | null>(null)
  const runSeq = useRef(0)
  const viewRef = useRef(identity)
  const mounted = useRef(true)
  if (viewRef.current !== identity) { viewRef.current = identity; runSeq.current++; running.current?.abort() }
  useEffect(() => {
    mounted.current = true
    return () => { mounted.current = false; runSeq.current++; running.current?.abort() }
  }, [])
  const ownsSnapshot = (snapshot?: SqlRunSnapshot) => ownsSqlRun(snapshot, viewRef.current, runSeq.current, mounted.current)
  const applyBatch = (next: SqlStep[], seq: number, current = 0) => {
    if (seq !== runSeq.current) return
    setSteps(next)
    setActiveStep(Math.min(Math.max(0, current), Math.max(0, next.length - 1)))
    const summary = formatSqlBatchStatus(next, next.some(step => step.status === 'running'))
    const lastOk = [...next].reverse().find(step => step.status === 'ok')
    onStatus({ rows: lastOk?.result?.affectedRows ?? lastOk?.result?.rows.length,
      elapsedMs: next.reduce((sum, step) => sum + (step.result?.elapsedMs ?? 0), 0),
      failed: next.some(step => step.status === 'failed'), message: summary })
  }
  return { busy, setBusy, steps, setSteps, activeStep, setActiveStep, resultSnapshot, setResultSnapshot,
    snapshotRef, running, runSeq, viewRef, mounted, ownsSnapshot, staleResult: !!resultSnapshot && !ownsSnapshot(resultSnapshot), applyBatch }
}

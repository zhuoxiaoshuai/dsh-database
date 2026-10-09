import { useRef, useState } from 'react'
import { saveDmlOperations, type DmlOp, type UnknownGridWrite } from '../execute-dml.ts'

/** SQL grid submission owns confirmation, pending receipts and uncertainty in one place. */
export function useGridSave() {
  const saveOps = useRef<DmlOp[]>([])
  const uncertainSave = useRef(false)
  const [unknownWrite, setUnknownWrite] = useState<UnknownGridWrite>()
  const [saving, setSaving] = useState(false)
  const inFlight = useRef(false)
  const [confirmWrite, setConfirmWrite] = useState(false)
  const preparedCurrent = useRef<() => boolean>(() => false)
  const prepare = (operations: DmlOp[], current: () => boolean) => {
    if (uncertainSave.current || inFlight.current) return false
    preparedCurrent.current = current
    saveOps.current = operations; setConfirmWrite(true); return true
  }
  const discard = () => { saveOps.current = []; setConfirmWrite(false); return uncertainSave.current }
  const verifiedRead = () => { uncertainSave.current = false; setUnknownWrite(undefined) }
  const submit = async (options: {
    current(): boolean; execute(op: DmlOp): Promise<void>; committed(op: DmlOp): void;
    success(): void; failure(error: unknown): void
  }) => {
    if (inFlight.current) return
    inFlight.current = true
    setSaving(true)
    try {
      if (uncertainSave.current) throw new Error('上次写入结果未知，不能再次提交旧草稿。')
      await saveDmlOperations(saveOps.current, op => {
        if (!preparedCurrent.current() || !options.current()) throw Object.assign(new Error('执行目标或原结果已变化，后续修改未提交。'), { effect: 'none', phase: 'check' })
        return options.execute(op)
      }, options.committed)
      options.success()
    } catch (error) {
      if ((error as { effect?: string })?.effect === 'unknown') {
        uncertainSave.current = true
        setUnknownWrite((error as { unknownWrite?: UnknownGridWrite }).unknownWrite)
      }
      options.failure(error)
    } finally { inFlight.current = false; setConfirmWrite(false); setSaving(false) }
  }
  return { saving, confirmWrite, setConfirmWrite, saveOps, uncertainSave, unknownWrite, prepare, discard, verifiedRead, submit }
}

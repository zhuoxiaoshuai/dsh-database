import { useEffect, useRef, useState } from 'react'
import type { Connection, Result, WorkspaceBridge } from '../../shared/workbench.ts'
import { unavailableMaintenanceCapability, type MaintenanceCapability } from '../../shared/maintenance-capability.ts'
import type { SqlRunSnapshot } from './run-snapshot.ts'

/** Capability checks belong to the original query target and cannot upgrade a later result. */
export function useQueryMaintenance(bridge: Pick<WorkspaceBridge, 'maintenance'>, connection: Connection, identity: string, owns: (snapshot?: SqlRunSnapshot) => boolean) {
  const [maintenance, setMaintenance] = useState(false)
  const [capability, setCapability] = useState<MaintenanceCapability>()
  const [capabilityBusy, setCapabilityBusy] = useState(false)
  const sequence = useRef(0), target = useRef(identity)
  if (target.current !== identity) { target.current = identity; sequence.current++ }
  useEffect(() => { setMaintenance(false); setCapability(undefined); setCapabilityBusy(false) }, [identity])
  const invalidateCapability = () => { sequence.current++; setCapabilityBusy(false) }
  const detectEditable = async (text: string, result: Result, schema: string, snapshot?: SqlRunSnapshot) => {
    if (!owns(snapshot)) return
    const check = ++sequence.current
    setCapabilityBusy(true)
    try {
      const value = await bridge.maintenance!(connection, { kind: 'capability', source: 'query', schema, sql: text, resultColumns: result.columns })
      if (owns(snapshot) && check === sequence.current) setCapability(value as MaintenanceCapability)
    } catch (error) {
      if (owns(snapshot) && check === sequence.current) setCapability(unavailableMaintenanceCapability('query', error instanceof Error ? error.message : '无法检查维护能力。'))
    } finally { if (owns(snapshot) && check === sequence.current) setCapabilityBusy(false) }
  }
  return { maintenance, setMaintenance, capability, setCapability, capabilityBusy, detectEditable, invalidateCapability }
}

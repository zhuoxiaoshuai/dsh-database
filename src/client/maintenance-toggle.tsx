import React from 'react'
import type { MaintenanceCapability } from '../shared/maintenance-capability.ts'

export function MaintenanceToggle({
  capability,
  checking,
  enabled,
  busy,
  onToggle,
  onReason,
}: {
  capability?: MaintenanceCapability
  checking?: boolean
  enabled: boolean
  busy?: boolean
  onToggle(): void
  onReason(reason: string): void
}): React.ReactElement {
  const reason = capability?.reason || '当前结果尚未完成维护能力检查。'
  const usable = !!capability?.canEnable
  const text = checking ? '正在检查…' : enabled ? '关闭维护' : usable ? '开启维护' : `不可维护：${reason}`
  const activate = () => usable || enabled ? onToggle() : onReason(reason)
  return <span className="db-maintenance-toggle-wrap" title={!checking && !usable ? reason : undefined}>
    <button
      type="button"
      className="db-maintenance-small db-maintenance-toggle"
      aria-disabled={checking || busy}
      onClick={() => { if (!checking && !busy) activate() }}
    >
      {text}
    </button>
  </span>
}

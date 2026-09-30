import type { MaintenanceResult } from './workbench.ts'

export const structureStatusLabels: Record<string, string> = {
  success: '成功',
  partial: '部分失败',
  failed: '失败',
  unknown: '结果未知',
}

export function structureExecuteOutcome(result: MaintenanceResult | undefined, fallbackSteps?: MaintenanceResult['steps']): MaintenanceResult {
  if (result && (result.status === 'success' || result.status === 'partial' || result.status === 'failed' || result.status === 'unknown')) {
    return { ...result, steps: result.steps || fallbackSteps }
  }
  return {
    status: 'unknown',
    message: result?.message || '操作未完成或结果未知。请核对实际结构，不能重复使用本次审批。',
    steps: result?.steps || fallbackSteps,
  }
}

export function structureStatusLabel(status?: string): string {
  return structureStatusLabels[status || ''] || '结果未知'
}

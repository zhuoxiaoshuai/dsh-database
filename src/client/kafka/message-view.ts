import { formatValue } from '../workspace/parts/formatted-cell-value.ts'

export type KafkaBytesValue = { kind: 'null' | 'text' | 'binary'; length: number; truncated?: boolean; text?: string; base64?: string }

export function kafkaJsonPreview(value?: KafkaBytesValue): string | undefined {
  if (value?.kind !== 'text' || value.truncated || !value.text) return undefined
  try { JSON.parse(value.text); return formatValue(value.text, 'json') } catch { return undefined }
}

/** Export the already limited wire representation, not a reconstructed full message. */
export function kafkaExportText(result: object): string {
  return JSON.stringify({ notice: '仅导出当前已读取的有限结果；单值可能只有截断预览，未完成的范围没有后台补读。', result }, null, 2)
}

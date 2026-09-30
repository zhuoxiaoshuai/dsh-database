import type React from 'react'
import type { Connection, SourceConnectionInput } from '../../../shared/workbench.ts'

export const sqlConnectionPermissionNote = '只读环境 AI 无增删改；SIT AI 可直接写。'

export type ConnectionFormSource = {
  id: SourceConnectionInput['dialect']
  displayName: string
  optionalUser: boolean
  optionalPassword: boolean
  permissionNote: string
  createInput(options: { passwordStorage?: boolean; editing?: Connection }): SourceConnectionInput
  showCredentials(input: SourceConnectionInput): boolean
  fields(input: SourceConnectionInput, patch: (value: Partial<SourceConnectionInput>) => void, editing?: Connection): React.ReactNode
}

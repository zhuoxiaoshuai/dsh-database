export type MaintenanceOperation = 'insert' | 'update' | 'delete'

export type MaintenanceColumnCapability = {
  resultColumn: string
  sourceColumn?: string
  editable: boolean
  reason?: string
}

export type MaintenanceCapability = {
  id?: string
  source: 'table' | 'query'
  schema?: string
  table?: string
  canEnable: boolean
  canInsert: boolean
  canUpdate: boolean
  canDelete: boolean
  reason: string
  insertReason?: string
  updateReason?: string
  deleteReason?: string
  primaryKeys: string[]
  resultPrimaryKeys: string[]
  identityColumns: string[]
  columns: MaintenanceColumnCapability[]
}

export const unavailableMaintenanceCapability = (
  source: MaintenanceCapability['source'],
  reason: string,
): MaintenanceCapability => ({
  source,
  canEnable: false,
  canInsert: false,
  canUpdate: false,
  canDelete: false,
  reason,
  insertReason: reason,
  updateReason: reason,
  deleteReason: reason,
  primaryKeys: [],
  resultPrimaryKeys: [],
  identityColumns: [],
  columns: [],
})

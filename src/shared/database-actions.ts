/** Actions exposed through WorkspaceBridge.executions. */
export const EXECUTION_API_ACTIONS = [
  'execution-list',
  'execution-get',
  'execution-cancel',
  'execution-wait',
  'execution-latest',
  'execution-persistence-retry',
  'shared-query-get',
  'shared-query-update',
  'shared-query-control',
  'shared-query-run',
  'shared-query-explain',
  'execution-document-get',
  'execution-document-update',
  'execution-document-context',
  'execution-document-control',
  'execution-document-run',
] as const
export type ExecutionApiAction = typeof EXECUTION_API_ACTIONS[number]

/** Fixed actions accepted by the host connection API. Template actions remain prefix-dispatched. */
export const CONNECTION_API_ACTIONS = [
  ...EXECUTION_API_ACTIONS,
  'catalog',
  'query',
  'manual-query',
  'browse',
  'maintenance',
  'redis-command',
  'redis-scan',
  'redis-key-suggest',
  'redis-key',
  'source-execute',
  'explorer-list',
  'explorer-read',
  'activate',
  'workbench',
  'disconnect',
  'remove',
  'update',
  'duplicate',
  'test',
  'connect',
] as const
export type ConnectionApiAction = typeof CONNECTION_API_ACTIONS[number]

export const SERVICE_REQUEST_ACTIONS = ['catalog', 'query', 'manual-query', 'browse', 'maintenance'] as const
export type ServiceRequestAction = typeof SERVICE_REQUEST_ACTIONS[number]

/** Database operations recorded in AI execution history. */
export const DATABASE_OPERATIONS = [
  'database_list_connections',
  'database_import_connections',
  'database_list_schemas',
  'database_search_tables',
  'database_describe_table',
  'database_query_readonly',
  'database_execute_sql',
  'database_explain_plan',
  'database_search_templates',
  'database_get_template',
  'database_save_template',
  'database_read_collab',
  'database_status',
  'database_catalog',
  'database_templates',
  'shared_query_write',
  'workbench_shared_query',
  'redis_status',
  'redis_keys',
  'redis_value',
  'redis_execute',
] as const
export type DatabaseOperation = typeof DATABASE_OPERATIONS[number]

/** On-demand call guides. Keep these out of tool schemas so they are not resident each turn. */

export const DATABASE_GUIDE_TOPICS = [
  'workflow',
  'database_status',
  'database_import_connections',
  'database_catalog',
  'database_execute_sql',
  'database_templates',
  'database_read_collab',
] as const

export type DatabaseGuideTopic = typeof DATABASE_GUIDE_TOPICS[number]

const GUIDES: Record<DatabaseGuideTopic, { args: string; guide: string }> = {
  workflow: {
    args: 'topic=workflow',
    guide: '用户说当前 SQL、这个 SQL、看一下数据库 SQL 时，调用 database_execute_sql 传 action=read。结构用 database_catalog。查数或改数同一工具传入 sql。经验库用 database_templates。结构变更在工作台操作。',
  },
  database_status: {
    args: 'topic? 省略或工具名或 workflow',
    guide: '省略 topic：返回已登录连接。当前 SQL、这个 SQL、看数据库 SQL 用 database_execute_sql action=read。传工具名或 workflow：只返回那一节。无连接时请用户登录，或先 database_import_connections。',
  },
  database_import_connections: {
    args: 'connections[]: name,dialect,host,port,database,oracleMode,username,environment,redisMode,sentinelMaster',
    guide: '只登记不登录、不收密码。去重：方言+主机+端口+用户名，有库名再比库名。Oracle 必须有 Service Name 或 SID，并区分 service/sid。Redis 缺省 standalone；sentinel 必须有 sentinelMaster；cluster 的 database 为 0。已存在则跳过。单次最多 50 条。用户稍后在工作台补密码登录。',
  },
  database_catalog: {
    args: 'connectionId, generation, kind=schemas|tables|table, schema?, table?, search?, offset?',
    guide: '不要用 database_execute_sql 查 information_schema。kind=schemas：库及表/视图数量，分页用 offset。kind=tables：必须有 schema；search 可空；行数是估算。kind=table：必须有 schema 和 table。读不到的部分 status=unavailable，不要当成空。',
  },
  database_execute_sql: {
    args: 'connectionId?, generation?, schema?, sql?, action=read?, purpose?=verify|result, limit?',
    guide: '用户说当前 SQL、这个 SQL、看一下数据库 SQL 时传 action=read，返回工作台 AI Query 当前语句。有 sql：执行，含 EXPLAIN。分号分隔最多 8 条，顺序执行，首错停止。SIT 回原值（每条最多 100 行），可直接 INSERT/UPDATE/DELETE。purpose=verify 不覆盖结果网格；purpose=result 发布到工作台。未传 purpose 时仅单条 COUNT/EXISTS/SELECT 1 视为验证。禁止 FOR UPDATE 与 SHOW。UAT/PVT 只读。结构变更在工作台操作。',
  },
  database_templates: {
    args: 'action=search|get|save；search: query?,connectionId?,dialect?；get: id；save: connectionId,title,sql,summary?,tags?',
    guide: '经验库，不执行 SQL。search：复用当前连接须传 connectionId；query 为空返回最近模板；只返回标题/摘要/表名。get：传 id 读原文。save：传 connectionId、title、sql；近重复会合并；不能归档或删除。执行原文仍走 database_execute_sql。',
  },
  database_read_collab: {
    args: '无',
    guide: '查询页页签。当前 SQL、这个 SQL 用 database_execute_sql action=read。lastRun 只有列名、行数、耗时。',
  },
}

const ALIASES: Record<string, DatabaseGuideTopic> = {
  database_list_connections: 'database_status',
  database_list_schemas: 'database_catalog',
  database_search_tables: 'database_catalog',
  database_describe_table: 'database_catalog',
  database_query_readonly: 'database_execute_sql',
  database_explain_plan: 'database_execute_sql',
  database_search_templates: 'database_templates',
  database_get_template: 'database_templates',
  database_save_template: 'database_templates',
}

export type DatabaseGuideEntry = { topic: DatabaseGuideTopic; args: string; guide: string; alias?: string }

export function databaseGuideTopics(): string[] {
  return [...DATABASE_GUIDE_TOPICS]
}

export function lookupDatabaseGuide(topic: unknown): DatabaseGuideEntry | undefined {
  if (typeof topic !== 'string' || !topic.trim()) return
  const key = topic.trim()
  const canonical = (DATABASE_GUIDE_TOPICS as readonly string[]).includes(key) ? key as DatabaseGuideTopic : ALIASES[key]
  if (!canonical) return
  const found = GUIDES[canonical]
  return { topic: canonical, args: found.args, guide: found.guide, ...(canonical === key ? {} : { alias: key }) }
}

import type { Connection, Dialect, SqlDialect } from '../shared/workbench.ts'

/** Which tool family a call may bind to. SQL covers MySQL and Oracle. */
export type AiConnectionFamily = 'sql' | 'redis' | 'kafka' | 'nacos'

export interface AiConnectionSummary {
  connectionId: string
  generation: string
  name: string
  dialect: Dialect
}

/** Returned instead of a one-line throw so the model can retry with the live handles. */
export interface AiConnectionHeal {
  ok: false
  error: string
  connections: AiConnectionSummary[]
  help: string
}

type ResolvedConnection<F extends AiConnectionFamily, Live extends boolean = true> = Connection & {
  generation: Live extends true ? string : Connection['generation']
  dialect: F extends 'sql' ? SqlDialect : F
}

export type AiConnectionResolved<F extends AiConnectionFamily, Live extends boolean = true> =
  | { ok: true; connection: ResolvedConnection<F, Live> }
  | AiConnectionHeal

const STATUS_TOOL: Record<AiConnectionFamily, string> = {
  sql: 'database_status',
  redis: 'redis_status',
  kafka: 'kafka_status',
  nacos: 'nacos_status',
}

function inFamily(connection: Connection, family: AiConnectionFamily): boolean {
  if (family === 'sql') return connection.dialect === 'mysql' || connection.dialect === 'oracle'
  return connection.dialect === family
}

function familyLabel(family: AiConnectionFamily): string {
  switch (family) {
    case 'sql': return 'SQL'
    case 'redis': return 'Redis'
    case 'kafka': return 'Kafka'
    case 'nacos': return 'Nacos'
    default: {
      const unreachable: never = family
      return unreachable
    }
  }
}

export function aiConnectionHeal(family: AiConnectionFamily, error: string, connections: readonly AiConnectionSummary[]): AiConnectionHeal {
  const status = STATUS_TOOL[family]
  return {
    ok: false,
    error,
    connections: connections.map(item => ({ ...item })),
    help: `先调用 ${status}，或把 connections 里的 connectionId 和 generation 填回本工具。`,
  }
}

function summaries(connections: readonly Connection[]): AiConnectionSummary[] {
  return connections.flatMap(item => {
    if (typeof item.generation !== 'string' || item.generation === '') return []
    return [{ connectionId: item.id, generation: item.generation, name: item.name, dialect: item.dialect }]
  })
}

/**
 * Bind a tool call to one live connection.
 * A missing id uses lastActiveId when that connection is live in this family.
 * Otherwise it is filled only when the family has exactly one live connection.
 * A missing generation uses the connection's current one. A stale generation is
 * never replaced; the caller gets the live list instead.
 */
export function resolveAiConnection<F extends AiConnectionFamily, Live extends boolean = true>(input: {
  connections: readonly Connection[]
  family: F
  connectionId: unknown
  generation: unknown
  /** Templates may target a saved connection that is not logged in. Default true. */
  requireLive?: Live
  /** Used only when connectionId is omitted. Ignored when it is not a live connection in this family. */
  lastActiveId?: unknown
}): AiConnectionResolved<F, Live> {
  const requireLive = input.requireLive !== false
  const familyAll = input.connections.filter(item => inFamily(item, input.family))
  const live = familyAll.filter(item => item.live === true)
  const listed = summaries(live)
  const id = typeof input.connectionId === 'string' && input.connectionId !== '' ? input.connectionId : undefined
  const generation = typeof input.generation === 'string' && input.generation !== '' ? input.generation : undefined
  const reject = (error: string) => aiConnectionHeal(input.family, error, listed)

  const accept = (connection: Connection): AiConnectionResolved<F, Live> => {
    if (requireLive && (typeof connection.generation !== 'string' || connection.generation === '')) {
      return reject('连接缺少 generation。')
    }
    return { ok: true, connection: connection as ResolvedConnection<F, Live> }
  }

  if (id === undefined) {
    const activeId = typeof input.lastActiveId === 'string' && input.lastActiveId !== '' ? input.lastActiveId : undefined
    const active = activeId === undefined ? undefined : live.find(item => item.id === activeId)
    if (active !== undefined) {
      if (generation !== undefined && active.generation !== generation) return reject('generation 已过期。')
      return accept(active)
    }
    if (live.length === 1) {
      const only = live[0]
      if (only === undefined) return reject('请先连接。')
      if (generation !== undefined && only.generation !== generation) return reject('generation 已过期。')
      return accept(only)
    }
    if (live.length === 0) return reject(`请先连接${familyLabel(input.family)}。`)
    return reject('有多条连接，请提供 connectionId 和 generation。')
  }

  const found = input.connections.find(item => item.id === id)
  if (found === undefined) return reject('连接不存在。')
  if (!inFamily(found, input.family)) return reject(`此工具仅适用于 ${familyLabel(input.family)} 数据源。`)
  if (requireLive && found.live !== true) return reject(`请先连接${familyLabel(input.family)}。`)
  if (generation !== undefined && found.generation !== generation) return reject('generation 已过期。')
  return accept(found)
}

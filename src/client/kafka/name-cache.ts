import type { KafkaNames } from './completion.ts'

export function mergeKafkaNames(previous: KafkaNames, incoming: Partial<KafkaNames>): KafkaNames {
  const encoder = new TextEncoder()
  const next = { topics: [...previous.topics], groups: [...previous.groups] }
  let bytes = [...next.topics, ...next.groups].reduce((sum, name) => sum + encoder.encode(name).length, 0)
  let changed = false
  for (const kind of ['topics', 'groups'] as const) {
    const known = new Set(next[kind])
    for (const name of incoming[kind] || []) {
      if (typeof name !== 'string' || !name || /[\u0000-\u001f\u007f]/u.test(name) || known.has(name) || (kind === 'groups' && name.startsWith('dsh-peek-'))) continue
      const size = encoder.encode(name).length
      if (next[kind].length >= 5000 || bytes + size > 1048576) break
      next[kind].push(name); known.add(name); bytes += size; changed = true
    }
  }
  return changed ? next : previous
}

export function namesFromKafkaResult(value: unknown): Partial<KafkaNames> {
  if (!value || typeof value !== 'object') return {}
  const result = value as { topics?: unknown; groups?: unknown; topic?: unknown; groupId?: unknown }
  return {
    topics: [...(Array.isArray(result.topics) ? result.topics.filter((item): item is string => typeof item === 'string') : []), ...(typeof result.topic === 'string' ? [result.topic] : [])],
    groups: [...(Array.isArray(result.groups) ? result.groups.filter((item): item is string => typeof item === 'string') : []), ...(typeof result.groupId === 'string' ? [result.groupId] : [])],
  }
}

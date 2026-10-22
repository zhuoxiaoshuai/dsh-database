import { displayBytes } from '../../shared/redis-bytes.ts'

export type KeyFolder = { label: string; path: string; key?: string; children: KeyFolder[] }
type MutableFolder = { label: string; key?: string; kids: Map<string, MutableFolder> }

/** Group already-loaded key names by ":". Virtual folders do not carry a count. */
export function buildKeyTree(names: string[]): { folders: KeyFolder[]; leaves: string[] } {
  const root = new Map<string, MutableFolder>()
  const leaves: string[] = []
  const seen = new Set<string>()
  for (const name of names) {
    if (seen.has(name)) continue
    seen.add(name)
    if (!name.includes(':')) { leaves.push(name); continue }
    let kids = root
    let node: MutableFolder | undefined
    for (const part of name.split(':')) {
      node = kids.get(part)
      if (!node) { node = { label: part, kids: new Map() }; kids.set(part, node) }
      kids = node.kids
    }
    if (node) node.key = name
  }
  const freeze = (node: MutableFolder, prefix: string): KeyFolder => {
    // 原值用于拼接上一级路径（字节层面切分），展示值再转义，避免二进制段造成路径碰撞。
    const rawPath = prefix ? `${prefix}:${node.label}` : node.label
    const children = [...node.kids.values()].map(child => freeze(child, rawPath))
    return { label: displayBytes(node.label), path: displayBytes(rawPath), ...(node.key ? { key: node.key } : {}), children }
  }
  return { folders: [...root.values()].map(node => freeze(node, '')), leaves }
}

import { resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

/** True when the given entry module is what the process was started with. */
export function isDirectRun(entryUrl: string): boolean {
  const entry = process.argv[1]
  if (!entry) return false
  const left = resolve(entry)
  const right = fileURLToPath(entryUrl)
  return process.platform === 'win32' ? left.toLowerCase() === right.toLowerCase() : left === right
}

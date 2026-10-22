import { spawnSync } from 'node:child_process'
import { existsSync } from 'node:fs'
import { resolve } from 'node:path'
const entry = resolve(import.meta.dirname, '../../plugin-installer/scripts/pack-core.mjs')
if (!existsSync(entry)) throw new Error('Shared plugin-installer checkout is required for install:desktop')
const result = spawnSync(process.execPath, [entry, 'database', '--no-exe', '--install'], { stdio: 'inherit', windowsHide: true })
if (result.error) throw result.error
process.exitCode = result.status ?? 1

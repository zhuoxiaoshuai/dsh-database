import { spawn } from 'node:child_process'
import { mkdirSync, writeFileSync } from 'node:fs'
const out = process.env.KNOWLEDGE_REPAIR_OUT || 'artifacts/knowledge-repair-2026-10-21'
mkdirSync(out, { recursive: true })
const results = []
for (const suite of ['knowledge-order-ui', 'knowledge-tidy-order-ui', 'knowledge-stop-transport-ui', 'knowledge-archive']) {
  const started = new Date().toISOString()
  const child = spawn(process.execPath, ['--experimental-strip-types', `scripts/${suite}-acceptance.mjs`], { stdio: 'inherit', windowsHide: true })
  const code = await new Promise((resolve, reject) => { child.on('error', reject); child.on('close', resolve) })
  results.push({ suite, started, ended: new Date().toISOString(), code })
  writeFileSync(`${out}/${process.env.KNOWLEDGE_REPAIR_PHASE || 'current'}-runs.json`, JSON.stringify(results, null, 2))
}
process.exitCode = results.some(result => result.code !== 0) ? 1 : 0

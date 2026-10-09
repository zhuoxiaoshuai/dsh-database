/** Real Redis/Kafka regression using only this run's labelled disposable containers. */
import assert from 'node:assert/strict'
import { execFile } from 'node:child_process'
import { promisify } from 'node:util'
import { randomUUID } from 'node:crypto'
import { mkdir, writeFile } from 'node:fs/promises'
import { withKafkaFixture } from './kafka-fixture.mjs'

const exec = promisify(execFile)
const docker = async args => (await exec('docker', args, { windowsHide: true, timeout: 30000, maxBuffer: 1048576 })).stdout.trim()
const marker = randomUUID(), label = 'dsh.database.fact-adoption'
const report = { scope: 'owned disposable Redis/Kafka, real Host/Worker, no installed Desktop or model', redis: { status: 'NOT_RUN' }, kafka: { status: 'NOT_RUN' }, tls: 'NOT_RUN' }
const child = async (script, env) => {
  const result = await exec(process.execPath, [script], { windowsHide: true, env: { ...process.env, ...env }, timeout: 120000, maxBuffer: 1048576 })
  process.stdout.write(result.stdout)
}
let redisId
try {
  await docker(['image', 'inspect', '--format', '{{.Id}}', 'redis:7.4-alpine'])
  redisId = await docker(['run', '--pull=never', '-d', '--label', label + '=' + marker, '-p', '127.0.0.1::6379', 'redis:7.4-alpine', 'redis-server', '--save', '', '--appendonly', 'no'])
  assert.match(redisId, /^[a-f0-9]{64}$/)
  const port = Number((await docker(['port', redisId, '6379/tcp'])).match(/:(\d+)\s*$/)?.[1]); assert.ok(port)
  await child('scripts/redis-acceptance.mjs', { DSH_REDIS_TEST_PORT: String(port), DSH_REDIS_TLS_TEST: '0' })
  report.redis = { status: 'PASS', image: 'redis:7.4-alpine', checks: 'real command/read, document queue, manual/AI environment permissions and safe history' }
} catch (error) { report.redis = { status: 'FAIL', reason: 'Owned Redis acceptance failed; inspect command log for the assertion.' }; process.exitCode = 1 }
finally {
  if (redisId) {
    assert.equal(await docker(['inspect', '-f', '{{index .Config.Labels "' + label + '"}}', redisId]), marker)
    await docker(['rm', '-f', redisId])
  }
}
try {
  // Require the fixture's pinned image to exist locally; do not download an image for this review.
  await docker(['image', 'inspect', '--format', '{{.Id}}', 'apache/kafka@sha256:77e3df9054047a88b520d0cc46e16696d3b22022e1d580aeccd2632df6532837'])
  await withKafkaFixture(async fixture => {
    const env = { DSH_KAFKA_BROKERS: fixture.brokers.join(',') }
    await child('scripts/kafka-client-probe.mjs', env)
    await child('scripts/kafka-host-probe.mjs', env)
    report.kafka = { status: 'PASS', image: fixture.image, checks: 'real client/Host text operations, document execution and bounded peek' }
  })
} catch (error) { report.kafka = { status: 'FAIL', reason: 'Owned Kafka acceptance failed; inspect command log for the assertion.' }; process.exitCode = 1 }
await mkdir('artifacts/fact-adoption', { recursive: true })
await writeFile('artifacts/fact-adoption/source-live.json', JSON.stringify(report, null, 2))
console.log(JSON.stringify(report))

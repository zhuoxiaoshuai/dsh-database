import { execFile } from 'node:child_process'
import { promisify } from 'node:util'
import { withKafkaFixture } from './kafka-fixture.mjs'

const exec = promisify(execFile)
await withKafkaFixture(async fixture => {
  const environment = { ...process.env, DSH_KAFKA_BROKERS: fixture.brokers.join(',') }
  for (const script of ['kafka-client-probe.mjs', 'kafka-host-probe.mjs']) {
    const result = await exec(process.execPath, [`scripts/${script}`], { env: environment, windowsHide: true, timeout: 90000, maxBuffer: 1048576 })
    process.stdout.write(result.stdout)
    if (result.stderr) process.stderr.write(result.stderr)
  }
  console.log(JSON.stringify({ fixture: fixture.id, image: fixture.image, unauthenticated: 'PASS' }))
})
const secure = await exec(process.execPath, ['scripts/kafka-tls-probe.mjs'], {
  env: process.env, windowsHide: true, timeout: 120000, maxBuffer: 1048576 })
process.stdout.write(secure.stdout)
if (secure.stderr) process.stderr.write(secure.stderr)

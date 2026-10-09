import assert from 'node:assert/strict'
import { execFile } from 'node:child_process'
import { promisify } from 'node:util'

const exec = promisify(execFile)
const docker = async args => (await exec('docker', args, { windowsHide: true, timeout: 30000, maxBuffer: 1048576 })).stdout.trim()
export const reuseTestEnvironment = () => process.env.DSH_TEST_EXISTING_ENV === '1'

/** Opt-in test instance reuse; no container creation, image download or credential discovery. */
export async function existingTestContainer(name, internalPort) {
  assert.equal(await docker(['inspect', '--format', '{{.State.Running}}', name]), 'true', `${name} must already be running`)
  const id = await docker(['inspect', '--format', '{{.Id}}', name])
  const ports = JSON.parse(await docker(['inspect', '--format', '{{json .NetworkSettings.Ports}}', name]))
  const mapping = ports[`${internalPort}/tcp`]?.[0]
  assert.ok(mapping?.HostPort, `${name} must expose the expected port`)
  return { id, host: '127.0.0.1', port: Number(mapping.HostPort) }
}

export function requiredTestSecret(key) {
  assert.ok(process.env[key], `Provide ${key} for the existing test instance`)
  return process.env[key]
}

export async function existingKafkaTestSettings() {
  const { host, port } = await existingTestContainer('kafka', 9092)
  const mechanism = process.env.DSH_TEST_KAFKA_MECHANISM || 'plain'
  assert.ok(['none', 'plain', 'scram-sha-256', 'scram-sha-512'].includes(mechanism))
  return { brokers: [`${host}:${port}`], ...(mechanism === 'none' ? {} : {
    sasl: { mechanism, username: requiredTestSecret('DSH_TEST_KAFKA_USERNAME'), password: requiredTestSecret('DSH_TEST_KAFKA_PASSWORD') }
  }) }
}

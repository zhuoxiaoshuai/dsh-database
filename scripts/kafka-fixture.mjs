import { execFile } from 'node:child_process'
import { promisify } from 'node:util'
import { createServer } from 'node:net'
import { randomUUID } from 'node:crypto'
import assert from 'node:assert/strict'

const exec = promisify(execFile)
const IMAGE = 'apache/kafka@sha256:77e3df9054047a88b520d0cc46e16696d3b22022e1d580aeccd2632df6532837'
const LABEL = 'dsh.database.kafka.acceptance'
const docker = async args => (await exec('docker', args, { windowsHide: true, timeout: 120000, maxBuffer: 1048576 })).stdout.trim()
const delay = ms => new Promise(resolve => setTimeout(resolve, ms))
async function freePort() {
  const server = createServer()
  await new Promise((resolve, reject) => { server.once('error', reject); server.listen(0, '127.0.0.1', resolve) })
  const port = server.address().port
  await new Promise(resolve => server.close(resolve))
  return port
}

/** Create and clean only this run's labelled broker. No existing local Kafka instance is touched. */
export async function withKafkaFixture(work) {
  const marker = randomUUID()
  const port = await freePort()
  const env = [
    'KAFKA_NODE_ID=1',
    'KAFKA_PROCESS_ROLES=broker,controller',
    'KAFKA_CONTROLLER_QUORUM_VOTERS=1@localhost:9093',
    'KAFKA_LISTENERS=PLAINTEXT://:9092,CONTROLLER://:9093',
    `KAFKA_ADVERTISED_LISTENERS=PLAINTEXT://127.0.0.1:${port}`,
    'KAFKA_INTER_BROKER_LISTENER_NAME=PLAINTEXT',
    'KAFKA_CONTROLLER_LISTENER_NAMES=CONTROLLER',
    'KAFKA_OFFSETS_TOPIC_REPLICATION_FACTOR=1',
    'KAFKA_TRANSACTION_STATE_LOG_REPLICATION_FACTOR=1',
    'KAFKA_TRANSACTION_STATE_LOG_MIN_ISR=1',
  ]
  let id
  try {
    id = await docker(['run', '--detach', '--label', `${LABEL}=${marker}`, '--publish', `127.0.0.1:${port}:9092`,
      ...env.flatMap(value => ['--env', value]), IMAGE])
    assert.match(id, /^[a-f0-9]{64}$/)
    const { Kafka, logLevel } = await import('kafkajs')
    const kafka = new Kafka({ clientId: `dsh-kafka-fixture-${marker.slice(0, 8)}`, brokers: [`127.0.0.1:${port}`],
      connectionTimeout: 3000, requestTimeout: 3000, retry: { retries: 0 }, logLevel: logLevel.ERROR })
    let ready = false
    for (let attempt = 0; attempt < 30; attempt++) {
      const admin = kafka.admin()
      try { await admin.connect(); await admin.listTopics(); await admin.disconnect(); ready = true; break }
      catch { await admin.disconnect().catch(() => {}); await delay(1000) }
    }
    if (!ready) throw new Error('一次性 Kafka broker 未就绪。')
    // Metadata can be ready before the single-node group coordinator is elected.
    const admin = kafka.admin()
    await admin.connect()
    const readinessTopic = `dsh_fixture_ready_${marker.replaceAll('-', '').slice(0, 12)}`
    try {
      await admin.createTopics({ topics: [{ topic: readinessTopic, numPartitions: 1, replicationFactor: 1 }], waitForLeaders: true })
      let coordinatorReady = false
      for (let attempt = 0; attempt < 40; attempt++) {
        try { await admin.fetchOffsets({ groupId: `dsh-fixture-${marker}`, topics: [readinessTopic] }); coordinatorReady = true; break }
        catch { await delay(1000) }
      }
      if (!coordinatorReady) throw new Error('一次性 Kafka 消费组协调器未就绪。')
    } finally {
      await admin.deleteTopics({ topics: [readinessTopic] }).catch(() => {})
      await admin.disconnect()
    }
    return await work({ brokers: [`127.0.0.1:${port}`], id, marker, image: IMAGE })
  } finally {
    if (id) {
      const labels = await docker(['inspect', id, '--format', '{{json .Config.Labels}}']).then(JSON.parse).catch(() => ({}))
      if (labels[LABEL] !== marker) throw new Error('Kafka fixture 标签不匹配，拒绝清理。')
      await docker(['rm', '--force', id])
    }
  }
}

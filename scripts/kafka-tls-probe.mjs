import assert from 'node:assert/strict'
import { execFile } from 'node:child_process'
import { promisify } from 'node:util'
import { createServer } from 'node:net'
import { randomUUID } from 'node:crypto'
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { Kafka, logLevel } from 'kafkajs'
import { ConnectionService } from '../src/host/connection-service.ts'
import { memoryPasswordProtector } from '../src/host/saved-connections.ts'

const exec = promisify(execFile)
const image = 'apache/kafka@sha256:77e3df9054047a88b520d0cc46e16696d3b22022e1d580aeccd2632df6532837'
const label = 'dsh.database.kafka.tls.probe'
const run = (file, args, timeout = 120000) => exec(file, args, { windowsHide: true, timeout, maxBuffer: 1048576 })
const docker = async args => (await run('docker', args)).stdout.trim()
const delay = ms => new Promise(resolve => setTimeout(resolve, ms))
async function freePort() {
  const server = createServer()
  await new Promise((resolve, reject) => { server.once('error', reject); server.listen(0, '127.0.0.1', resolve) })
  const port = server.address().port
  await new Promise(resolve => server.close(resolve))
  return port
}

const marker = randomUUID()
const root = await mkdtemp(join(tmpdir(), 'dsh-kafka-tls-'))
const password = randomUUID().replaceAll('-', '')
const plaintextPort = await freePort(), tlsPort = await freePort(), saslPort = await freePort(), saslPlainPort = await freePort()
const keystore = join(root, 'broker.p12'), cert = join(root, 'broker.crt')
let id, service
try {
  await run('keytool', ['-genkeypair', '-alias', 'broker', '-keyalg', 'RSA', '-keysize', '2048',
    '-storetype', 'PKCS12', '-keystore', keystore, '-storepass', password, '-keypass', password,
    '-dname', 'CN=localhost', '-ext', 'SAN=DNS:localhost,IP:127.0.0.1', '-validity', '2', '-noprompt'])
  await run('keytool', ['-exportcert', '-rfc', '-alias', 'broker', '-keystore', keystore, '-storetype', 'PKCS12',
    '-storepass', password, '-file', cert])
  await writeFile(join(root, 'keystore.creds'), password)
  await writeFile(join(root, 'key.creds'), password)
  const readerPassword = randomUUID().replaceAll('-', '')
  await writeFile(join(root, 'kafka_server_jaas.conf'),
    `KafkaServer { org.apache.kafka.common.security.plain.PlainLoginModule required username="admin" password="${password}" user_reader="${readerPassword}"; };\n`)
  const env = [
    'KAFKA_NODE_ID=1', 'KAFKA_PROCESS_ROLES=broker,controller', 'KAFKA_CONTROLLER_QUORUM_VOTERS=1@localhost:9093',
    'KAFKA_LISTENERS=PLAINTEXT://:9092,SSL://:9094,SASL_SSL://:9095,INTERNAL://:9096,SASL_PLAINTEXT://:9097,CONTROLLER://:9093',
    'KAFKA_LISTENER_SECURITY_PROTOCOL_MAP=CONTROLLER:PLAINTEXT,PLAINTEXT:PLAINTEXT,SSL:SSL,SASL_SSL:SASL_SSL,SASL_PLAINTEXT:SASL_PLAINTEXT,INTERNAL:PLAINTEXT',
    `KAFKA_ADVERTISED_LISTENERS=PLAINTEXT://127.0.0.1:${plaintextPort},SSL://127.0.0.1:${tlsPort},SASL_SSL://127.0.0.1:${saslPort},SASL_PLAINTEXT://127.0.0.1:${saslPlainPort},INTERNAL://localhost:9096`,
    'KAFKA_INTER_BROKER_LISTENER_NAME=PLAINTEXT', 'KAFKA_CONTROLLER_LISTENER_NAMES=CONTROLLER',
    'KAFKA_AUTHORIZER_CLASS_NAME=org.apache.kafka.metadata.authorizer.StandardAuthorizer',
    'KAFKA_SUPER_USERS=User:admin;User:ANONYMOUS', 'KAFKA_ALLOW_EVERYONE_IF_NO_ACL_FOUND=true',
    'KAFKA_OFFSETS_TOPIC_REPLICATION_FACTOR=1', 'KAFKA_TRANSACTION_STATE_LOG_REPLICATION_FACTOR=1',
    'KAFKA_TRANSACTION_STATE_LOG_MIN_ISR=1', 'KAFKA_SSL_KEYSTORE_FILENAME=broker.p12',
    'KAFKA_SSL_KEYSTORE_CREDENTIALS=keystore.creds', 'KAFKA_SSL_KEY_CREDENTIALS=key.creds',
    'KAFKA_SSL_KEYSTORE_TYPE=PKCS12', 'KAFKA_SSL_CLIENT_AUTH=none',
    'KAFKA_SASL_ENABLED_MECHANISMS=PLAIN,SCRAM-SHA-256,SCRAM-SHA-512',
    `KAFKA_LISTENER_NAME_SASL__SSL_SCRAM___SHA___256_SASL_JAAS_CONFIG=org.apache.kafka.common.security.scram.ScramLoginModule required username="admin" password="${password}";`,
    `KAFKA_LISTENER_NAME_SASL__SSL_SCRAM___SHA___512_SASL_JAAS_CONFIG=org.apache.kafka.common.security.scram.ScramLoginModule required username="admin" password="${password}";`,
    'KAFKA_OPTS=-Djava.security.auth.login.config=/etc/kafka/secrets/kafka_server_jaas.conf',
  ]
  id = await docker(['create', '--label', `${label}=${marker}`, '--publish', `127.0.0.1:${plaintextPort}:9092`,
    '--publish', `127.0.0.1:${tlsPort}:9094`, '--publish', `127.0.0.1:${saslPort}:9095`,
    '--publish', `127.0.0.1:${saslPlainPort}:9097`, ...env.flatMap(value => ['--env', value]), image])
  assert.match(id, /^[a-f0-9]{64}$/)
  for (const filename of ['broker.p12', 'keystore.creds', 'key.creds', 'kafka_server_jaas.conf']) await docker(['cp', join(root, filename), `${id}:/etc/kafka/secrets/${filename}`])
  await docker(['start', id])
  const caPem = await readFile(cert, 'utf8')
  const kafka = new Kafka({ clientId: 'dsh-kafka-tls-probe', brokers: [`127.0.0.1:${tlsPort}`],
    ssl: { ca: [caPem], rejectUnauthorized: true }, connectionTimeout: 3000, requestTimeout: 3000,
    retry: { retries: 0 }, logLevel: logLevel.NOTHING })
  let ready = false
  for (let attempt = 0; attempt < 30; attempt++) {
    const admin = kafka.admin()
    try { await admin.connect(); await admin.listTopics(); await admin.disconnect(); ready = true; break }
    catch { await admin.disconnect().catch(() => {}); await delay(1000) }
  }
  if (!ready) {
    const logs = await run('docker', ['logs', '--tail', '70', id]).then(value => value.stdout + value.stderr).catch(() => '')
    console.error(logs.replaceAll(password, '[REDACTED]').slice(-6000))
    throw new Error('Kafka TLS fixture 未就绪。')
  }
  const topic = `dsh_auth_probe_${Date.now()}`
  const fixtureAdmin = kafka.admin(), fixtureProducer = kafka.producer()
  await fixtureAdmin.connect()
  await fixtureAdmin.createTopics({ topics: [{ topic, numPartitions: 1, replicationFactor: 1 }], waitForLeaders: true })
  await fixtureProducer.connect()
  await fixtureProducer.send({ topic, messages: [{ value: 'authenticated-read' }] })
  await fixtureProducer.disconnect()
  let coordinatorReady = false
  for (let attempt = 0; attempt < 30; attempt++) {
    try { await fixtureAdmin.fetchOffsets({ groupId: `dsh-fixture-${marker}`, topics: [topic] }); coordinatorReady = true; break }
    catch { await delay(1000) }
  }
  if (!coordinatorReady) throw new Error('Kafka 认证 fixture 的消费组协调器未就绪。')
  await fixtureAdmin.disconnect()
  service = new ConnectionService(() => true, root, undefined, memoryPasswordProtector)
  const input = { dialect: 'kafka', name: 'TLS probe', brokers: [`127.0.0.1:${tlsPort}`], tls: true, caPem,
    saslMechanism: 'none', username: '', password: '', environment: 'sit', rememberPassword: true }
  const accepted = await service.open('owner', input, true)
  assert.equal(accepted.version, 'Kafka')
  const tlsConnection = await service.open('owner', input, false)
  const peekText = `PEEK ${JSON.stringify(topic)} PARTITION 0 FROM BEGINNING LIMIT 1`
  const read = async connection => {
    const result = await service.executeText('owner', connection.id, connection.generation, peekText)
    assert.equal(result.messages?.[0]?.value?.text, 'authenticated-read')
  }
  await read(tlsConnection)
  await assert.rejects(service.open('owner', { ...input, caPem: '' }, true))
  const saslInput = { ...input, brokers: [`127.0.0.1:${saslPort}`], saslMechanism: 'plain', username: 'reader', password: readerPassword }
  assert.equal((await service.open('owner', saslInput, true)).version, 'Kafka')
  await read(await service.open('owner', saslInput, false))
  const plainWithoutTls = { ...saslInput, brokers: [`127.0.0.1:${saslPlainPort}`], tls: false, caPem: '' }
  await read(await service.open('owner', plainWithoutTls, false))
  await assert.rejects(service.open('owner', { ...saslInput, password: 'wrong' }, true))
  try {
    for (const mechanism of ['SCRAM-SHA-256', 'SCRAM-SHA-512']) {
      await docker(['exec', id, '/opt/kafka/bin/kafka-configs.sh', '--bootstrap-server', 'localhost:9096', '--alter',
        '--add-config', `${mechanism}=[password=${readerPassword}]`, '--entity-type', 'users', '--entity-name', 'reader'])
    }
  } catch (error) {
    const detail = String(error.stderr || error.message || '').replaceAll(readerPassword, '[REDACTED]').replaceAll(password, '[REDACTED]')
    throw new Error(`SCRAM 测试凭据创建失败：${detail.slice(-600)}`)
  }
  assert.equal((await service.open('owner', { ...saslInput, saslMechanism: 'scram-sha-256' }, true)).version, 'Kafka')
  await read(await service.open('owner', { ...saslInput, saslMechanism: 'scram-sha-256' }, false))
  const scramInput = { ...saslInput, saslMechanism: 'scram-sha-512' }
  assert.equal((await service.open('owner', scramInput, true)).version, 'Kafka')
  await read(await service.open('owner', scramInput, false))
  const saved = await service.open('owner', scramInput, false)
  const record = await readFile(join(root, 'database-workspace.json'), 'utf8')
  if (record.includes(readerPassword) || record.includes(caPem) || !saved.hasPassword || !saved.hasCa) {
    throw new Error('Kafka SCRAM 凭据或 CA 保存及脱敏异常。')
  }
  await service.dispose()
  service = new ConnectionService(() => true, root, undefined, memoryPasswordProtector)
  await service.restoreRemembered('owner')
  if (!service.list('owner').some(item => item.id === saved.id && item.live)) throw new Error('Kafka SCRAM 保存连接恢复异常。')
  const acl = async args => docker(['exec', id, '/opt/kafka/bin/kafka-acls.sh', '--bootstrap-server', 'localhost:9096', ...args])
  const deniedGroup = ['--deny-principal', 'User:reader', '--operation', 'READ', '--group', 'dsh-peek-', '--resource-pattern-type', 'prefixed']
  await acl(['--add', ...deniedGroup])
  try {
    const restricted = await service.open('owner', saslInput, false)
    const denied = await service.executeText('owner', restricted.id, restricted.generation, peekText).then(value => value.reason === 'error' || !value.messages?.length, () => true)
    assert.equal(denied, true, 'Group ACL 拒绝后不得读取消息')
  } finally { await acl(['--remove', '--force', ...deniedGroup]) }
  const deniedTopic = ['--deny-principal', 'User:reader', '--operation', 'READ', '--topic', topic]
  await acl(['--add', ...deniedTopic])
  try {
    const restricted = await service.open('owner', saslInput, false)
    const denied = await service.executeText('owner', restricted.id, restricted.generation, peekText).then(value => value.reason === 'error' || !value.messages?.length, () => true)
    assert.equal(denied, true, 'Topic ACL 拒绝后不得读取消息')
  } finally { await acl(['--remove', '--force', ...deniedTopic]) }
  console.log(JSON.stringify({ tlsRead: 'PASS', customCa: 'PASS', badCa: 'PASS', saslPlainTlsRead: 'PASS', saslPlainNoTlsRead: 'PASS',
    scram256Read: 'PASS', scram512Read: 'PASS', badPassword: 'PASS', groupAclDenied: 'PASS', topicAclDenied: 'PASS',
    protectedStorage: 'PASS', reconnect: 'PASS', container: id }))
} finally {
  await service?.dispose()
  if (id) {
    const labels = await docker(['inspect', id, '--format', '{{json .Config.Labels}}']).then(JSON.parse).catch(() => ({}))
    if (labels[label] !== marker) throw new Error('Kafka TLS fixture 标签不匹配，拒绝清理。')
    await docker(['rm', '--force', id])
  }
  await rm(root, { recursive: true, force: true })
}

import { parentPort } from 'node:worker_threads'
import { databaseErrorDetail } from './connect-error.mjs'
import { normalizeKafkaConfig } from './data-sources/kafka/connection.mjs'
import { parseKafkaCommand } from './data-sources/kafka/command.mjs'
import { openKafka, closeKafka, listKafkaTopics, describeKafkaTopic, peekKafkaPartition, listKafkaGroups, describeKafkaGroup, listKafkaGroupTopics, describeKafkaGroupTopic } from './data-sources/kafka/driver.mjs'

parentPort.once('message', async ({ input, testOnly }) => {
  const started = Date.now()
  let credentials
  const safeError = error => {
    let message = databaseErrorDetail(error, { maxLength: 1000, normalizeWhitespace: false }) || 'Kafka 请求失败。'
    for (const secret of [credentials?.password, credentials?.caPem]) if (secret) message = message.replaceAll(secret, '[REDACTED]')
    return message
  }
  let runtime
  const inflight = new Map()
  try {
    credentials = normalizeKafkaConfig(input)
    input.password = ''; input.caPem = ''
    runtime = await openKafka(credentials)
    if (testOnly) {
      await closeKafka(runtime)
      parentPort.postMessage({ ok: true, ready: true, result: { version: runtime.version, database: '', elapsedMs: Date.now() - started } })
      return
    }
    parentPort.on('close', () => { void closeKafka(runtime) })
    parentPort.on('message', async message => {
      if (message.cancel && message.requestId) { inflight.get(message.requestId)?.abort(); return }
      if (!message.requestId) return
      const controller = new AbortController()
      inflight.set(message.requestId, controller)
      try {
        let result
        if (message.action === 'reconnect' || message.action === 'revive') {
          const fresh = await openKafka(credentials)
          await closeKafka(runtime)
          runtime = fresh
          result = { version: fresh.version, database: '', health: 'ready' }
        } else if (message.action === 'kafka-topics') result = await listKafkaTopics(runtime, message.input)
        else if (message.action === 'kafka-groups') result = await listKafkaGroups(runtime, message.input)
        else if (message.action === 'kafka-group') {
          const input = message.input || {}
          if (typeof input.text === 'string') {
            const operation = parseKafkaCommand(input.text)
            if (operation.kind === 'group') result = await describeKafkaGroup(runtime, operation.groupId)
            else if (operation.kind === 'group-topic') result = await describeKafkaGroupTopic(runtime, operation.groupId, operation.topic)
            else throw new Error('GROUP 命令必需。')
          } else if (input.topics === true) result = await listKafkaGroupTopics(runtime, input.groupId)
          else if (typeof input.topic === 'string') result = await describeKafkaGroupTopic(runtime, input.groupId, input.topic)
          else result = await describeKafkaGroup(runtime, input.groupId)
        } else if (message.action === 'kafka-describe') {
          const operation = parseKafkaCommand(message.input?.text)
          if (operation.kind !== 'describe') throw new Error('DESCRIBE 命令必需。')
          result = await describeKafkaTopic(runtime, operation.topic)
        } else if (message.action === 'kafka-peek') {
          const operation = parseKafkaCommand(message.input?.text)
          if (operation.kind !== 'peek') throw new Error('PEEK 命令必需。')
          result = await peekKafkaPartition(runtime, operation, controller.signal)
        } else throw new Error('此 Kafka 操作尚未开放。')
        if (controller.signal.aborted) parentPort.postMessage({ requestId: message.requestId, cancelled: true, error: 'Kafka 读取已取消。' })
        else parentPort.postMessage({ requestId: message.requestId, result, health: 'ready' })
      } catch (error) {
        parentPort.postMessage({ requestId: message.requestId, cancelled: controller.signal.aborted, error: safeError(error),
          health: error?.recycleWorker ? 'closed' : 'ready' })
        if (error?.recycleWorker) {
          setImmediate(() => process.exit(1))
        }
      } finally { inflight.delete(message.requestId) }
    })
    parentPort.postMessage({ ok: true, ready: true, result: { version: runtime.version, database: '', elapsedMs: Date.now() - started, health: 'ready' } })
  } catch (error) {
    await closeKafka(runtime)
    parentPort.postMessage({ ok: false, ready: false, error: safeError(error) })
  }
})

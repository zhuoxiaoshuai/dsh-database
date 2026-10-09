import { parentPort } from 'node:worker_threads'
import { nativeErrorText } from './connect-error.mjs'
import { normalizeKafkaConfig } from './data-sources/kafka/connection.mjs'
import { parseKafkaCommand } from './data-sources/kafka/command.mjs'
import { limitKafkaResult, kafkaFailureHealth } from './data-sources/kafka/result.mjs'
import { openKafka, closeKafka, listKafkaTopics, describeKafkaTopic, peekKafkaPartition, listKafkaGroups, describeKafkaGroup, listKafkaGroupTopics, describeKafkaGroupTopic, produceKafkaMessage, produceKafkaBatch, produceKafkaTombstone, describeKafkaTopicConfig, kafkaTimeOffsets, scanKafkaMessages, createKafkaTopic, setKafkaGroupOffsets } from './data-sources/kafka/driver.mjs'

const writeActions = new Set(['kafka-produce', 'kafka-produce-batch', 'kafka-tombstone', 'kafka-create-topic', 'kafka-set-group-offsets'])

parentPort.once('message', async ({ input, testOnly }) => {
  const started = Date.now()
  let credentials
  const safeError = error => nativeErrorText(error, 'Kafka 请求失败。')
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
        } else if (message.action === 'kafka-topics' || message.action === 'kafka-groups') {
          let input = message.input || {}
          if (typeof input.text === 'string') {
            const operation = parseKafkaCommand(input.text)
            if (operation.kind !== (message.action === 'kafka-topics' ? 'topics' : 'groups')) throw new Error('列表命令与操作不匹配。')
            input = operation
          }
          result = message.action === 'kafka-topics' ? await listKafkaTopics(runtime, input, controller.signal) : await listKafkaGroups(runtime, input, controller.signal)
        }
        else if (message.action === 'kafka-group') {
          const input = message.input || {}
          if (typeof input.text === 'string') {
            const operation = parseKafkaCommand(input.text)
            if (operation.kind === 'group') result = await describeKafkaGroup(runtime, operation.groupId, controller.signal)
            else if (operation.kind === 'group-topics') result = await listKafkaGroupTopics(runtime, operation.groupId, operation, controller.signal)
            else if (operation.kind === 'group-topic') result = await describeKafkaGroupTopic(runtime, operation.groupId, operation.topic, controller.signal)
            else throw new Error('GROUP 命令必需。')
          } else if (input.topics === true) result = await listKafkaGroupTopics(runtime, input.groupId, input, controller.signal)
          else if (typeof input.topic === 'string') result = await describeKafkaGroupTopic(runtime, input.groupId, input.topic, controller.signal)
          else result = await describeKafkaGroup(runtime, input.groupId, controller.signal)
        } else if (message.action === 'kafka-describe') {
          const operation = parseKafkaCommand(message.input?.text)
          if (operation.kind !== 'describe') throw new Error('DESCRIBE 命令必需。')
          result = await describeKafkaTopic(runtime, operation.topic, controller.signal)
        } else if (message.action === 'kafka-peek') {
          const operation = parseKafkaCommand(message.input?.text)
          if (operation.kind !== 'peek') throw new Error('PEEK 命令必需。')
          result = await peekKafkaPartition(runtime, operation, controller.signal)
        } else if (message.action === 'kafka-produce') {
          const operation = parseKafkaCommand(message.input?.text)
          if (operation.kind !== 'produce') throw Object.assign(new Error('PRODUCE 命令必需。'), { effect: 'none' })
          result = await produceKafkaMessage(runtime, operation, controller.signal)
        } else if (message.action === 'kafka-produce-batch' || message.action === 'kafka-tombstone'
          || message.action === 'kafka-create-topic' || message.action === 'kafka-set-group-offsets') {
          const operation = parseKafkaCommand(message.input?.text)
          const expected = message.action.slice('kafka-'.length)
          if (operation.kind !== expected) throw Object.assign(new Error('Kafka 写命令与操作不匹配。'), { effect: 'none' })
          result = operation.kind === 'produce-batch' ? await produceKafkaBatch(runtime, operation, controller.signal,
            progress => parentPort.postMessage({ requestId: message.requestId, progress }))
            : operation.kind === 'tombstone' ? await produceKafkaTombstone(runtime, operation, controller.signal)
            : operation.kind === 'create-topic' ? await createKafkaTopic(runtime, operation, controller.signal)
            : await setKafkaGroupOffsets(runtime, operation, controller.signal)
        } else if (message.action === 'kafka-topic-config' || message.action === 'kafka-time-offsets' || message.action === 'kafka-scan') {
          const operation = parseKafkaCommand(message.input?.text)
          if (operation.kind !== message.action.slice('kafka-'.length)) throw new Error('Kafka 读取命令与操作不匹配。')
          result = operation.kind === 'topic-config' ? await describeKafkaTopicConfig(runtime, operation.topic, controller.signal)
            : operation.kind === 'time-offsets' ? await kafkaTimeOffsets(runtime, operation, controller.signal)
            : await scanKafkaMessages(runtime, operation, controller.signal)
        } else throw new Error('此 Kafka 操作尚未开放。')
        if (controller.signal.aborted && !writeActions.has(message.action)) parentPort.postMessage({ requestId: message.requestId, cancelled: true, error: 'Kafka 读取已取消。' })
        else parentPort.postMessage({ requestId: message.requestId, result: limitKafkaResult(result), health: 'ready' })
      } catch (error) {
        parentPort.postMessage({ requestId: message.requestId, cancelled: controller.signal.aborted, error: safeError(error),
          health: kafkaFailureHealth(error), ...(writeActions.has(message.action) ? { effect: error?.effect || 'none' } : {}) })
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

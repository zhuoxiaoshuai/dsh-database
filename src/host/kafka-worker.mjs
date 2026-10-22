import { connectionFailure } from './connection-failure.mjs'
import { parentPort } from 'node:worker_threads'
import { nativeErrorText } from './connect-error.mjs'
import { normalizeKafkaConfig } from './data-sources/kafka/connection.mjs'
import { parseKafkaCommand } from './data-sources/kafka/command.mjs'
import { cachedKafkaInspection, describeKafkaTopicGroups, describeKafkaGroupSummary, describeKafkaCatalog } from './data-sources/kafka/inspection.mjs'
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
    let health = 'ready', probing = false
    const heartbeat = setInterval(async () => {
      if (health !== 'ready' || inflight.size || probing) return
      probing = true
      const current = runtime
      const deadline = setTimeout(() => { health = 'degraded'; parentPort.postMessage({health,category:'network'}); setImmediate(() => process.exit(1)) }, 10_000)
      try {await current.admin.listTopics()}
      catch (error) {const category = connectionFailure(error); if (runtime === current && ['network','authentication','configuration'].includes(category)) {health = 'degraded'; parentPort.postMessage({health,category})}}
      finally {clearTimeout(deadline); probing = false}
    },30_000)
    heartbeat.unref()
    parentPort.on('close', () => { clearInterval(heartbeat); void closeKafka(runtime) })
    parentPort.on('message', async message => {
      if (message.cancel && message.requestId) { inflight.get(message.requestId)?.abort(); return }
      if (!message.requestId) return
      const controller = new AbortController()
      inflight.set(message.requestId, controller)
      try {
        let result
        if (message.action === 'reconnect' || message.action === 'revive') {
          const fresh = await openKafka(credentials)
          if (controller.signal.aborted) { await closeKafka(fresh); throw Object.assign(new Error('请求已取消。'), { cancelled: true }) }
          await closeKafka(runtime)
          runtime = fresh
          health = 'ready'
          result = { version: fresh.version, database: '', health: 'ready' }
        } else if (message.action === 'kafka-topics' || message.action === 'kafka-groups') {
          let input = message.input || {}
          if (typeof input.text === 'string') {
            const operation = parseKafkaCommand(input.text)
            if (operation.kind !== (message.action === 'kafka-topics' ? 'topics' : 'groups')) throw new Error('列表命令与操作不匹配。')
            input = operation
          }
          result = input.details ? await describeKafkaCatalog(runtime, message.action === 'kafka-topics' ? 'topics' : 'groups', input, controller.signal)
            : message.action === 'kafka-topics' ? await listKafkaTopics(runtime, input, controller.signal) : await listKafkaGroups(runtime, input, controller.signal)
        }
        else if (message.action === 'kafka-topic-groups') {
          const input = message.input || {}
          const operation = typeof input.text === 'string' ? parseKafkaCommand(input.text) : { ...input, kind: 'topic-groups' }
          if (operation.kind !== 'topic-groups') throw new Error('TOPIC_GROUPS 命令必需。')
          result = await cachedKafkaInspection(runtime, JSON.stringify(['topic-groups', operation.topic, operation.cursor || '0']), input.refresh, controller.signal,
            () => describeKafkaTopicGroups(runtime, operation.topic, operation, controller.signal))
        }
        else if (message.action === 'kafka-group') {
          const input = message.input || {}
          if (typeof input.text === 'string') {
            const operation = parseKafkaCommand(input.text)
            if (operation.kind === 'group') result = await describeKafkaGroup(runtime, operation.groupId, controller.signal)
            else if (operation.kind === 'group-topics') result = await listKafkaGroupTopics(runtime, operation.groupId, operation, controller.signal)
            else if (operation.kind === 'group-topic') result = await describeKafkaGroupTopic(runtime, operation.groupId, operation.topic, controller.signal)
            else throw new Error('GROUP 命令必需。')
          } else result = await cachedKafkaInspection(runtime, JSON.stringify(['group', input.groupId, input.topic, !!input.summary, !!input.topics, input.cursor]), input.refresh, controller.signal,
            () => input.summary ? describeKafkaGroupSummary(runtime, input.groupId, controller.signal)
              : input.topics === true ? listKafkaGroupTopics(runtime, input.groupId, input, controller.signal)
              : typeof input.topic === 'string' ? describeKafkaGroupTopic(runtime, input.groupId, input.topic, controller.signal)
              : describeKafkaGroup(runtime, input.groupId, controller.signal))
        } else if (message.action === 'kafka-describe') {
          const operation = parseKafkaCommand(message.input?.text)
          if (operation.kind !== 'describe') throw new Error('DESCRIBE 命令必需。')
          result = await cachedKafkaInspection(runtime, JSON.stringify(['describe', operation.topic]), message.input?.refresh, controller.signal,
            () => describeKafkaTopic(runtime, operation.topic, controller.signal))
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
        else parentPort.postMessage({ requestId: message.requestId, result: limitKafkaResult(result), health })
      } catch (error) {
        const category = connectionFailure(error)
        if (['network','authentication','configuration'].includes(category)) health = 'degraded'
        parentPort.postMessage({ requestId: message.requestId, cancelled: controller.signal.aborted, error: safeError(error),
          health: kafkaFailureHealth(error) || health, connectionCategory: category, ...(writeActions.has(message.action) ? { effect: error?.effect || 'none' } : {}) })
        if (error?.recycleWorker) {
          setImmediate(() => process.exit(1))
        }
      } finally { inflight.delete(message.requestId) }
    })
    parentPort.postMessage({ ok: true, ready: true, result: { version: runtime.version, database: '', elapsedMs: Date.now() - started, health: 'ready' } })
  } catch (error) {
    await closeKafka(runtime)
    parentPort.postMessage({ ok: false, ready: false, category: connectionFailure(error), error: safeError(error) })
  }
})

import { parentPort } from 'node:worker_threads'
import { getRedisDataSource } from './data-sources/redis-registry.mjs'
import { nativeErrorText } from './connect-error.mjs'
import { encodeReply } from './data-sources/redis/index.mjs'
import { ErrorReply } from 'redis'

parentPort.once('message', async ({ input, testOnly }) => {
  const started = Date.now()
  const credentials = { ...input }
  const safeError = error => nativeErrorText(error, 'Redis 请求失败。')
  let client, health = 'offline'
  const inflight = new Map()
  try {
    const provider = getRedisDataSource(input.dialect)
    provider.connection.validateTarget(input.database, input)
    client = await provider.driver.open(credentials)
    const probed = await provider.driver.probe(client, credentials)
    input.password = ''; input.caPem = ''
    if (testOnly) {
      await provider.driver.close(client)
      parentPort.postMessage({ ok: true, ready: true, result: { ...probed, elapsedMs: Date.now() - started } })
      return
    }
    health = 'ready'
    const databases = await provider.driver.databases(client, credentials)
    const extras = new Map()
    const databaseId = value => {
      const id = String(value ?? '0')
      if (!/^(0|[1-9]\d{0,4})$/.test(id) || Number(id) > 65535) throw new Error('Redis DB 编号必须为 0–65535。')
      return id
    }
    const homeDatabase = databaseId(credentials.database)
    const closeExtras = async () => {
      const pending = [...extras.values()]
      extras.clear()
      await Promise.all(pending.map(async item => { try { await provider.driver.close(await item) } catch { /* already closed */ } }))
    }
    const clientFor = async requested => {
      const wanted = databaseId(requested === undefined || requested === null || requested === '' ? homeDatabase : requested)
      if (wanted === homeDatabase) return client
      const cached = extras.get(wanted)
      if (cached) return cached
      const opening = provider.driver.open({ ...credentials, database: wanted })
      extras.set(wanted, opening)
      try {
        const opened = await opening
        if (extras.get(wanted) !== opening) { await provider.driver.close(opened); return extras.get(wanted) }
        extras.set(wanted, opened)
        opened.on?.('end', () => { if (extras.get(wanted) === opened) extras.delete(wanted) })
        for (const [id, extra] of extras) {
          if (id === wanted) continue
          extras.delete(id)
          void Promise.resolve(extra).then(other => provider.driver.close(other)).catch(() => {})
        }
        return opened
      } catch (error) {
        if (extras.get(wanted) === opening) extras.delete(wanted)
        throw error
      }
    }
    client.on('end', () => { health = 'degraded'; parentPort.postMessage({ health }) })
    const heartbeat = setInterval(async () => {
      if (health !== 'ready') return
      try { await provider.driver.probe(client, credentials) }
      catch { health = 'degraded'; parentPort.postMessage({ health }) }
    }, 30_000)
    heartbeat.unref()
    parentPort.on('close', () => { clearInterval(heartbeat); void provider.driver.close(client); void closeExtras() })
    parentPort.on('message', async message => {
      if (message.cancel && message.requestId) { inflight.get(message.requestId)?.abort(); return }
      if (!message.requestId) return
      const controller = new AbortController()
      inflight.set(message.requestId, controller)
      let isolated
      const abort = () => { if (isolated) void provider.driver.close(isolated) }
      controller.signal.addEventListener('abort', abort, { once: true })
      try {
        let result
        if (message.action === 'revive' || message.action === 'reconnect') {
          const fresh = await provider.driver.revive(credentials)
          const checked = await provider.driver.probe(fresh, credentials)
          const listed = await provider.driver.databases(fresh, credentials)
          await closeExtras()
          await provider.driver.close(client)
          client = fresh; health = 'ready'
          client.on('end', () => { health = 'degraded'; parentPort.postMessage({ health }) })
          result = { ...checked, databases: listed, health }
        } else if (message.action === 'redis-command') {
          isolated = await provider.driver.open(provider.driver.commandCredentials(credentials, message.input?.database))
          if (controller.signal.aborted) throw new Error('请求已取消。')
          const startedCommand = Date.now()
          const reply = await provider.driver.execute(isolated, message.input.args)
          result = { ...encodeReply(reply), elapsedMs: Date.now() - startedCommand }
        } else if (message.action === 'redis-scan') {
          if (health !== 'ready') throw new Error('Redis 连接已断开，请重连。')
          result = await provider.driver.scan(await clientFor(message.input?.database), message.input)
        } else if (message.action === 'redis-key-suggest') {
          if (health !== 'ready') throw new Error('Redis 连接已断开，请重连。')
          result = await provider.driver.suggestKeys(await clientFor(message.input?.database), message.input, controller.signal)
        } else if (message.action === 'redis-key') {
          if (health !== 'ready') throw new Error('Redis 连接已断开，请重连。')
          result = await provider.driver.key(await clientFor(message.input?.database), message.input)
        } else throw new Error('此操作尚未开放。')
        if (controller.signal.aborted) parentPort.postMessage({ requestId: message.requestId, cancelled: true, error: '执行结果未知，请核验。' })
        else parentPort.postMessage({ requestId: message.requestId, result, health })
      } catch (error) {
        const uncertain = message.action === 'redis-command' && /ECONN|Socket|closed|disconnect|timeout|timed out|Abort/i.test(String(error?.message || ''))
        if (message.action === 'redis-command' && error instanceof ErrorReply && !controller.signal.aborted) parentPort.postMessage({ requestId: message.requestId, result: { result: { type: 'error', value: safeError(error) }, failed: true, elapsedMs: 0 }, health })
        else parentPort.postMessage({ requestId: message.requestId, error: uncertain ? 'Redis 命令连接中断，执行结果未知，请核验。' : safeError(error), cancelled: controller.signal.aborted, health })
      } finally {
        controller.signal.removeEventListener('abort', abort)
        inflight.delete(message.requestId)
        await provider.driver.close(isolated)
      }
    })
    parentPort.postMessage({ ok: true, ready: true, result: { ...probed, databases, elapsedMs: Date.now() - started, health } })
  } catch (error) {
    input.password = ''; input.caPem = ''
    await client?.destroy()
    parentPort.postMessage({ ok: false, ready: false, error: nativeErrorText(error, '连接失败，请检查连接配置与账号权限。') })
  }
})

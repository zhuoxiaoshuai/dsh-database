import { connectionFailure } from './connection-failure.mjs'
import { parentPort } from 'node:worker_threads'
import { NacosHttpClient } from './data-sources/nacos/http-client.mjs'
import { ConfigurationService } from './data-sources/nacos/configuration-service.mjs'
import { NamingService } from './data-sources/nacos/naming-service.mjs'
parentPort.once('message', async ({input, testOnly}) => {
  const started = Date.now(), client = new NacosHttpClient({...input})
  input.password = ''
  const configurations = new ConfigurationService(client), naming = new NamingService(client), inflight = new Map()
  try {
    if (client.input.password) await client.login()
    else await client.request('/v1/console/health/liveness', {text: true})
    let health = 'ready'
    let probing = false
    const heartbeat = !testOnly && setInterval(async () => {
      if (health !== 'ready' || inflight.size || probing) return
      probing = true
      try {await client.request('/v1/console/health/liveness', {text:true})}
      catch (error) {const category = connectionFailure(error); if (['network','authentication','configuration'].includes(category)) {health = 'degraded'; parentPort.postMessage({health,category})}}
      finally {probing = false}
    },30_000)
    if (heartbeat) {heartbeat.unref(); parentPort.on('close', () => clearInterval(heartbeat))}
    const ready = {version: '2.4.3 API', database: client.input.database || '', elapsedMs: Date.now() - started}
    if (!testOnly) parentPort.on('message', async message => {
      if (message.cancel) {inflight.get(message.requestId)?.abort(); return}
      if (!message.requestId) return
      const controller = new AbortController(); inflight.set(message.requestId, controller)
      const signal = controller.signal
      try {
        let result
        if (['revive','reconnect'].includes(message.action)) { await client.login(signal); await client.request('/v1/console/health/liveness', {text: true, signal}); health = 'ready'; result = {...ready,health} }
        else if (message.action === 'nacos-health') { await client.request('/v1/console/health/liveness', {text: true,signal}); result = {ok: true} }
        else if (message.action === 'nacos-write') result = await configurations.write(message.input, signal)
        else if (['nacos-services','nacos-service','nacos-instances'].includes(message.action)) result = await naming.read(message.action,message.input,signal)
        else result = await configurations.read(message.action,message.input,signal)
        parentPort.postMessage({requestId: message.requestId, result, health})
      } catch (e) {
        const category = connectionFailure(e)
        if (['network','authentication','configuration'].includes(category)) health = 'degraded'
        const definite = ['authentication','permission','invalid','conflict','not-found'].includes(e.code)
        parentPort.postMessage({requestId: message.requestId, error: e.message || 'Nacos 请求失败。', category:e.code, connectionCategory:category, health, effect: definite ? 'none' : undefined, phase:definite ? 'execute' : 'receipt', cancelled:signal.aborted})
      } finally {inflight.delete(message.requestId)}
    })
    parentPort.postMessage({ok:true,ready:true,result:{...ready,health:'ready'}})
  } catch (e) {parentPort.postMessage({ok:false,ready:false,category:connectionFailure(e),error:e.message || 'Nacos 连接失败。'})}
})

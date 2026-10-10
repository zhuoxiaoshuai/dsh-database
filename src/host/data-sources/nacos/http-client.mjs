import { nacosEndpoint } from '../../../shared/data-sources/nacos-endpoints.mjs'
import {request as httpsRequest} from 'node:https'
import {getCACertificates} from 'node:tls'
import {Readable} from 'node:stream'

// Node's default fetch trust does not necessarily include the OS certificate store.
// Use native HTTPS with explicit system/default trust, keeping response handling below shared.
function systemHttpsFetch() {
  const ca=[...new Set([...getCACertificates('default'),...getCACertificates('system')])]
  return (url,init)=>new Promise((resolve,reject)=>{
    const request=httpsRequest(url,{method:init.method,headers:init.headers,signal:init.signal,ca},response=>{
      const status=response.statusCode || 0
      resolve({status,ok:status>=200&&status<300,body:Readable.toWeb(response)})
    })
    request.once('error',reject)
    request.end(init.body?.toString())
  })
}

export class NacosError extends Error {
  constructor(code, message) { super(message); this.code = code }
}
const error = (code, message) => new NacosError(code, message)
export class NacosHttpClient {
  constructor(input, options = {}) {
    this.input = input; this.base = nacosEndpoint(input); this.fetch = options.fetch || (input.protocol==='https' ? systemHttpsFetch() : globalThis.fetch)
    this.timeoutMs = options.timeoutMs ?? 8000; this.token = ''; this.refreshing = undefined
  }
  async login(signal) {
    if (signal?.aborted) throw error('cancelled', 'Nacos 请求已取消。')
    if (!this.input.password) return
    if (!this.refreshing) this.refreshing = this.request('/v1/auth/login', {method: 'POST', login: true,
      body: {username: this.input.username, password: this.input.password}}).then(data => {
      if (!data?.accessToken) throw error('authentication', 'Nacos 登录未返回访问令牌。')
      this.token = data.accessToken
    }).finally(() => { this.refreshing = undefined })
    // Each caller can leave independently; the shared refresh still has its own timeout.
    if (!signal) {await this.refreshing; return}
    await new Promise((resolve,reject) => {
      const abort=()=>reject(error('cancelled','Nacos 请求已取消。'))
      signal.addEventListener('abort',abort,{once:true})
      this.refreshing.then(resolve,reject).finally(()=>signal.removeEventListener('abort',abort))
      if(signal.aborted) abort()
    })
  }
  async request(path, options = {}) {
    if (!/^\/v[12]\//.test(path) || path.includes('..') || path.includes('?')) throw error('invalid', 'Nacos 接口路径无效。')
    const method = options.method || 'GET', url = new URL(this.base + path)
    for (const [key, value] of Object.entries(options.query || {})) if (value !== undefined) url.searchParams.set(key, String(value))
    if (this.token && !options.login) url.searchParams.set('accessToken', this.token)
    const timeout = AbortSignal.timeout(this.timeoutMs)
    const signal = options.signal ? AbortSignal.any([options.signal, timeout]) : timeout
    let response
    try {
      response = await this.fetch(url, {method, redirect: 'manual', signal,
        headers: {...(options.body ? {'content-type': 'application/x-www-form-urlencoded'} : {}), ...options.headers},
        body: options.body ? new URLSearchParams(options.body) : undefined})
    } catch {
      throw error(options.signal?.aborted ? 'cancelled' : timeout.aborted ? 'timeout' : 'network', options.signal?.aborted ? 'Nacos 请求已取消。' : timeout.aborted ? 'Nacos 请求超时。' : 'Nacos 网络请求失败。')
    }
    if (response.status >= 300 && response.status < 400) {
      await response.body?.cancel()
      throw error('redirect', 'Nacos 不允许重定向，请检查连接地址。')
    }
    if (response.status === 401 && method === 'GET' && !options.login && !options.retried && this.input.password) {
      await response.body?.cancel(); await this.login(options.signal)
      return this.request(path, {...options, retried: true})
    }
    const reader = response.body?.getReader(); let text = '', size = 0
    if (reader) {
      const decoder = new TextDecoder()
      try { for (;;) { const part = await reader.read(); if (part.done) break; size += part.value.byteLength
        if (size > 2 * 1024 * 1024) { await reader.cancel(); throw error('too-large', 'Nacos 响应超过 2 MiB。') }
        text += decoder.decode(part.value, {stream: true})
      } text += decoder.decode() } catch (e) { if (e instanceof NacosError) throw e; throw error(options.signal?.aborted ? 'cancelled' : timeout.aborted ? 'timeout' : 'network', 'Nacos 响应读取失败。') }
      finally { reader.releaseLock() }
    } else {text = await response.text(); if (new TextEncoder().encode(text).byteLength > 2 * 1024 * 1024) throw error('too-large','Nacos 响应超过 2 MiB。')}
    if (response.ok && options.allowMissing && !text.trim()) return null
    let data; try {data=JSON.parse(text)} catch {
      if(response.ok){if(options.text)return text;throw error('response','Nacos 返回无效响应。')}
    }
    const expired = [text.trim(),data?.message].some(value=>typeof value==='string' && /^(?:token expired!?|expired token!?)$/i.test(value))
    if(response.status===403 && expired && method==='GET' && !options.login && !options.retried && this.input.password){await this.login(options.signal);return this.request(path,{...options,retried:true})}
    if(!response.ok){
      const code=response.status===401 || expired?'authentication':response.status===403?'permission':response.status===404?'not-found':response.status===409 || data?.code===20005?'conflict':response.status===405?'unsupported':response.status===400?'invalid':'remote'
      throw error(code,code==='conflict'?'配置版本冲突，请重新读取并查看差异。':`${options.login?'Nacos 登录失败':'Nacos 请求失败'}（HTTP ${response.status}）。`)
    }
    if (typeof data?.code === 'number' && data.code !== 0 && data.code !== 200) {
      throw error(data.code === 409 || data.code === 20005 ? 'conflict' : 'remote', 'Nacos 拒绝请求，请重新读取目标或检查账号权限。')
    }
    return data && typeof data === 'object' && 'data' in data ? data.data : data
  }
}

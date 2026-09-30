import type { IncomingMessage, ServerResponse } from 'node:http'
import type { Context } from '@deepseek-ai/cordis'
import { ConnectionService } from './connection-service.ts'
import { connectionApi } from './connection-api.ts'
import { ExecutionStore } from './execution-store.ts'
import { hostModules } from './data-sources/modules.ts'
import type { RedactionRule } from './ai-redaction.ts'

interface SessionRegistry { get(id: string): unknown }
interface DatabaseHostContext {
  webServer: { register(input: { kind: 'exact'; path: string; handler(req: IncomingMessage, res: ServerResponse): void }): () => Promise<void> | void }
  connection: { requestRejection(req: IncomingMessage): number | undefined }
  sessions: SessionRegistry
  tools: { register(tool: unknown): void }
  on: unknown
}

export interface DatabaseRegistration { dispose(): Promise<void> }

/** 工作台 HTTP 用对话身份做布局分桶；认证已由 requestRejection 完成。Host sessions.get 只返回已挂活会话，侧栏冷会话也会带合法 conversationId。 */
export function conversationOwnerId(id: string): boolean {
  return typeof id === 'string' && !!id && id.length <= 160
}

export function tryRegisterDatabase(rawContext: Context, workerUrl: URL): DatabaseRegistration {
  try {
    return registerDatabase(rawContext, workerUrl)
  } catch (error) {
    console.warn('[database] 数据库模块未能启动。', error)
    return { async dispose() {} }
  }
}

export function registerDatabase(rawContext: Context, workerUrl: URL, options?: { rules?: RedactionRule[] }): DatabaseRegistration {
  const ctx = rawContext as unknown as DatabaseHostContext
  const liveOwner = (id: string) => {
    if (!conversationOwnerId(id)) return false
    try { return !!ctx.sessions.get(id) } catch { return false }
  }
  // 执行记录改异步落盘：序列化留在调用线程，写盘排队执行，工具链路不再被同步 IO 切碎
  const executions = new ExecutionStore(undefined, 'async')
  const service = new ConnectionService(conversationOwnerId, undefined, workerUrl, undefined, executions)
  let stopApi: () => Promise<void> | void = () => {}
  let stopRemoved = () => {}
  try {
    stopApi = ctx.webServer.register({
      kind: 'exact',
      path: '/plugins/database/connections',
      handler(req, res) {
        const send = (status: number, body: unknown) => {
          res.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store' })
          res.end(JSON.stringify(body))
        }
        const rejection = ctx.connection.requestRejection(req)
        if (rejection !== undefined) { send(rejection, { error: rejection === 401 || rejection === 403 ? '需要通过 DSH 认证访问，请刷新工作台。' : '请求被拒绝，请刷新工作台。' }); return }
        const owner = new URL(req.url || '', 'http://localhost').searchParams.get('conversationId') || ''
        if (!conversationOwnerId(owner)) { send(404, { error: '当前对话已失效，请刷新工作台。' }); return }
        void connectionApi(service, executions, owner, req, res)
      },
    })
    stopRemoved = (ctx.on as Function)('api-session/removed', (id: string) => { void service.releaseOwner(id) }) as () => void
    const registered = new Map<string, unknown>()
    for (const id of hostModules.ids()) {
      const ai = hostModules.get(id).ai
      const previous = registered.get(ai.key)
      if (previous && previous !== ai.register) throw new Error(`AI 工具组重复且实现不一致：${ai.key}`)
      if (previous) continue
      registered.set(ai.key, ai.register)
      ai.register(ctx, service, executions, liveOwner, options?.rules || [])
    }
  } catch (error) {
    stopRemoved()
    void Promise.resolve(stopApi()).finally(() => { void service.dispose() })
    throw error
  }
  return {
    async dispose() {
      stopRemoved()
      await stopApi()
      await service.dispose()
    },
  }
}

import type { IncomingMessage, ServerResponse } from 'node:http'
import type { Context } from '@deepseek-ai/cordis'
import type {} from '@deepseek-ai/dsh-client-connection'
import type {} from '@deepseek-ai/dsh-host-webserver'
import type {} from '@deepseek-ai/dsh-session'
import { SessionId } from '@deepseek-ai/dsh-session/types'
import type {} from '@deepseek-ai/dsh-tools'

export const readiness = Object.freeze({
  stage: 'alpha-readonly', executionEnabled: true, maintenanceEnabled: false, releaseAllowed: false, connectionEnabled: true,
  mysql: '8.x target; live verification pending',
  oracle: '19c provisional target; server version and live verification pending',
})

export type HostContext = Context

export function statusForSession(sessions: HostContext['sessions'], sessionId: unknown) {
  if (typeof sessionId !== 'string' || sessionId.length > 160 || !sessionId || !sessions.get(SessionId(sessionId))) throw new Error('请先选择有效的 DSH 对话。')
  return { ...readiness, conversationId: sessionId }
}

export function statusRoute(ctx: HostContext, req: IncomingMessage, res: ServerResponse, runtime?: { available: boolean; error?: string; storageDegraded(): boolean }): void {
  const reject = ctx.connection.requestRejection(req)
  res.setHeader('Cache-Control', 'no-store')
  res.setHeader('Content-Type', 'application/json; charset=utf-8')
  if (reject !== undefined) { res.writeHead(reject); res.end(JSON.stringify({ error: '需要通过 DSH 认证访问。' })); return }
  if (req.method !== 'GET') { res.writeHead(405); res.end(JSON.stringify({ error: '不支持此操作。' })); return }
  try {
    const id = new URL(req.url || '', 'http://localhost').searchParams.get('conversationId')
    const baseline = statusForSession(ctx.sessions, id)
    const status = runtime ? { ...baseline, stage: 'alpha', moduleAvailable: runtime.available,
      executionEnabled: runtime.available, connectionEnabled: runtime.available, maintenanceEnabled: runtime.available,
      storageDegraded: runtime.storageDegraded(), ...(runtime.error ? { moduleError: runtime.error } : {}),
      capabilities: { sql: runtime.available, redis: runtime.available, kafkaReadonly: runtime.available },
      acceptance: { mysql: 'NOT_RUN', oracle: 'NOT_RUN', redis: 'NOT_RUN', kafka: 'NOT_RUN', desktop: 'NOT_RUN', model: 'NOT_RUN' } } : baseline
    res.writeHead(200); res.end(JSON.stringify(status))
  } catch { res.writeHead(404); res.end(JSON.stringify({ error: '请选择有效对话。' })) }
}

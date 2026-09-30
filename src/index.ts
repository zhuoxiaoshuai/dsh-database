import type { Context } from '@deepseek-ai/cordis'
import { registerDatabase, tryRegisterDatabase } from './host/register.ts'
import { statusRoute } from './host-contract.ts'

export const name = 'database'
export const inject = ['connection', 'webServer', 'sessions', 'tools']
export { registerDatabase, tryRegisterDatabase }

export function apply(ctx: Context): void {
  const workerUrl = new URL('./connection-worker.mjs', import.meta.url)
  const registration = tryRegisterDatabase(ctx, workerUrl)
  ctx.effect(() => ctx.webServer.register({ kind: 'exact', path: '/plugins/database/status', handler: (req, res) => statusRoute(ctx, req, res) }), 'database: status route')
  ctx.effect(() => () => { void registration.dispose() }, 'database: dispose')
}

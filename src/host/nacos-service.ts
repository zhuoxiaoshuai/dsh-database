import {validateNacosConfigFormat} from '../shared/nacos-config-format.mjs'
import {normalizeNacosConfigType} from '../shared/nacos-config-types.mjs'
import { createHash, createHmac, randomBytes, timingSafeEqual } from 'node:crypto'
import { applyPublicEdits, protectedConfig, aiProjection } from './data-sources/nacos/config-protection.mjs'
import { runOperation } from './operation-runtime.ts'
import type { Connection } from '../shared/workbench.ts'
import type { ExecutionStore } from './execution-store.ts'
import { NacosPreviewConsumption } from './nacos-preview-consumption.ts'

const digest = (value: unknown) => createHash('sha256').update(JSON.stringify(value)).digest('hex')
export const NACOS_READ_ACTIONS = ['nacos-namespaces', 'nacos-configs', 'nacos-config', 'nacos-history', 'nacos-listeners', 'nacos-services', 'nacos-service', 'nacos-instances'] as const
type Send = (action: string, input: Record<string, unknown>, signal?: AbortSignal, dispatched?: () => void) => Promise<Record<string, any>>
export class NacosService {
  private key = randomBytes(32)
  private executions?: ExecutionStore
  private readonly consumption = new NacosPreviewConsumption()
  constructor(executions?: ExecutionStore) {this.executions = executions}
  async request(owner: string, connection: Connection, action: string, input: Record<string, any>, actor: 'user' | 'ai', send: Send, validate: () => void, signal?: AbortSignal, callId?: string, rootCallId?: string): Promise<any> {
    try {
    validate()
    if(Buffer.byteLength(JSON.stringify(input),'utf8')>524288)throw new Error('Nacos 请求超过 512 KiB，不能提交。')
    if (NACOS_READ_ACTIONS.includes(action as any)) {
      const result = actor === 'ai' ? await runOperation(this.executions, {owner,connectionId:connection.id,generation:connection.generation!,connectionName:connection.name,sourceId:'nacos',environment:connection.environment}, {operation:action,title:action,initiator:actor,type:'tool',callId,rootCallId}, (workSignal, dispatched) => send(action,input,workSignal,dispatched), () => 'Nacos 读取完成。', signal) : await send(action, input, signal)
      validate()
      return actor === 'ai' ? aiProjection(result) : result
    }
    if (!['nacos-preview', 'nacos-write'].includes(action) || !['create','update','delete'].includes(input.kind)) throw new Error('不支持此 Nacos 操作。')
    if (actor === 'ai' && connection.environment !== 'sit') throw new Error('Nacos AI 写入仅在 SIT 开放。')
    if (typeof input.namespaceId !== 'string' || !input.group || !input.dataId) throw new Error('请明确提供 Namespace、Group 和 Data ID。')
    const target = {namespaceId: input.namespaceId, group: input.group, dataId: input.dataId}
    let before: Record<string, any> | undefined
    try { before = await send('nacos-config', target, signal) }
    catch (e) { if (input.kind !== 'create' || (e as {category?: string}).category !== 'not-found') throw e }
    if (input.kind === 'create' ? !!before : !before || !input.expectedMd5 || before.md5 !== input.expectedMd5) throw new Error('配置版本冲突，请重新读取并查看差异。')
    const type = normalizeNacosConfigType(input.type || before?.type || 'text')
    if (actor === 'ai' && input.kind === 'update' && type !== normalizeNacosConfigType(before?.type)) throw new Error('AI 局部修改不能改变配置类型。')
    const content = input.kind === 'delete' ? '' : actor === 'ai' && input.kind === 'update'
      ? applyPublicEdits(before!.content, type, input.edits) : input.content
    if(input.kind!=='delete'&&Buffer.byteLength(JSON.stringify({...target,content,type}),'utf8')>524288)throw new Error('配置变更超过 512 KiB，不能提交。')
    if (input.kind !== 'delete') validateNacosConfigFormat(content, type)
    if (actor === 'ai' && before?.encrypted && input.kind !== 'delete') throw new Error('加密配置只能由人工修改。')
    if (actor === 'ai' && input.kind === 'create') {
      const p = protectedConfig(content, type)
      if (!p.safe || p.ranges.length) throw new Error('AI 新增配置不能包含敏感凭据。')
    }
    const binding = {owner, connectionId: connection.id, generation: connection.generation!, connectionName: connection.name, sourceId: 'nacos', environment: connection.environment}
    const proof = {owner, connectionId: connection.id, generation: connection.generation, actor, ...target, kind: input.kind, md5: before?.md5 || '', hash: digest({content, type})}
    const sign = (text: string) => createHmac('sha256', this.key).update(text).digest('base64url')
    if (action === 'nacos-preview') {
      const encoded = Buffer.from(JSON.stringify({...proof, nonce:randomBytes(16).toString('hex'), expires: Date.now() + 300000})).toString('base64url')
      const preview = {permissionCheck:'remote-at-execution',target, kind: input.kind, before: before?.content || '', after: content, type, expectedMd5: before?.md5 || '', previewToken: `${encoded}.${sign(encoded)}`}
      if (actor === 'ai') return {...preview, before: before?.encrypted ? '[加密配置]' : protectedConfig(preview.before, type).text, after: input.kind === 'delete' ? '' : protectedConfig(content, type).text}
      return preview
    }
    const [encoded, signature, extra] = String(input.previewToken || '').split('.')
    const expected = sign(encoded || '')
    if (!encoded || extra || !signature || signature.length !== expected.length || !timingSafeEqual(Buffer.from(signature), Buffer.from(expected))) throw new Error('缺少有效变更预览，请重新预览。')
    let parsed: any
    try { parsed = JSON.parse(Buffer.from(encoded, 'base64url').toString()) } catch { throw new Error('预览无效。') }
    const {expires, nonce, ...signed} = parsed
    if (!Number.isSafeInteger(expires) || expires <= Date.now() || digest(signed) !== digest(proof)) throw new Error('预览已过期或变更内容已变化，请重新预览。')
    const previewId=digest(input.previewToken)
    validate()
    signal?.throwIfAborted()
    this.consumption.consume(previewId, expires)
    return await runOperation(this.executions, binding, {operation: `nacos_${input.kind}`, title: `${input.kind} ${target.group}/${target.dataId}`, initiator: actor, type: 'tool', callId, rootCallId, context: {...target,previewId,baselineMd5:before?.md5 || '',changeDigest:proof.hash}},
      async (workSignal, markDispatched) => {
        validate()
        if (actor === 'ai' && connection.environment !== 'sit') throw new Error('Nacos AI 写入仅在 SIT 开放。')
        return send('nacos-write', {...target, kind: input.kind, expectedMd5: before?.md5, content, type}, workSignal, markDispatched)
      }, () => 'Nacos 已确认配置变更。', signal, undefined, {
        classifyInterruption: (e, state) => state.dispatched && (e as {effect?: string})?.effect !== 'none' ? 'unknown' : state.aborted && !state.dispatched ? 'cancelled' : 'failed',
        summarizeFailure: (_e, _state, status) => status === 'unknown' ? '配置变更结果未知，请重新读取核对，勿重试原写入。' : _e instanceof Error ? _e.message : 'Nacos 变更失败。',
      })
    } catch (error) {
      // Before the operation lifecycle starts, only validation and baseline reads ran.
      // Give HTTP a definite no-write receipt instead of freezing the UI as unknown.
      if(action==='nacos-write' && !(error as {executionStatus?:string})?.executionStatus) {
        throw Object.assign(error instanceof Error ? error : new Error('Nacos 变更检查失败。'),{effect:'none',phase:'check'})
      }
      throw error
    }
  }
}

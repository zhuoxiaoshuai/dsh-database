import { defineTool } from '@deepseek-ai/dsh-tools'
import type { NacosAiPort } from '../../ai-service-ports.ts'
import type { ExecutionStore } from '../../execution-store.ts'
import { toolOwner, type ToolExecution } from '../../ai-tool-context.ts'
import { resolveAiConnection } from '../../ai-connection-resolve.ts'
import {nacosConfigTypeValues} from '../../../shared/nacos-config-types.mjs'
const output = {schema: {type: 'string' as const}, render: (_: unknown, value: string) => [{type: 'text' as const, text: value}]}
const string = (description = '') => ({type: 'string' as const, required: true, description})
const handle = {
  connectionId: { type: 'string' as const, description: '来自 nacos_status.connections。唯一已登录连接可省略。' },
  generation: { type: 'string' as const, description: '来自 nacos_status.connections。省略则用当前 generation。' },
}
export function registerNacosAiTools(ctx: {tools: {register(tool: unknown): void}}, service: NacosAiPort, _executions: ExecutionStore, validOwner: (id: string) => boolean) {
  ctx.tools.register(defineTool({name: 'nacos_status', description: '先调本工具取 connectionId。配置中心用 nacos_*。', parameters: {}, output,
    async execute(_: unknown, execution: ToolExecution) {
      const owner = toolOwner(execution, validOwner); await service.restoreRemembered(owner)
      const connections = service.list(owner).filter(c => c.dialect === 'nacos').map(c => ({connectionId:c.id,generation:c.generation,name:c.name,environment:c.environment,live:c.live,health:c.health}))
      return JSON.stringify({
        connections,
        help: '先用返回的 connectionId 和 generation 调 nacos_namespaces。唯一已登录连接可省略这两个参数。',
        next: connections.filter(item => item.live).map(item => ({
          tool: 'nacos_namespaces',
          args: { connectionId: item.connectionId, generation: item.generation },
        })),
      })
    }}))
  const selection = { ...handle }
  const target = {...selection, namespaceId: string('使用 Namespace ID，public 明确传空字符串。')}
  const config = {...target, group: string(), dataId: string()}
  const page = {pageNo: {type:'integer' as const}, pageSize: {type:'integer' as const, description:'默认50，最大100。'}}
  const changes: any = {...config, kind:{type:'string',enum:['create','update','delete'],required:true}, expectedMd5:{type:'string',description:'修改和删除必须提供读取时的 MD5。'}, type:{type:'string',enum:nacosConfigTypeValues}, content:{type:'string',description:'仅用于新增，禁止提供敏感凭据或不透明脚本、模板内容。'},
    edits:{type:'array',items:{type:'object',additionalProperties:false,properties:{oldText:{type:'string',required:true},newText:{type:'string',required:true}}},description:'修改只支持非敏感原文的唯一精确匹配替换。'}}
  const entries: [string,string,string,any][] = [
    ['nacos_namespaces','nacos-namespaces','查询连接的 Namespace 列表。',selection],
    ['nacos_search_configs','nacos-configs','按 Namespace、Group 和 Data ID 分页搜索配置。',{...target,group:{type:'string'},dataId:{type:'string'},...page}],
    ['nacos_get_config','nacos-config','读取配置及 MD5；正文脱敏，不支持的格式仅返回元信息。',config],
    ['nacos_config_history','nacos-history','查询历史列表或指定 historyId 的详情。',{...config,historyId:{type:'string'},...page}],
    ['nacos_config_listeners','nacos-listeners','读取监听者及可获得的客户端状态；空列表不代表配置未生效。',config],
    ['nacos_search_services','nacos-services','按 Namespace、Group、服务名分页搜索。',{...target,group:{type:'string'},serviceName:{type:'string'},...page}],
    ['nacos_service_detail','nacos-service','读取服务详情及一个集群的实例分页；缺省使用第一个集群，不扫描其他集群。',{...target,group:string(),serviceName:string(),clusterName:{type:'string'},...page}],
    ['nacos_preview_config_change','nacos-preview','仅 SIT：准备配置变更，必须先向用户展示返回的脱敏差异再执行。',changes],
    ['nacos_publish_config','nacos-write','仅 SIT：执行已预览的新增或修改，必须提供同样的变更和 previewToken；未知结果不能重试。',{...changes,kind:{type:'string',enum:['create','update'],required:true},previewToken:string()}],
    ['nacos_delete_config','nacos-write','仅 SIT：删除已预览的配置，必须提供 MD5 和 previewToken；未知结果不能重试。',{...config,expectedMd5:string(),previewToken:string()}],
  ]
  for (const [name,operation,description,parameters] of entries) ctx.tools.register(defineTool({name,description,parameters,output,
    async execute(args: Record<string,unknown>, execution: ToolExecution) {
      const owner = toolOwner(execution, validOwner)
      const resolved = resolveAiConnection({
        connections: service.list(owner),
        family: 'nacos',
        connectionId: args.connectionId,
        generation: args.generation,
      })
      if (!resolved.ok) return JSON.stringify(resolved)
      const connection = resolved.connection
      const actual = operation
      const input = name === 'nacos_delete_config' ? {...args,kind:'delete'} : name === 'nacos_service_detail' ? {...args,includeInstances:true} : args
      return JSON.stringify(await service.nacosRequest(owner,connection.id,connection.generation,actual,input,'ai',execution.signal,execution.callId,execution.rootCallId))
    }}))
}

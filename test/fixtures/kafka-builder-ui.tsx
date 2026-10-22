import React, { useState } from 'react'
import { createRoot } from 'react-dom/client'
import { StandardSourceMount } from '../../src/client/workspace-sources.tsx'
import { kafkaModule } from '../../src/client/data-sources/kafka.tsx'
import { parseKafkaCommand, isKafkaWrite } from '../../src/shared/kafka-command.mjs'
import '../../src/client/style.css'

const state = { runs: [] as any[], reads: [] as any[], failure: '', hold: '', ignoreAbort: false, failCandidates: false, delayCandidates: false, releaseRun: undefined as (() => void) | undefined, releaseCandidates: undefined as (() => void) | undefined }
const pause = (milliseconds: number) => new Promise(done => setTimeout(done, milliseconds))
let document = { sourceId: 'kafka', text: '', context: {}, revision: 1, controller: 'ai' }
const bridge: any = {
  mode: 'host', tables: () => [],
  executeText: async (connection: any, text: string, _context: unknown, signal: AbortSignal) => {
    const op = parseKafkaCommand(text) as any
    state.runs.push({ text, generation: connection.generation })
    const executionId = `ui-${state.runs.length}`
    if (state.hold === op.kind) {
      state.hold = ''
      await new Promise<void>((resolve, reject) => {
        state.releaseRun = resolve
        if (!state.ignoreAbort) signal.addEventListener('abort', () => reject(Object.assign(new Error('执行已停止'), {effect:isKafkaWrite(op.kind)?'unknown':'none',executionStatus:isKafkaWrite(op.kind)?'unknown':'cancelled'})), {once:true})
      })
    }
    const executionStatus = state.failure.startsWith(`${op.kind}:`) ? state.failure.split(':')[1] : 'succeeded'
    await pause(15)
    return { kind: op.kind, executionId, executionStatus, topic: op.topic, groupId: op.groupId,
      ...(op.kind === 'topics' ? {topics:['orders','other'],complete:true} : {}),
      ...(op.kind === 'groups' ? {groups:['billing'],complete:true} : {}),
      ...(op.kind === 'describe' ? {partitions:[{partition:0,low:'0',high:'9',leader:1,replicas:[1],isr:[1]}]} : {}),
      ...(op.kind === 'peek' ? {messages:[{offset:'0',timestamp:'1',key:{kind:'null',length:0},value:{kind:'text',length:op.topic.length,text:op.topic},headers:{}}],complete:true,reason:'end',partition:0} : {}),
      ...(op.kind === 'scan' ? {messages:[],complete:true,reason:'end'} : {}),
      ...(op.kind === 'produce' || op.kind === 'tombstone' ? {partition:0,baseOffset:'9007199254740993',acknowledged:true,valueBytes:1} : {}),
      ...(op.kind === 'produce-batch' ? {status:executionStatus,receipts:[{index:0,partition:0,baseOffset:'10',acknowledged:true}]} : {}),
      ...(op.kind === 'group' ? {state:'Empty',members:[]} : {}),
    }
  },
  explorer: async (_connection: any, action: string, input: any, signal?: AbortSignal) => {
    state.reads.push({action,input,generation:_connection.generation})
    if (state.delayCandidates && action === 'list') {
      state.delayCandidates = false
      await new Promise<void>(resolve => {state.releaseCandidates=resolve})
      return {nodes:[{ref:'topic:stale',title:'STALE_CANDIDATE',kind:'topic'}],complete:true}
    }
    if (state.failCandidates) throw new Error('模拟候选读取失败，可手工输入。')
    if (action === 'read') {
      if (input.ref.startsWith('gtopic:')) return {kind:'group-topic',groupId:'billing',topic:'orders',state:'Empty',partitions:[{partition:0,current:'9007199254740993',status:'normal'},{partition:1,current:null,status:'uncommitted'}]}
      if (input.ref.startsWith('group:')) return {kind:'group',groupId:'billing',state:'Empty',members:[]}
      return {kind:'describe',topic:'orders',partitions:[{partition:0,leader:1,replicas:[1],isr:[1],low:'0',high:'9'},{partition:1,leader:1,replicas:[1],isr:[1],low:'0',high:'9'}]}
    }
    const group = input.parent === 'folder:groups'
    const names = group ? ['billing'] : input.cursor ? ['page-two'] : ['orders','other']
    return {nodes:names.filter(name=>!input.search||name.includes(input.search)).map(name=>({ref:`${group?'group':'topic'}:${name}`,title:name,kind:group?'group':'topic',hasChildren:false})),nextCursor:!group&&!input.cursor&&!input.search?'2':undefined,complete:group||!!input.cursor}
  },
  executions: async (action: string, input: any) => {
    if (action === 'execution-wait') {await pause(500);return {items:[],events:[],revision:0}}
    if (action === 'execution-document-get') return {document}
    if (action === 'execution-document-update') {document={...document,text:input.text,revision:document.revision+1,controller:'user'};return {document}}
    return {items:[]}
  },
  templates: async () => ({items:[]}),
}
function Fixture() {
  const [generation, setGeneration] = useState('g1'), [environment, setEnvironment] = useState('sit'), [live, setLive] = useState(true)
  const connection = {id:'kafka-builder',dialect:'kafka',name:'Kafka builder fixture',generation,environment,database:'',live,health:live?'ready':'closed'}
  ;(window as any).kafkaBuilderFixture = {state, resetRuns:()=>{state.runs=[];state.failure=''}, reconnect:()=>setGeneration(value=>`${value}x`), setEnvironment, disconnect:()=>setLive(false)}
  return <div className="db-workbench" style={{height:'100vh'}}><StandardSourceMount module={kafkaModule} context={{host:bridge,connection,catalogRoot:'topics',refreshToken:0} as any} /></div>
}
createRoot(window.document.getElementById('app')!).render(<Fixture />)

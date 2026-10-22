import assert from 'node:assert/strict'
import { mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises'
import { resolve, join, sep } from 'node:path'
import { Kafka, logLevel } from 'kafkajs'
import { withKafkaFixture } from './kafka-fixture.mjs'
import { ConnectionService } from '../src/host/connection-service.ts'
import { ExecutionStore } from '../src/host/execution-store.ts'
import { memoryPasswordProtector } from '../src/host/saved-connections.ts'
import { generateKafkaCommand, newBuilderDraft } from '../src/client/kafka/builder-model.ts'
import { createKafkaBatch, runKafkaBatch } from '../src/shared/kafka-batch.ts'

const output=resolve('artifacts/kafka-command-builder')
await mkdir(output,{recursive:true})
const report=await withKafkaFixture(async fixture=>{
  const directory=await mkdtemp(join(output,'runtime-'))
  const executions=new ExecutionStore(directory)
  const service=new ConnectionService(()=>true,directory,undefined,memoryPasswordProtector,executions)
  const kafka=new Kafka({clientId:'kafka-builder-acceptance',brokers:fixture.brokers,logLevel:logLevel.ERROR})
  const admin=kafka.admin()
  const topic=`dsh-test-builder-${Date.now()}`,groupId=`dsh-builder-${Date.now()}`
  let consumer
  try{
    await admin.connect()
    const connection=await service.open('builder-owner',{name:'Builder isolated broker',dialect:'kafka',brokers:fixture.brokers,tls:false,saslMechanism:'none',environment:'sit'},false)
    const command=(kind,patch)=>{
      const draft=Object.assign(newBuilderDraft(kind),{topic,groupId},patch)
      const generated=generateKafkaCommand(kind,draft)
      assert.deepEqual(generated.errors,{})
      return generated.command
    }
    const produce=newBuilderDraft('produce');produce.topic=topic;produce.message.keyEnabled=true;produce.message.key.value='builder-key';produce.message.value.value='line one\nline two; "quoted"'
    const script=[command('create-topic',{}),generateKafkaCommand('produce',produce).command,command('peek',{from:'beginning',limit:'1'}),command('describe',{})].join('\n')
    const steps=await runKafkaBatch({steps:createKafkaBatch(script),signal:new AbortController().signal,execute:(text,signal)=>service.executeText('builder-owner',connection.id,connection.generation,text,signal)})
    assert.deepEqual(steps.map(step=>step.status),['succeeded','succeeded','succeeded','succeeded'])
    assert.equal(steps[2].result.messages[0].value.text,produce.message.value.value)
    assert.equal(new Set(steps.map(step=>step.executionId)).size,4)
    assert.equal(executions.list('builder-owner').length,4)
    consumer=kafka.consumer({groupId})
    await consumer.connect();await consumer.subscribe({topic,fromBeginning:true});await consumer.run({autoCommit:false,eachMessage:async()=>{}});await consumer.disconnect()
    const offsets=newBuilderDraft('set-group-offsets');offsets.topic=topic;offsets.groupId=groupId;offsets.targetMode='offset';offsets.partitions[0]={partition:'0',expected:'',uncommitted:true,offset:'0'}
    const shifted=await runKafkaBatch({steps:createKafkaBatch(generateKafkaCommand('set-group-offsets',offsets).command),signal:new AbortController().signal,execute:(text,signal)=>service.executeText('builder-owner',connection.id,connection.generation,text,signal)})
    assert.equal(shifted[0].status,'succeeded');assert.equal(shifted[0].result.after['0'],'0')
    const verified=await admin.fetchOffsets({groupId,topics:[topic]})
    assert.equal(verified[0].partitions[0].offset,'0')
    return {status:'PASS',generatedCommands:true,sequentialHostWorker:true,exactMessageReadback:true,independentExecutionIds:true,oneHistoryRecordPerCommand:true,offsetChangeReadback:true,fixture:fixture.id}
  }finally{
    await service.dispose();executions.dispose()
    await consumer?.disconnect().catch(()=>{})
    await admin.deleteGroups([groupId]).catch(()=>{});await admin.deleteTopics({topics:[topic]}).catch(()=>{});await admin.disconnect().catch(()=>{})
    if(!directory.startsWith(output+sep))throw new Error('Runtime cleanup path escaped acceptance output')
    await rm(directory,{recursive:true,force:true})
  }
})
await writeFile(join(output,'broker-report.json'),JSON.stringify(report,null,2))
console.log(JSON.stringify(report))

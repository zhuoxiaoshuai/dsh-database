import test from 'node:test'
import assert from 'node:assert/strict'
import { generateKafkaCommand, kafkaBuilderOperations, messageDraft, newBuilderDraft } from '../src/client/kafka/builder-model.ts'
import { parseKafkaCommand, kafkaBytes } from '../src/shared/kafka-command.mjs'
import { kafkaBytes as hostBytes } from '../src/host/data-sources/kafka/command.mjs'
import { createKafkaBatch, splitKafkaCommands, kafkaWriteSummary, runKafkaBatch } from '../src/shared/kafka-batch.ts'
import { connectionBridge } from '../src/client/connection-bridge.ts'

function validDraft(kind) {
  const draft = newBuilderDraft(kind)
  draft.topic = kind === 'create-topic' ? 'dsh-test-events' : '订单 "quoted"\\path'
  draft.groupId = 'billing'; draft.time = '2026-10-16T12:00:00'
  draft.partitions[0].expected = '9007199254740993'
  draft.partitions[0].offset = '9007199254740994'
  draft.message.key.value = 'key'
  return draft
}
for (const {kind} of kafkaBuilderOperations) test(`Kafka builder generates valid ${kind} with shared syntax`, () => {
  const generated = generateKafkaCommand(kind, validDraft(kind))
  assert.deepEqual(generated.errors, {})
  assert.equal(parseKafkaCommand(generated.command).kind, kind)
})

test('shared byte codec matches Host Buffer bytes, rejects noncanonical Base64 and counts UTF-8', () => {
  for (const value of ['中文😀', '', {base64:'AP9h'}, {base64:''}]) assert.deepEqual([...kafkaBytes(value, 'test')], [...hostBytes(value, 'test')])
  assert.ok(Buffer.isBuffer(hostBytes('hello', 'test')))
  assert.equal(hostBytes(null, 'test', {nullable:true}), null)
  assert.throws(() => kafkaBytes({base64:'AB=='}, 'test'), /Base64/)
  assert.throws(() => parseKafkaCommand(`PRODUCE ${JSON.stringify({topic:'x',value:'文'.repeat(22000)})}`), /64 KiB/)
})

test('forms preserve empty versus omitted fields and group repeated Header values safely', () => {
  const draft = validDraft('produce')
  draft.message.value.value = '{"a":1};\nhello'
  draft.message.key.value = ''
  let op = parseKafkaCommand(generateKafkaCommand('produce', draft).command)
  assert.equal(op.key, undefined); assert.equal(op.value, '{"a":1};\nhello')
  draft.message.keyEnabled = true; draft.message.headersEnabled = true
  draft.message.headers = [{name:'__proto__',bytes:{encoding:'utf8',value:'a'}},{name:'__proto__',bytes:{encoding:'base64',value:'AP8='}}]
  op = parseKafkaCommand(generateKafkaCommand('produce', draft).command)
  assert.equal(op.key, '')
  assert.deepEqual(op.headers.__proto__, ['a',{base64:'AP8='}])
  draft.message.headersEnabled = false
  assert.equal(parseKafkaCommand(generateKafkaCommand('produce', draft).command).headers, undefined)
})

test('offset forms retain large string offsets, ignore hidden mode fields and distinguish uncommitted', () => {
  const draft = validDraft('set-group-offsets'); draft.targetMode = 'offset'
  let generated = generateKafkaCommand('set-group-offsets', draft)
  let op = parseKafkaCommand(generated.command)
  assert.deepEqual(op.expected, {'0':'9007199254740993'}); assert.deepEqual(op.offsets, {'0':'9007199254740994'})
  assert.equal(op.timestamp, undefined)
  draft.partitions[0].expected = ''; assert.ok(generateKafkaCommand('set-group-offsets', draft).errors['partitions.0.expected'])
  draft.partitions[0].uncommitted = true; op = parseKafkaCommand(generateKafkaCommand('set-group-offsets', draft).command)
  assert.equal(op.expected['0'], null)
  draft.targetMode = 'time'; draft.partitions[0].offset = 'invalid'
  assert.deepEqual(generateKafkaCommand('set-group-offsets', draft).errors, {})
  draft.partitions.push({...draft.partitions[0]}); assert.ok(generateKafkaCommand('set-group-offsets', draft).errors.partitions)
})

test('builder validates malformed bytes, numeric fields, batch size and replay data', () => {
  const draft = validDraft('produce')
  draft.message.value = {encoding:'base64',value:'bad'}
  assert.ok(generateKafkaCommand('produce', draft).errors['message.value'])
  draft.message = messageDraft(); draft.message.replayEnabled = true
  assert.ok(generateKafkaCommand('produce', draft).errors['message.replayOffset'])
  draft.messages = Array.from({length:11}, messageDraft)
  assert.ok(generateKafkaCommand('produce-batch', draft).errors.messages)
  draft.message = messageDraft(); draft.message.value.value = 'x'.repeat(65537)
  assert.match(generateKafkaCommand('produce', draft).errors['message.value'], /64 KiB/)
  draft.partition = ''; assert.ok(generateKafkaCommand('peek', draft).errors.partition)
  draft.offset = 'abc'; draft.from = 'offset'; assert.ok(generateKafkaCommand('peek', draft).errors.offset)
})

test('Kafka command boundaries handle escaped text, CRLF, semicolons and pretty JSON', () => {
  const source = 'TOPICS;\r\nPRODUCE {\n"topic":"x",\n"value":"hello; \\\"[}]\\\"\\nnext"\n}\n\nGROUP "b" TOPICS;'
  const commands = splitKafkaCommands(source)
  assert.equal(commands.length, 3)
  for (const command of commands) assert.equal(source.slice(command.from, command.to), command.text)
  assert.equal(commands[1].operation.value, 'hello; "[}]"\nnext')
  for (const invalid of ['TOPICS\nPRODUCE {', 'TOPICS\nGROUP "b', 'TOPICS\nDESCRIBE', 'TOPICS\nPRODUCE {"topic":"x","value":"a"]']) assert.throws(() => createKafkaBatch(invalid), /行/)
  assert.throws(() => createKafkaBatch('TOPICS\n'.repeat(51)), /最多执行 50/)
  assert.throws(() => createKafkaBatch('x'.repeat(524289)), /512 KiB/)
  assert.throws(() => createKafkaBatch(' ;\n'), /输入/)
})

test('batch awaits every receipt, executes in order and preserves snapshots', async () => {
  const planned = createKafkaBatch('TOPICS\nGROUPS'), calls = []
  let release
  const waiting = new Promise(done => { release = done })
  const result = runKafkaBatch({steps:planned,signal:new AbortController().signal,execute:async text => {calls.push(text); if(text==='TOPICS')await waiting; return {kind:text.toLowerCase(),executionStatus:'succeeded',executionId:text}}})
  assert.deepEqual(calls,['TOPICS']); release()
  const steps = await result
  assert.deepEqual(calls,['TOPICS','GROUPS']); assert.deepEqual(steps.map(step=>step.status),['succeeded','succeeded'])
  assert.deepEqual(planned.map(step=>step.status),['pending','pending'])
})

for (const outcome of ['failed','unknown','cancelled']) test(`batch stops after ${outcome} even when promise resolves`, async () => {
  const calls=[]
  const steps=await runKafkaBatch({steps:createKafkaBatch('TOPICS\nGROUPS'),signal:new AbortController().signal,execute:async text=>{calls.push(text);return {executionStatus:outcome}}})
  assert.deepEqual(calls,['TOPICS']); assert.deepEqual(steps.map(step=>step.status),[outcome,'skipped'])
})

test('batch stops on missing receipts, transport uncertainty and partial batch publication', async () => {
  for (const execute of [async()=>({kind:'topics'}),async()=>{throw Object.assign(new Error('network'),{effect:'unknown',trustedReceipt:false,executionStatus:'failed'})},async()=>({kind:'produce-batch',executionStatus:'unknown',receipts:[{index:0,acknowledged:true}]})]) {
    const steps=await runKafkaBatch({steps:createKafkaBatch('PRODUCE_BATCH {"topic":"x","messages":[{"value":"a"}]}\nTOPICS'),signal:new AbortController().signal,execute})
    assert.equal(steps[0].status,'unknown');assert.equal(steps[1].status,'skipped')
  }
})

test('stop does not discard a trustworthy success and does not dispatch the next command', async () => {
  const controller=new AbortController()
  const steps=await runKafkaBatch({steps:createKafkaBatch('PRODUCE {"topic":"x","value":"a"}\nTOPICS'),signal:controller.signal,execute:async()=>{controller.abort();return {executionStatus:'succeeded',acknowledged:true}}})
  assert.deepEqual(steps.map(step=>step.status),['succeeded','skipped'])
})

test('aborted write without a receipt stays unknown; before-dispatch cancellation stays cancelled', async () => {
  for (const dispatched of [true,false]) {
    const controller=new AbortController()
    const steps=await runKafkaBatch({steps:createKafkaBatch('PRODUCE {"topic":"x","value":"a"}\nTOPICS'),signal:controller.signal,execute:async()=>{controller.abort();throw Object.assign(new Error('aborted'),dispatched?{}:{effect:'none'})}})
    assert.deepEqual(steps.map(step=>step.status),[dispatched?'unknown':'cancelled','skipped'])
  }
})

test('write confirmation lists all targets in order without copying message contents', () => {
  const summary=kafkaWriteSummary(createKafkaBatch('TOPICS\nPRODUCE {"topic":"x","value":"PRIVATE_BODY"}\nCREATE_TOPIC {"topic":"dsh-test-a","partitions":1,"replicationFactor":1,"cleanupPolicy":"delete"}')).join('\n')
  assert.match(summary,/2\. PRODUCE/);assert.match(summary,/3\. CREATE_TOPIC/);assert.doesNotMatch(summary,/PRIVATE_BODY/)
})

test('unknown batch error preserves trusted partial receipts for result tabs', async () => {
  const partial={kind:'produce-batch',receipts:[{index:0,partition:0,baseOffset:'1',acknowledged:true}],status:'unknown',failedIndex:1}
  const steps=await runKafkaBatch({steps:createKafkaBatch('PRODUCE_BATCH {"topic":"x","messages":[{"value":"a"},{"value":"b"}]}\nTOPICS'),signal:new AbortController().signal,execute:async()=>{throw Object.assign(new Error('receipt lost'),{effect:'unknown',executionStatus:'unknown',sourceResult:partial})}})
  assert.equal(steps[0].status,'unknown');assert.deepEqual(steps[0].result.receipts,partial.receipts);assert.equal(steps[1].status,'skipped')
})

test('HTTP bridge retains partial Kafka publication receipts only with a trusted error envelope', async t => {
  const saved=globalThis.fetch;t.after(()=>{globalThis.fetch=saved})
  const partial={kind:'produce-batch',executionStatus:'unknown',receipts:[{index:0,partition:0,baseOffset:'42',acknowledged:true}]}
  const connection={id:'k',generation:'g',dialect:'kafka'}
  const bridge=connectionBridge('owner',{})
  globalThis.fetch=async()=>new Response(JSON.stringify({error:'receipt lost',executionId:'e1',status:'unknown',effect:'unknown',phase:'receipt',sourceResult:partial}),{status:400})
  const steps=await runKafkaBatch({steps:createKafkaBatch('PRODUCE_BATCH {"topic":"x","messages":[{"value":"a"}]}\nTOPICS'),signal:new AbortController().signal,execute:(text,signal)=>bridge.executeText(connection,text,{},signal)})
  assert.equal(steps[0].status,'unknown');assert.equal(steps[0].result.receipts[0].baseOffset,'42');assert.equal(steps[1].status,'skipped')
  globalThis.fetch=async()=>new Response(JSON.stringify({error:'proxy error',sourceResult:partial}),{status:502})
  await assert.rejects(bridge.executeText(connection,'TOPICS',{},new AbortController().signal),error=>{assert.equal(error.sourceResult,undefined);assert.equal(error.effect,'unknown');return true})
})

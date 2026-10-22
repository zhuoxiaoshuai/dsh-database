import test from 'node:test'
import assert from 'node:assert/strict'
import {connectionBridge} from '../src/client/connection-bridge.ts'

const base = {mode:'host',connections:[],tables:()=>[],execute:async()=>({})}
test('lost or malformed acceptance receipts reconcile through the operation ID', async t => {
  const previous = globalThis.fetch; t.after(() => {globalThis.fetch = previous})
  for (const failure of ['lost','malformed']) {
    let posts = 0, gets = 0
    globalThis.fetch = async (_url, options) => {
      if (options.method === 'POST') {posts++; if (failure === 'lost') throw new TypeError('network'); return new Response('{}',{status:202})}
      gets++; return Response.json({connections:[{id:'accepted',lifecycle:{operationId:'nonce'}}]})
    }
    const receipt = await connectionBridge('owner',base).startConnection({},'nonce')
    assert.deepEqual(receipt,{connectionId:'accepted',operationId:'nonce'})
    assert.deepEqual([posts,gets],[1,1])
  }
})

test('unknown acceptance survives a failed reconciliation, while definite rejection does not poll', async t => {
  const previous = globalThis.fetch; t.after(() => {globalThis.fetch = previous})
  globalThis.fetch = async () => {throw new TypeError('network')}
  await assert.rejects(connectionBridge('owner',base).startConnection({},'nonce'), error => error.acceptanceUnknown === true)
  let requests = 0
  globalThis.fetch = async () => {requests++; return Response.json({error:'connection busy',code:'connection_busy'},{status:409})}
  await assert.rejects(connectionBridge('owner',base).startConnection({},'nonce'), error => !error.acceptanceUnknown && error.code === 'connection_busy')
  assert.equal(requests,1)
})

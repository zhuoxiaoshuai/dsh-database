import { ExecutionStore } from '../src/host/execution-store.ts'
const store = new ExecutionStore(process.argv[2], 'async')
const unsent = store.create({ conversationId: 'fault', operation: 'sql', generation: 'old' })
const sent = store.create({ conversationId: 'fault', operation: 'sql', generation: 'old' })
store.transition(sent.executionId, 'running'); store.event(sent.executionId, 'dispatched')
const outcome = await store.retryPersistence()
if (!outcome.saved) throw new Error('active records were not durable')
process.send?.({ unsent: unsent.executionId, sent: sent.executionId })
setInterval(() => {}, 1000)

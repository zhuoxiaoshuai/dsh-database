import { checkCommittedReceiptFaults } from './sql-receipt-fault-probe.mjs'
import { checkBrowserReceiptFaults } from './http-browser-receipt-fault-probe.mjs'
import assert from 'node:assert/strict'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { ConnectionService } from '../src/host/connection-service.ts'
import { ExecutionStore } from '../src/host/execution-store.ts'
import { memoryPasswordProtector } from '../src/password-protector.ts'

/** Called only with the disposable acceptance container's credentials and row_limit table. */
export async function checkRootRepairSql(input, schema, readValue) {
  const directory = await mkdtemp(join(tmpdir(), 'dsh-root-sql-'))
  const executions = new ExecutionStore(directory)
  const service = new ConnectionService(() => true, directory, undefined, memoryPasswordProtector, executions)
  const checks = []
  let stage = 'open'
  try {
    for (const [index, environment] of ['sit', 'uat', 'pvt'].entries()) {
      stage = `${environment}: open`
      const connection = await service.open('probe', { ...input, environment }, false)
      await service.catalog('probe', connection.id, connection.generation, { kind: 'schemas', search: schema })
      const target = { schema, limit: 10 }
      const request = sql => service.request('probe', connection.id, connection.generation, 'manual-query', { ...target, sql })
      const write = value => `UPDATE row_limit SET value=${value} WHERE id=1`
      stage = `${environment}: manual write`
      await request(write(11 + index))
      assert.equal(Number(await readValue()), 11 + index)
      const before = Number(await readValue())
      const explain = input.dialect === 'oracle' ? 'EXPLAIN PLAN FOR' : 'EXPLAIN'
      stage = `${environment}: fail-closed syntax`
      for (const sql of [`${explain} ${write(99)}`, `UPDATE row_limit SET value=99 WHERE id=1; ${explain} ${write(98)}`, 'SELECT id FROM']) {
        await assert.rejects(request(sql))
        assert.equal(Number(await readValue()), before, 'preflight cannot dispatch any earlier write')
      }
      await assert.rejects(request('SELECT id FROM row_limit FOR UPDATE'))
      for (const locked of [
        'SELECT * FROM (SELECT * FROM row_limit FOR UPDATE) t',
        'SELECT * FROM row_limit WHERE id = (SELECT id FROM row_limit WHERE id=1 FOR UPDATE)',
        'WITH locked AS (SELECT id FROM row_limit FOR UPDATE) SELECT * FROM locked',
      ]) {
        await assert.rejects(request(locked))
        await assert.rejects(request(write(99) + '; ' + locked))
        assert.equal(Number(await readValue()), before, 'nested forbidden syntax must reject the batch before its earlier write')
      }
      let document = service.getExecutionDocument('probe', connection.id)
      stage = `${environment}: document write`
      document = service.updateExecutionDocument('probe', connection.id, write(20 + index), 'user', document.revision, connection.generation, { schema })
      const receipt = await service.runExecutionDocument('probe', connection.id, connection.generation, document.revision)
      assert.equal(receipt.status, 'succeeded'); assert.equal(Number(await readValue()), 20 + index)
      document = service.controlExecutionDocument('probe', connection.id, 'ai', undefined, connection.generation, service.getExecutionDocument('probe', connection.id).revision)
      const ai = () => service.runSharedQuery('probe', { connectionId: connection.id, generation: connection.generation,
        schema, sql: document.text, revision: document.revision, initiator: 'ai' })
      stage = `${environment}: AI boundary`
      if (environment === 'sit') assert.equal((await ai()).status, 'succeeded')
      else await assert.rejects(ai(), /SIT|只读权限/)
      const batch = `${write(30 + index)}; UPDATE row_limit SET missing_column=1 WHERE id=1; ${write(90)}`
      document = service.updateExecutionDocument('probe', connection.id, batch, 'user', service.getExecutionDocument('probe', connection.id).revision, connection.generation, { schema })
      const previousIds = new Set(executions.list('probe').map(row => row.executionId))
      stage = `${environment}: batch receipts`
      await assert.rejects(service.runExecutionDocument('probe', connection.id, connection.generation, document.revision), error => {
        assert.equal(error.effect, 'none'); assert.equal(error.category, 'database-rejection')
        assert.deepEqual(error.steps.map(step => step.status), ['succeeded', 'failed', 'not-run'])
        assert.ok(error.databaseCode); return true
      })
      assert.equal(Number(await readValue()), 30 + index)
      const records = executions.list('probe').filter(row => !previousIds.has(row.executionId))
      assert.equal(records.length, 1); assert.equal(records[0].status, 'failed')
      assert.equal(records[0].events.filter(event => event.kind === 'dispatched').length, 1)
      assert.deepEqual(executions.get('probe', records[0].executionId, true).result.steps.map(step => step.status), ['succeeded', 'failed', 'not-run'])
      checks.push(`${environment}: manual/document DML, AI boundary, fail-closed preflight, committed partial batch and single lifecycle`)
      await service.remove('probe', connection.id)
    }
    stage = 'committed receipt faults'
    checks.push(await checkCommittedReceiptFaults(input, schema, readValue))
    stage = 'Host-browser committed receipt faults'
    checks.push(await checkBrowserReceiptFaults(input, schema, readValue))
    return `Root repair through real Host/Worker/database: ${checks.join('; ')}`
  } catch (error) { assert.fail(`${stage}: ${error.message}`) }
  finally { await service.dispose(); await executions.dispose(); await rm(directory, { recursive: true, force: true }) }
}

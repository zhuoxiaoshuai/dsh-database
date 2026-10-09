import { randomUUID, createHash } from 'node:crypto'
import { createDmlPlan } from './dml-plan.mjs'
import { createDdlPlan } from './ddl-plan.mjs'
import { isWritableEnvironment } from './shared/connection-permission.mjs'
import { getDataSource } from './data-sources/sql-registry.mjs'
import { MaintenanceError } from './data-sources/maintenance-error.mjs'
import { analyzeQueryMaintenance, finalizeMaintenanceCapability } from './maintenance-capability.mjs'
const forbidden = new Set(['mysql', 'information_schema', 'performance_schema', 'sys', 'system', 'xdb', 'outln'])
const revisionOf = metadata => createHash('sha256').update(JSON.stringify({ columns: metadata.columns, indexes: metadata.indexes, constraints: metadata.constraints })).digest('hex')
export { MaintenanceError }
export function assertExpectedAffectedRows(affected, expectedRows) {
  if (!Number.isInteger(affected) || affected > 100) throw new MaintenanceError('影响超过 100 行，已回滚。')
  if (affected !== expectedRows) throw new MaintenanceError(`实际影响 ${affected} 行，与预期 ${expectedRows} 行不一致，本次已回滚；请保留草稿并刷新。`)
}

export class Maintenance {
  #enabled = new Map()
  #pending = new Map()
  #capabilities = new Map()
  #catalog
  #openSession
  #releaseSession
  constructor(connection, credentials, openSession, releaseSession) {
    this.#catalog = typeof connection === 'function' ? connection : () => connection
    this.credentials = credentials
    this.operations = getDataSource(credentials.dialect).maintenance
    this.#openSession = openSession
    this.#releaseSession = releaseSession
  }
  get connection() { return this.#catalog() }
  #bucket(conversationId) {
    if (typeof conversationId !== 'string' || !conversationId || conversationId.length > 160) throw new MaintenanceError('维护请求缺少有效对话身份。')
    let pending = this.#pending.get(conversationId)
    if (!pending) { pending = new Map(); this.#pending.set(conversationId, pending) }
    for (const [id, item] of pending) if (item.expiresAt < Date.now()) pending.delete(id)
    return pending
  }
  #capabilityBucket(conversationId) {
    if (typeof conversationId !== 'string' || !conversationId || conversationId.length > 160) throw new MaintenanceError('维护请求缺少有效对话身份。')
    let values = this.#capabilities.get(conversationId)
    if (!values) { values = new Map(); this.#capabilities.set(conversationId, values) }
    return values
  }
  async #open() {
    return this.#openSession ? this.#openSession() : this.operations.open(this.credentials)
  }
  async #inspect(connection, schema, table, allowMissing = false) {
    if (typeof schema !== 'string' || !schema || schema.length > 128 || forbidden.has(schema.toLowerCase()) || typeof table !== 'string' || !table || table.length > 128 || schema.includes('\0') || table.includes('\0')) throw new MaintenanceError('禁止维护系统对象或无效目标。')
    const metadata = await this.operations.inspect(connection, schema, table, allowMissing)
    if (metadata.indexes.status !== 'actual' || metadata.constraints.status !== 'actual') throw new MaintenanceError('无法确认完整结构，不开放维护。')
    return metadata
  }
  async #privileges(connection, schema, table) {
    return this.operations.privileges(connection, schema, table, this.credentials)
  }
  async #capability(input) {
    const capabilities = this.#capabilityBucket(input.conversationId)
    if (capabilities.size >= 16) capabilities.clear()
    const source = input.source === 'query' ? 'query' : 'table'
    let shape
    if (source === 'query') {
      shape = await analyzeQueryMaintenance(this.credentials.dialect, input.sql, Array.isArray(input.resultColumns) ? input.resultColumns : [])
      if (shape.canEnable === false) return shape
    }
    const schema = String(shape?.schema || input.schema || '')
    const table = String(shape?.table || input.table || '')
    const metadata = await this.#inspect(this.connection, schema, table)
    let privileges
    try { privileges = await this.#privileges(this.connection, schema, table) }
    catch { privileges = { insert: true, update: true, delete: true } }
    const capability = finalizeMaintenanceCapability({
      source, schema, table, dialect: this.credentials.dialect, metadata, shape, privileges,
    })
    if (capability.canEnable) capabilities.set(capability.id, capability)
    return capability
  }
  async #dependencies(db, schema, table, creating = false) {
    return this.operations.dependencies(db, schema, table, creating)
  }
  async request(input, progress = () => {}) {
    if (!isWritableEnvironment(this.credentials.environment)) throw new MaintenanceError('只读权限连接不能提交维护操作。')
    const pending = this.#bucket(input?.conversationId)
    if (input?.kind === 'capability') return this.#capability(input)
    if (input?.kind === 'enable') {
      pending.clear()
      if (input.enabled !== true) {
        this.#enabled.delete(input.conversationId)
        this.#capabilities.delete(input.conversationId)
        return { enabled: false }
      }
      const capability = input.capabilityId ? this.#capabilityBucket(input.conversationId).get(input.capabilityId) : undefined
      if (input.capabilityId && !capability?.canEnable) throw new MaintenanceError('维护能力已失效，请重新检查。')
      this.#enabled.set(input.conversationId, capability || true)
      return { enabled: true }
    }
    const enabled = this.#enabled.get(input.conversationId)
    if (!enabled) throw new MaintenanceError('请先人工开启此连接的维护模式。')
    if (input?.kind === 'preview' || input?.kind === 'ddl-preview') {
      if (pending.size >= 16) throw new MaintenanceError('待审批操作过多，请先处理已有请求。')
      const ddl = input.kind === 'ddl-preview', creating = ddl && input.operations?.[0]?.kind === 'createTable'
      if (!ddl && enabled !== true) {
        const operation = input.operation?.kind
        if (enabled.schema !== input.schema || enabled.table !== input.table) throw new MaintenanceError('维护目标已经变化，请重新开启维护。')
        if (operation === 'insert' && !enabled.canInsert) throw new MaintenanceError(enabled.insertReason || '当前结果不允许新增。')
        if (operation === 'update' && !enabled.canUpdate) throw new MaintenanceError(enabled.updateReason || '当前结果不允许修改。')
        if (operation === 'delete' && !enabled.canDelete) throw new MaintenanceError(enabled.deleteReason || '当前结果不允许删除。')
        const allowed = new Set(enabled.columns.map(column => column.sourceColumn).filter(Boolean))
        if (Object.keys(input.operation?.values || {}).some(column => !allowed.has(column))) throw new MaintenanceError('写入字段不在当前维护能力范围内。')
      }
      const metadata = await this.#inspect(this.connection, input.schema, input.table, creating)
      let plan
      if (ddl) {
        await this.#dependencies(this.connection, input.schema, input.table, creating)
        const mode = await this.operations.sqlMode(this.connection)
        for (const op of input.operations || []) if (op.kind === 'addConstraint' && op.type === 'foreign') {
          const referenced = await this.#inspect(this.connection, input.schema, op.references?.table)
          const names = new Set(referenced.columns.map(c => c.name))
          if (!op.references.columns.every(c => names.has(c))) throw new MaintenanceError('外键引用字段不存在。')
        }
        plan = createDdlPlan(this.credentials.dialect, input.schema, input.table, input.operations, metadata, mode)
      } else plan = createDmlPlan(this.credentials.dialect, input.schema, input.table, input.operation, metadata)
      const id = randomUUID(), expiresAt = Date.now() + 300000, revision = revisionOf(metadata)
      pending.set(id, { plan, revision, expiresAt })
      return { id, expiresAt, revision, before: ddl ? metadata : undefined, dependencies: ddl ? [] : undefined, environment: this.credentials.environment, ...plan }
    }
    if (input?.kind === 'reject') { pending.delete(input.id); return { rejected: true } }
    if (input?.kind !== 'execute' || input.confirmed !== true) throw new MaintenanceError('需要人工审阅并确认此操作。')
    const item = pending.get(input.id)
    if (!item || item.expiresAt <= Date.now()) throw new MaintenanceError('审批已失效或已经消费，请重新预览。')
    if (item.plan.kind === 'ddl' && item.plan.destructive && input.targetName !== item.plan.table) throw new MaintenanceError('请输入完整目标表名确认破坏性操作。')
    pending.delete(input.id)
    const plan = item.plan, db = await this.#open()
    let committed = false, commitStarted = false
    try {
      await this.operations.verifyIdentity(db, this.credentials)
      if (plan.kind === 'ddl') return await this.#executeDdl(db, plan, item.revision, progress, pending)
      await this.operations.prepareDml(db, plan)
      const metadata = await this.#inspect(db, plan.schema, plan.table)
      if (revisionOf(metadata) !== item.revision) throw new MaintenanceError('表结构已经变化，请重新预览。')
      const affected = await this.operations.executeDml(db, plan)
      assertExpectedAffectedRows(affected, plan.expectedRows)
      commitStarted = true; await this.operations.commit(db); committed = true
      pending.clear()
      return { status: 'success', affectedRows: affected, message: '已提交 1 行变更。' }
    } catch (error) {
      let rollbackConfirmed = false
      if (plan.kind !== 'ddl' && !committed) { try { await this.operations.rollback(db); rollbackConfirmed = true } catch { /* retain uncertainty */ } }
      if (commitStarted) return { status: 'unknown', message: '提交阶段连接中断，结果未知。请刷新核验，不要直接重试。' }
      throw Object.assign(error, { effect: rollbackConfirmed ? 'none' : 'unknown', phase: commitStarted ? 'commit' : 'execute' })
    } finally {
      if (this.#releaseSession) await this.#releaseSession()
      else await this.operations.close(db)
    }
  }
  async #executeDdl(db, plan, revision, progress, pending) {
    const steps = plan.steps.map(s => ({ ...s })), creating = steps[0].kind === 'createTable'
    await this.operations.prepareDdl(db, plan)
    const before = await this.#inspect(db, plan.schema, plan.table, creating)
    if (revisionOf(before) !== revision) throw new MaintenanceError('表结构已经变化，审批失效。')
    await this.#dependencies(db, plan.schema, plan.table, creating)
    pending.clear()
    return runDdlSteps({ steps, revision, progress,
      isUncertainDdlError: error => this.operations.isUncertainDdlError(error),
      read: table => this.operations.readDdl(db, plan.schema, table),
      dependencies: table => this.#dependencies(db, plan.schema, table),
      execute: sql => this.operations.executeDdl(db, sql),
      peek: table => this.operations.peekDdl(db, plan.schema, table),
    })
  }
}

// Driver-independent sequencing keeps uncertain outcomes distinct from database rejection.
export async function runDdlSteps({ steps: inputSteps, revision, progress = () => {}, read, dependencies, execute, peek, isUncertainDdlError = error => /TIMEOUT|CONNECTION|PROTOCOL|ECONN|EPIPE/i.test(String(error?.code || '')) }) {
  const steps = inputSteps.map(step => ({ ...step }))
    let expectedRevision = revision
    for (let i = 0; i < steps.length; i++) {
      const step = steps[i]; step.state = 'unknown'; progress({ steps })
      let commandSucceeded = false
      try {
        if (i > 0) {
          const current = await read(step.table)
          if (revisionOf(current) !== expectedRevision) throw new MaintenanceError('结构在步骤之间发生变化，已停止后续操作。')
          await dependencies(step.table)
        }
        await execute(step.sql)
        commandSucceeded = true
        step.state = 'success'
        // A completed command is followed by an actual dictionary read; no automatic retry.
        const after = await read(step.afterTable)
        expectedRevision = revisionOf(after)
        if (step.kind === 'dropTable' ? after.columns.length !== 0 : after.columns.length === 0) step.state = 'unknown'
        if (step.kind === 'truncateTable') {
          const rows = await peek(step.afterTable)
          if (rows.length) step.state = 'unknown'
        }
        if (step.state === 'unknown') break
      } catch (error) {
        const uncertain = commandSucceeded || isUncertainDdlError(error)
        step.state = uncertain ? 'unknown' : 'failed'
        step.error = uncertain ? '连接或期限异常，结果未知，请核验实际结构。' : '数据库拒绝此步骤；前面已成功的步骤不会回滚。'
        // Attempt a read for evidence only. A failed statement is never re-executed.
        try { const observed = await read(step.afterTable); step.observedColumns = observed.columns.map(c => c.name) } catch { step.state = 'unknown' }
        break
      } finally { progress({ steps }) }
    }
    return { status: steps.some(s => s.state === 'unknown') ? 'unknown' : steps.some(s => s.state === 'failed') ? 'partial' : 'success', steps, message: 'DDL 逐步执行，不保证整体回滚；请核对每步结果。' }
}

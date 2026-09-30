import { selectTable, type Connection, type Table, type WorkspaceBridge } from '../src/workbench.ts'

export const connections: Connection[] = [
  { id: 'preview-mysql', name: '电商开发库', dialect: 'mysql', database: 'commerce_dev', environment: 'sit', version: '8.x · 演示' },
  { id: 'preview-oracle', name: '结算测试库', dialect: 'oracle', database: 'SETTLEMENT', environment: 'uat', version: '19c · 演示' },
]
const tables: Table[] = [
  { name: 'orders', comment: '订单主表', columns: [
    { name: 'id', type: 'BIGINT', nullable: false, key: 'PK', comment: '订单编号' },
    { name: 'order_no', type: 'VARCHAR(32)', nullable: false, key: 'UK', comment: '业务订单号' },
    { name: 'customer', type: 'VARCHAR(64)', nullable: false, sensitive: true, comment: '客户姓名 · 已脱敏' },
    { name: 'amount', type: 'DECIMAL(12,2)', nullable: false, comment: '订单金额' },
    { name: 'status', type: 'VARCHAR(20)', nullable: false, comment: '订单状态' },
    { name: 'created_at', type: 'DATETIME', nullable: false, comment: '创建时间' },
  ] },
  { name: 'order_items', comment: '订单明细', columns: [
    { name: 'id', type: 'BIGINT', nullable: false, key: 'PK', comment: '明细编号' },
    { name: 'order_id', type: 'BIGINT', nullable: false, key: 'FK', comment: '所属订单' },
    { name: 'product_id', type: 'BIGINT', nullable: false, key: 'FK', comment: '商品编号' },
    { name: 'quantity', type: 'INT', nullable: false, comment: '购买数量' },
  ] },
  { name: 'customers', comment: '客户信息', columns: [
    { name: 'id', type: 'BIGINT', nullable: false, key: 'PK', comment: '客户编号' },
    { name: 'name', type: 'VARCHAR(64)', nullable: false, sensitive: true, comment: '姓名 · 已脱敏' },
    { name: 'email', type: 'VARCHAR(128)', nullable: true, sensitive: true, comment: '邮箱 · 已脱敏' },
    { name: 'created_at', type: 'DATETIME', nullable: false, comment: '注册时间' },
  ] },
  { name: 'products', comment: '商品目录', columns: [
    { name: 'id', type: 'BIGINT', nullable: false, key: 'PK', comment: '商品编号' },
    { name: 'name', type: 'VARCHAR(128)', nullable: false, comment: '商品名称' },
    { name: 'price', type: 'DECIMAL(12,2)', nullable: false, comment: '商品价格' },
    { name: 'stock', type: 'INT', nullable: false, comment: '库存' },
  ] },
]
export const mysqlTables = tables
export const oracleTables = tables.map(t => ({ ...t, name: t.name.toUpperCase(), columns: t.columns.map(c => ({ ...c, name: c.name.toUpperCase(), type: c.type.replace('BIGINT', 'NUMBER(19)').replace('DECIMAL', 'NUMBER').replace('VARCHAR', 'VARCHAR2').replace('DATETIME', 'TIMESTAMP').replace(/^INT$/, 'NUMBER(10)') })) }))
const orders = Array.from({ length: 12 }, (_, i) => [String(10081 + i), `ORD-20260912-${String(81 + i).padStart(4, '0')}`, ['张**', '李**', '王**', '陈**'][i % 4], ['299.00', '1280.00', '86.50', '459.00', '199.00', '2399.00'][i % 6], ['paid', 'pending', 'paid', 'shipped'][i % 4], `2026-09-12 ${String(10 - Math.floor(i / 4)).padStart(2, '0')}:${String(58 - i * 3).padStart(2, '0')}:00`])
export const previewBridge: WorkspaceBridge = {
  mode: 'preview', connections,
  tables(connection) { return connection.dialect === 'mysql' ? mysqlTables : oracleTables },
  async execute(connection, query, signal) {
    await new Promise<void>((resolve, reject) => { const timer = setTimeout(resolve, 350); signal.addEventListener('abort', () => { clearTimeout(timer); reject(new Error('已取消演示查询')) }, { once: true }) })
    if (signal.aborted) throw new Error('已取消演示查询')
    const canonical = (value: string) => value.replace(/\s+/g, '').replace(/;$/, '').toLowerCase()
    const table = this.tables(connection).find(t => canonical(selectTable(connection, t)) === canonical(query))
    if (!table) throw new Error('原型仅执行打开表时生成的预设演示 SQL；自定义 SQL 需要后续真实数据库接入。')
    const name = table.name.toLowerCase()
    const rows = name === 'orders' ? orders : name === 'order_items' ? [['1', '10081', '301', '2'], ['2', '10082', '302', '1']] : name === 'customers' ? [['101', '张**', 'z***@example.test', '2026-08-10 10:00:00'], ['102', '李**', null, '2026-08-11 11:00:00']] : [['301', '机械键盘', '299.00', '128'], ['302', '显示器支架', '199.00', '64']]
    return { columns: table.columns.map(c => c.name), rows, truncated: false, elapsedMs: 350, message: '固定演示数据，未连接数据库' }
  },
}

# dsh-database 代码评审报告

- 评审对象：`dsh-database`（v0.1.0-alpha.12.13）
- 评审时间：2026-09-23
- 范围：host 侧安全、client 侧质量、构建工程化，共 125 个源文件 + 55 个测试文件
- 方法：三轮独立通读 + 交叉验证（关键结论均由主评审人复核源码确认）

---

## 一、总体判断

这是一个**工程质量明显高于平均水平**的插件：看得出作者有清晰的安全建模意识——凭据走 DPAPI、传 worker 后立即清零、错误全链路脱敏、结果集有字节预算、worker 崩溃有退避恢复、五处请求竞态用序号守卫。类型纪律尤其罕见：**45 个 client 文件零 `any`、零 `@ts-ignore`**。386 个单测全绿。

但存在一个**结构性缺口**：`ApprovalLedger`（写操作审批台账）写好了却从未接线，导致这套安全模型里最重的一环——"AI/用户能否改动生产数据"——目前**没有任何闸门**。这不是代码 bug，是设计没落地。配套地，读侧防线也有一条 fail-open 的降级路径。

按严重度排：**致命 0 项（本地插件语境下无远程利用面）、高危 3 项、中危 9 项、低危 9 项。**

---

## 二、高危问题

> **2026-09-25 复核**：以下三条经二审实读源码确认成立，证据见第八节。

### H1 · 写操作审批完全未接线，`ApprovalLedger` 是死代码

全仓检索 `ApprovalLedger` / `approval-ledger`，命中仅 3 行且全部是它自己的定义文件：

```
src/approval-ledger.ts:20:export class ApprovalLedger {
```

零 import、零实例化。而写操作的实际执行路径是这样的：

```ts
// src/host/connection-service.ts:353-357
if (authorized.kind === 'write') {
  if (!isWritableEnvironment(connection.environment)) throw new Error('只读权限连接不能提交写入。')
  this.#executions?.annotate(executionId, { type: 'write', ..., conclusion: 'SIT 写操作已直接执行。' })
  this.updateSharedQuery(session, id, { sql: authorized.sql, schema, lastExecutionId: executionId }, 'system')
}
```

唯一的闸门是"连接的环境标签是否可写"，而环境标签由用户在建连表单里自报（见 M3）。`ai-tool-guides.ts:34` 也明确写了"SIT 可直接 INSERT/UPDATE/DELETE"——即工具契约里就没打算要求审批。

好消息是 `ApprovalLedger` 这个 class 本身设计是合格的：owner 隔离、`consume` 即删不可重放、绑定 connectionId/identity/schemaRevision/policyRevision/dialect/environment 六元组、300 秒过期、且**没有暴露任何 AI 可调用的 approve 工具**（这点很关键，否则 LLM 可以自己批自己）。所以修复不是重写，是接线。

**修复（在 `:354` 与 `:355` 之间插入校验）**：走 `ledger.create()` 生成待确认条目 → 返回 `awaiting_confirmation` 状态给 UI → 用户在 `ConfirmWriteDialog` 确认后携 token 重入 → `ledger.consume(token)` 校验六元组后再执行。UI 侧 `confirm-write-dialog.tsx` 已经是现成的落点。

### H2 · Oracle `analyzeTable` 存在 PL/SQL 注入

```js
// src/host/dialects/oracle.mjs:28
analyzeTable: (_target, schema, table) =>
  `BEGIN DBMS_STATS.GATHER_TABLE_STATS(ownname => '${schema.toUpperCase()}', tabname => '${table.toUpperCase()}'); END;`,
```

两个值直接插进 PL/SQL 匿名块、且位于单引号字符串内，只做了大小写转换，没有转义单引号。调用链：

```js
// src/host/ddl-plan.mjs:75
sqlDialect.analyzeTable(target, schema, operation.name || table)
```

`operation.name` 未经任何校验——`maintenance.mjs:56` 的 `#inspect` 只拦截 NUL 字节，不拦单引号。构造 `operation.name = "X'); EXECUTE IMMEDIATE '<任意>'; END;--"` 即可在匿名块内拼接任意 PL/SQL。

这是本次评审里唯一一处真正的注入漏洞，与其余文件形成鲜明对比——同一份 `oracle.mjs` 的元数据查询全都正确用了 `:1/:2` 绑定。

**修复**：改为绑定变量 `ownname => :1, tabname => :2`（与该文件其余部分风格一致），或在 DDL 路径的 `quoteIdentifier` 加 `rejectQuote: true` 选项。

### H3 · 解析器失败时的降级路径 fail-open

```js
// src/host/query-policy.mjs:87-90
function authorizeByLead(sql, schema) {
  const kind = statementKind(sql)
  const trimmed = strippedSql(sql)
  if (kind === 'select') return { kind: 'select', tables: [], references: [], aliases: [], sql: trimmed }
```

`select` 分支零校验直接放行。`node-sql-parser` 抛错时会走到这里（`query-policy.mjs:217-219`）。也就是说：构造一条"以 SELECT/WITH 开头但解析器吞不下"的语句，即可绕过 `information_schema` 拦截、`INTO OUTFILE` 拦截、`locking_read` 拦截。

需要说明的是，主防线本身相当扎实——`guard` 禁 16KiB 以上语句与可执行注释、MySQL 走真解析且非 CRUD 一律判 WRITE_ONLY、walk 禁八类节点、多语句只要含写就整体降级、邻 path2 都是加分项。唯独这条兜底拖了后腿。

**修复**：解析失败改为 `throw new Error('无法解析此语句。')`（Oracle 侧的 ANTLR 已经是 fail-closed，两者不一致），或对降级 select 复用 `recordTable` + 关键字黑名单。

---

## 三、中危问题

| # | 问题 | 位置 | 修复方向 |
|---|---|---|---|
| M1 | 连接不按会话隔离。`Entry` 带 `session` 字段但 `#dispatch` 只调 `sessionValid(session)`（校验会话是否存在），从不比对归属 | `connection-service.ts:874` | 加 `entry.session !== session` 即拒 |
| M2 | SIT 环境下对 AI 返回结果跳过脱敏 | `ai-tools.ts:400-404` | 去掉 `!sit` 条件，脱敏与环境解耦 |
| M3 | 环境标签自报即授予 AI 完整 DML 权限；未知值 fail-safe 归 `uat` 这点是对的 | `shared/connection-permission.mjs:9-20` | 对未二次确认的高危标签拒 AI 写入 |
| M4 | HTTP 侧 owner 仅校验字符串格式，未校验调用者会话与 `conversationId` 一致 | `register.ts:21,57` | 复用已有的 `liveOwner` |
| M5 | `closeTab` 在 setState updater 内写 ref 并调另一个 setState，StrictMode 下会双写 | `active-connection-pane.tsx:260-272` | 把副作用移出 updater |
| M6 | `useEffect(() => setSql(initialSql), [tabId])` 缺 `initialSql` 依赖，切页签会用旧值覆盖 | `sql-workspace-tab.tsx:43` | 补依赖 |
| M7 | 三个高危弹窗未接入 `useDialog`（无焦点陷阱/Esc/初始聚焦），其中含**写操作确认框** | `confirm-write-dialog.tsx:14`、`object-workspace.tsx:357`、`sql-template-library.tsx:303` | 统一接入 `dialog.ts` 的 `useDialog` |
| M8 | `sql-workspace-tab.tsx` 卸载时不 abort 进行中的请求 | `sql-workspace-tab.tsx:61,94` | 补 `useEffect(() => () => running.current?.abort(), [])` |
| M9 | `build.mjs` 无类型检查、无 DSH 规范校验 | `scripts/build.mjs:28` | 照搬 `dsh-remote-exec` 的 `check-build` / `check-package`，并把 `typecheck` 挂进 `prepack` |

关于 M9 值得多说一句：产物形态**实测是合格的**（`lib/index.js` 末行 `export {...}` 是 ESM、`lib/client.js` 首行 `window.__ModuleLoader__.load({id:"dsh-database",factory:...})` 是 CJS factory），只是没有被断言守护。而 `dsh-remote-exec` 的 `check-build.cjs` 注释里明确记录了"有人把 format 改成 cjs 导致线上事故"——同一支acsamericanport团队踩过的坑，这里裸奔。这也是三个插件之间规范不统一的地方。

---

## 四、低危问题

- `memoryPasswordProtector` 是纯 base64（等价明文），且定义了两份（`password-protector.ts:17`、`saved-connections.ts:25`）。经确认默认注入的是 Windows DPAPI 版，此实现从未被使用 —— 建议删除或改名 `insecurePlaintextProtector` 并加警示注释，防止后续被误当作可用实现接入。
- 系统库名单缺 `sysaux`（`query-policy.mjs:3`），而 `maintenance-capability.mjs:4` 和 `ai-tools.ts:108` 都有 —— 三处名单手工对齐容易再漏。
- `browse.mjs:7` 的 `quoteIdentifier` 未传 `maxLength/rejectNul/rejectControls`，弱于 catalog 的 `boundedName` 版本。
- `database_status` 自述 `defaultAccess: 'readonly'`，与 guide 里"SIT 可直接写"矛盾，可能让上游编排误判风险。
- `src/host/shared/` 是构建期 re-export 壳（因 `src/host/*.mjs` 被拍平复制到 `lib/`，相对路径语义在源码树和产物树不同）。机制巧妙但极易踩坑，建议在这两个文件顶部写明原因。
- `files[]` 手写 22 条清单，实测与产物完全自洽（值得表扬），但改用 `"lib/**/*.mjs"` + `"!lib/preview/**"` 更省心 —— 当前靠"不列举"隐式排除 2.8MB 的 preview.js。
- `engines.node >= 24` 偏激进；测试在 v22.22.2 全绿，建议放宽。
- 根工作区脏：6 个历史 tgz、`debug-626202.log`、双 lock 并存。已确认均被 `.gitignore` 覆盖、未污染仓库，只是本地卫生。
- `scripts/` 下 `ui-acceptance.mjs` / `lifecycle-acceptance.mjs` / `maintenance-ui-acceptance.mjs` 已无引用，属死代码；`test:host` 与 `test:package` 指向同一文件。

---

## 五、工程化

**双 lock 混用（中）**。实测 `package-lock.json` 与 `pnpm-lock.yaml` **都已提交**，实际生效的是 pnpm（`node_modules/.modules.yaml` 存在、`.package-lock.json` 不存在）。两者闭包已漂移：npm-lock 159 条 vs pnpm-lock 197 条，pnpm 多 38 个 `@deepseek-ai/*` 传递包，`sql-escaper` 版本也不同（1.5.1 vs 1.5.2）。当前不是故障，但谁误跑一次 `npm install` 就会装出缺依赖的 node_modules —— 而 `plugin-installer` 的探测逻辑是先命中谁用谁。

**修复**：删 `package-lock.json`、`.gitignore` 补一行、`package.json` 钉 `"packageManager": "pnpm@10.34.5"`。

**依赖冗余（中）**：`build.mjs:20` 的 external 只有 react 三家，因此 `lucide-react`、`@codemirror/*`、`sql-formatter` **已全部内联进 bundle** 却仍留在 `dependencies` —— 实测装进 profile 后这些包仍会被重复拉一遍。修这几行 `@codemirror/*` + `@lezer/highlight` 下沉到 devDependencies 即可。

顺带澄清三点：`antlr4` + `@griffithswaite/ts-plsql-parser` + `node-sql-parser` + `sql-formatter` 四个解析器**并不冗余**（前两个专司 Oracle PL/SQL、第三个 MySQL、第四个仅供两个 client 文件格式化），建议保留；`lucide-react@1.45.0` 版本号真实存在非幻觉；`oracledb` 走 Thin 模式 + `allowBuilds: false`，处理得当。

**测试（实测执行）**：`node --experimental-strip-types --test test/*.test.mjs` → **386 pass / 0 fail**，15.2s；两份 tsconfig 均 `exit 0`。`scripts/test:*.mjs` 是依赖真实 DSH Desktop + Playwright 的端到端验收，与单测互补不重叠。

**缺口（高）**：零 React 渲染测试 —— `test/` 下搜不到任何 `react-dom|createRoot|renderToString|@testing-library` 命中，7 个巨型组件全无覆盖；五处竞态守卫（`runSeq`/`requestSequence`/`treeSeq`/`searchSeq`/`previewSeq`）是本仓质量最高的逻辑却无用例验证。`shared/sql-batch.ts` 和 `shared/query-sync.ts` 已经测得很充分，把同样手法用在组件层即可。

---

## 六、做得好的地方（保持现状）

1. **凭据生命周期是全仓最亮眼的部分**：`json-file.ts:9` 用 `mode 0o600` + `wx` 独占创建 + 原子 rename；DPAPI 经 **stdin** 传参不走命令行（规避进程列表泄露，`windowsHide: true`）；非 Windows 自动降级为不保存密码；postMessage 后立即 `payload.password = ''` 且 `finally` 再清一次；`execution-store.ts:468` 落盘前用正则硬拦 `protectedPassword|"password"\s*:|dpapi`。
2. **错误脱敏覆盖完整**：所有 DB 错误都过 `databaseErrorDetail` → `sanitizeDatabaseError`，对 `password=`、Oracle 的 `(DESCRIPTION=...)` 做替换；全项目仅 2 处 `console.warn` 且均不含凭据。
3. **资源上限齐备**：行数 ∈ [1,500]、追加 1MiB 字节预算、MySQL 2MiB wire 上限、列 ≤500/8KB、Oracle `maxRows: 501`、worker 1MiB 回执上限；超时分三层（外层 hostDeadline 先发 cancel 再 reject、驱动层 `MAX_EXECUTION_TIME=25000`、连接 15s）；worker 崩溃有 `[500,1000,2000,5000]`ms 退避最多 4 次的恢复路径。
4. **并发行设计有人本考量**：每连接 3 / 全局 16，AI 只取 2/14，AI 排队满时给人让路。
5. **竞态防护是体系化的**：五处 seq 守卫 + `alive` 标志，不是碰巧写对，是有意为之。
6. **类型纪律**：45 个 client 文件零 `any`、零 `@ts-ignore`、仅 2 处 `as unknown as`。
7. **oracle 元数据查询全参数化**：`catalog.mjs` 里 `:1/:2` 绑定、offset 经 `Number.isSafeInteger` 区间校验后才插值。
8. `host-acceptance.mjs:37` 强制插件必须装在 profile 内、不得解析回源码目录 —— 这条防"本地跑通、装上就挂"很到位。

---

## 七、修复路线图

**第一批（建议立即做，都是小改动）**
1. H1 接线 `ApprovalLedger`：`connection-service.ts:354` 后插入校验，UI 落点在已有的 `confirm-write-dialog.tsx`
2. H2 `oracle.mjs:28` 改绑定变量
3. H3 `query-policy.mjs:90` 的 `select` 降级分支改为抛错
4. M1 `#dispatch:874` 补 `entry.session !== session`
5. M9 `build` 链补齐 `check-build` / `check-package`

**第二批（本周内）**
6. M5 + M6 两处 React 状态缺陷
7. M7 三个弹窗接入 `useDialog`（其中写操作确认框优先级最高）
8. M2 + M3 AI 写权限收紧：脱敏与环境解耦、环境标签不单独作为授权依据
9. 删 `package-lock.json` + 钉 `packageManager`

**第三批（节奏性改进）**
10. 客户端已内联依赖下沉 devDependencies
11. 补组件层测试，优先覆盖 `closeTab`  StrictMode 双写 与 切换 table 后旧请求返回 两条用例
12. 抽取 `useEditableGrid` / `GridContextMenu` / `copyText`（当前 4 份 EXPLAIN 正则、3 份 clipboard try/catch、2 份右键菜单）

---

## 八、二审勘误（2026-09-25）

首轮报告经复审，以下条目**撤销或修正**。复核均基于源码实读（grep 全量统计），非推断。

### 撤销 M7 —— 弹窗焦点陷阱问题不成立

首轮称「三个高危弹窗未接入 `useDialog`，其中含写操作确认框」。实测全量 `role="dialog"` 共 8 处，**7 处已接入**：

```
confirm-write-dialog.tsx:16   useDialog(dialog, onCancel, !busy)          ← 首轮点名的"高危项"，实际已接入
connection-form.tsx:39        useDialog(dialog, requestClose)
database-workspace.tsx:51,52  useDialog(disconnectDialog / deleteDialog)
save-experience-dialog.tsx:17 useDialog(dialog, onCancel, open && !busy)
structure-form.tsx:15         useDialog(dialog, close)
visible-schema-dialog.tsx:33  useDialog(dialog, onClose, open)
```

唯一未接入的 `sql-template-library.tsx:305`，其 `role`/`aria-modal` 在嵌入式下为 `undefined`；而全仓唯一调用点 `active-connection-pane.tsx:359` 恰恰传了 `embedded` —— 它是页签内的**非模态面板**，不需要焦点陷阱。**M7 整条撤销。**

教训：该条来自子审查，未逐点验证即采信。弹窗类问题必须以 `useDialog` 的实际 import 清单为准，不能凭文件用途推断。

### 修正 M4 —— HTTP 侧 owner 是设计分工，非疏漏

首轮称「HTTP 侧 owner 仅校验字符串格式」。实读 `register.ts:20` 的注释明确了职责边界：

> 工作台 HTTP 用对话身份做布局分桶；**认证已由 `requestRejection` 完成。**

即 `conversationOwnerId`（:21）**只做布局分桶**，鉴权由宿主 `requestRejection`（:54）承担；同文件 :36 的 `liveOwner` 是给 AI 工具链路用的更严校验。两者各司其职，不是漏用。**M4 从「中危问题」降级为「设计说明」**，无需修改。

### 复核确认成立（证据补充）

三条高危与 M1/M5/M6 复核后**全部维持原判**，证据本轮补充如下：

| 条目 | 复核证据 |
|---|---|
| H1 | `approval-ledger.ts:20` 全仓 grep 仅自身定义行；`connection-service.ts:290` 预留 `confirmExecutionId?` 但 :353-357 write 分支未使用 |
| H2 | `oracle.mjs:28` 确为字符串插值；`ddl-plan.mjs:75` 的 `operation.name` 未经 :7 的 `identifier()` 校验 |
| H3 | `query-policy.mjs:217` catch 静默降级 → :90 select 分支零校验 |
| M1 | `connection-service.ts:874` 只调 `sessionValid(session)`，全文无 `entry.session` 比对 |
| M5 | `active-connection-pane.tsx:268-277` 的 updater 内写 `sqlCacheRef` 并调 `setActive`，StrictMode 下双执行 |
| M6 | `sql-workspace-tab.tsx:44` 依赖数组确为 `[tabId]`，`initialSql` 缺失 |
| M8 | `sql-workspace-tab.tsx:94-97`，`active` 变 false 时 abort，卸载路径无独立 cleanup（但 `return` 分支会随卸载触发，实际风险低于首轮判断，**降为低危**） |
| — | `ai-executions.tsx:130` 的 `items` 冗余依赖确认存在（effect 内不读 `items`，却因列表刷新重发详情请求） |
| — | 五处竞态守卫（`treeSeq:86`/`requestSequence:53`/`searchSeq:87`/`previewSeq:88`）确认存在且实现一致 |

### 三审收缩（2026-09-25，原则：避免过度设计）

连接会话隔离（原 M1）撤销——`releaseOwner`（:873）只终止连接尝试与执行记录、不删连接，8 个 API 入口全部只做 `sessionValid`，连接是 workspace 级共享设计，单用户桌面应用加归属比对反而破坏"多对话窗口共享工作台"。

修复收缩为**两个必改 + 一个决策**：

| 项 | 改动 | 规模 |
|---|---|---|
| H2 | `oracle.mjs:28` 单引号双写转义 | 2 行 |
| H3 | `query-policy.mjs:217` catch 改抛错 | 1 行 |
| H1 | 二选一：a) AI 写直接拒绝（`runSharedQuery` write 分支加 `initiator === 'ai'` 拦截，~2 行，用户侧已有 `ConfirmWriteDialog` 确认不受影响）；b) 接受"SIT 可写"为特性（`ai-tool-guides` 已明示），删除 `ApprovalLedger` 死代码防误导 | ~2 行 |

完整接线 `ApprovalLedger`（原方案跨 4 文件）**搁置**——真需要审批 UI 时再做。其余中危（M5/M6/M9 等）保持推荐但不阻塞，见首轮正文。

### 四审收缩（2026-09-26）

复核剩余未亲自验证的断言，再撤一条、修正一处计数：

**撤销 M3（环境标签自报即授 AI DML）**。实读后确认这是有意的三层设计，非疏漏——`query.mjs:199` 注释：

> 人工通道全环境可写并自动提交；其它入口仍仅 SIT

配合 `environmentLabel` 三档文案（`sit: SIT · 可编辑` / `uat|pvt: 人工 SQL 可写`）与 `normalizeEnvironment` 对未知值 fail-safe 归 `uat`，语义完整清晰：SIT 人工+AI 可写，UAT/PVT 仅人工可写，未识别按保守档处理。首轮给的"对未确认高危标签拒 AI 写"属过度设计，**撤销**。

**修正计数**：bridge 非空断言实测 **43 处**（`maintenance!` 14、`executions!` 14、`templates!` 7、`catalog!` 4、`updateConnection!` 2、`listWorkspace!` 1、`browse!` 1），非首轮估算的"约 45"。

**类型纪律断言复验通过**：client 侧 `: any` / `as any` / `<any>` = **0**，`@ts-ignore` / `@ts-expect-error` = **0**，`as unknown as` = **2**。首轮"零 any"的判断成立。

> 至此原中危已撤 M1、M3、M4、M7 四条。报告收敛结论：**H2/H3 是真漏洞，H1 是产品决策**，其余为可选改进。

### 五审 · 插件家族横向对比（2026-09-28）

仓库新增 `dsh-kafka`、`dsh-redis`、`dsh-plugin-template` 后，把本报告的结论横向套了一遍。**结果与原判断相反——M9 不是"大家都这样"，而是 dsh-database 在家族里唯一掉队**：

| 插件 | build 链 | 规范校验 |
|---|---|---|
| dsh-plugin-template | `tsdown && wrap-client.cjs && check-build.cjs` | ✅ 接了 |
| dsh-kafka | `build.mjs` → :26 `spawnSync(check-build.mjs)` | ✅ 接了 |
| dsh-redis | `build.mjs` → :26 `spawnSync(check-build.mjs)` | ✅ 接了 |
| **dsh-database** | `node scripts/build.mjs`（29 行，无校验） | ❌ **唯一没接** |

kafka/redis 的 `scripts/check-build.mjs` 仅 14 行，断言两项硬门槛后打印 `DSH spec conformance OK`：

```js
if (!client.startsWith('window.__ModuleLoader__.load({')) throw new Error('lib/client.js 必须由 __ModuleLoader__.load 包装')
if (client.includes('\nexport {') || client.startsWith('export ')) throw new Error('lib/client.js 不得含顶层 export')
if (!/\bexport\s+\{|\bexport\s+(async\s+)?function\s+apply\b|\bexport\s+const\s+name\b/.test(host)) throw new Error('lib/index.js 必须是 ESM')
```

**M9 修复成本远低于首轮估计**：照抄 `dsh-kafka/scripts/check-build.mjs`（14 行）+ `build.mjs` 末尾加一行 `spawnSync`，团队已有统一实现，无需新写。

另一项横向观察：kafka/redis 的 `src/host/tools.ts` 目前仅 28 行、只注册 `*_status` 占位工具（描述自陈"topics/messages/produce 尚未接通"），暂无 AI 写能力。因此 **H1 的决策应在 kafka/redis 接入 produce/写入之前定下来**——届时同样的问题会再次出现，届时一并套用同一答案即可。

---

*本报告未修改任何源文件。行号对应 alpha.12.13 工作区状态，勘误部分为 2026-09-25 复核。*

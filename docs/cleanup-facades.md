# 保留的兼容门面与有意不合并的近似重复

D0–D3 的冗余清理删除了根/中间层 re-export 别名、重复注册表和重复规则实现。下面这些文件**有意保留**，不是漏删；新增“看似重复”的代码前先看本表。

## 保留的门面

| 文件 | 保留原因 | 复查 |
|---|---|---|
| `src/host/shared/connection-permission.mjs` | `lib/shared/connection-permission.mjs` 的源码路径镜像。`src/host/*.mjs` 以 `./shared/connection-permission.mjs` 引用，构建后该相对路径必须落在 `lib/shared/`，源码树因此需要同名文件。 | 2026-10 |
| `src/host/shared/limits.mjs` | 同上，对应 `lib/shared/limits.mjs`。 | 2026-10 |
| `src/shared/connection-permission.ts` | client/host 共用类型入口：`Environment` 类型 + 三个权限函数。 | 2026-10 |
| `src/shared/limits.ts` | 同上，跨层查询/结果限额的类型入口。 | 2026-10 |
| `src/shared/primary-keys.ts` | client → host 边界门面；client 不直接 import `src/host/*`，由它转出 `resolvePrimaryKeys`。 | 2026-10 |

`test/structure-gates.test.mjs` 会检查这 5 个文件存在、`src/client` 与 `src/host` 没有新的整文件 re-export shim、也没有跨文件重复实现（豁免名单当前为空）。

## 有意不合并的近似重复

| 位置 | 为什么不合并 |
|---|---|
| `src/host/query-policy.mjs` 与 `src/shared/workbench.ts` 的 `quoteIdentifier` | 前者做 Host 参数校验并走数据源 driver 引用标识符；后者只按方言能力加引号。职责不同。 |
| `ai-query-bus.ts` 的“执行中”判定 与 `ai-executions.tsx` 的 `isTerminalStatus` 判定 | 前者把 `awaiting_confirmation` 视为未完成，后者相反。是有意的产品差异。 |
| `src/host/data-sources/modules.ts` 的 `hostModules`／`getSourceRuntime` 与 `sql-registry.mjs`／`redis-registry.mjs`（`provider-registry.mjs`） | 构建边界造成的有意分离，不是漏删；见下方小节「两套数据源注册层：构建边界造成的有意分离」。 |

### 两套数据源注册层：构建边界造成的有意分离

`src/host/data-sources/modules.ts:34,60` 的 `hostModules`／`getSourceRuntime`（TS 服务侧，被 `connection-service.ts`、`explorer-service.ts`、`knowledge-service.ts` 等使用）与 `src/host/data-sources/sql-registry.mjs:5`／`redis-registry.mjs:4`（基于 `provider-registry.mjs` 的 SQL／Redis Provider 注册表，被 `query.mjs`、`session-manager.mjs`、`maintenance.mjs`、`catalog.mjs`、各 worker 使用）是两套注册入口，但不是可以合并的冗余：

- **构建边界（2026-10-26 以构建产物证实）**：`scripts/build.mjs` 只把 `src/host/**/*.mjs` 原样复制进 `lib/`（`copyTree('src/host/data-sources', 'lib/data-sources')`，过滤条件 `endsWith('.mjs')`），TS 全部被 esbuild 打包进 `lib/index.js` 单文件。发布树里不存在 `modules.ts` 这类文件，被复制树里的 `.mjs` 注册表运行时 import TS 只会 `ERR_MODULE_NOT_FOUND`。证据：`lib/data-sources/` 39 个文件全部是 `.mjs`、`lib/` 内无任何 `.ts`、`lib/data-sources/sql-registry.mjs` 与源文件逐字节相同、`createHostModuleRegistry`／`hostModules` 只出现在 `lib/index.js` 打包体内。
- **运行拓扑**：`.mjs` 注册表的消费者跑在按 `runtime.workerEntry` 起的 worker 模块图里（`src/host/connection-service.ts:772`），与 TS 服务所在的 Host 主线程 bundle 是两个模块图；注册表内容是函数（driver／policy／maintenance），无法跨线程序列化共享。反向（TS import `.mjs`）可行但 esbuild 会内联成私有副本（如 `sql-policy-common.mjs` 的既有特例），得到的是副本而非共享注册表，反而破坏同一对象引用。
- **一致性如何锁死**：runtime 元数据本来就是单源的——每来源只有一个 `<source>/runtime.mjs`，`module.ts` 与 `index.mjs` 都 import 它。`test/source-registry-consistency.test.mjs` 断言两套注册表的注册 id 集合一致（SQL/Redis 域相等，无 Provider 的 `kafka`／`nacos` 显式钉住）、`hostModules.get(id).runtime` 与 `getSqlDataSource(id)`／`getRedisDataSource(id).runtime` 是同一对象引用（`assert.strictEqual`），且 `workerEntry`／`actions`／`requiresPassword`／`documentKind` 一致。runtime 形状校验单源于 `src/host/data-sources/runtime-contract.mjs`（必须是 `.mjs`：只有它能同时被 TS 与被复制树 import）。
- **若要真正合并**：需放弃 raw copy 构建（全部 bundle）或把注册表跨 worker 边界序列化，代价大于收益，未做。原「尚未收敛的根因」第 3 条据此关闭为“已定性 + 门禁锁死”。

## 已核实为不可达的历史差异

| 位置 | 结论与证据 |
|---|---|
| `sanitizeSharedQuery`（`src/shared/workbench.ts`）与 `sanitizeExecutionDocument`（`src/shared/execution-document.ts`）的修订号归一与文本截断 | 2026-10-26 核实为**不可达的历史差异**，从「有意不合并」表移出：规则差异只存在于“读入有多宽容”（前者用 `Number(raw.revision)` 接受字符串数字、按 `SQL_FIELD_MAX_LENGTH`（32768）截 `sql`；后者只接受整数、按 `textLimit` 截 `text`），但没有任何写入方能把字符串数字修订或 >32768 的 sql 写进旧 `sharedQuery`，两者产物形态一致（整数修订 + 受限文本），差异在运行中不可观测。不改行为。 |

证据摘要（谁在写、为什么不可能）：

- **旧 `sharedQuery` 只剩一个落盘出口，且写出前必过 sanitize**：`src/host/conversation-workbench-store.ts:104` 的 `ConversationWorkbenchStore.save()` 写出前必经 `sanitizeConversationWorkbench` → `sanitizeConnectionWorkbench` → `sanitizeSharedQuery`；`aiDocument` 一旦存在，`sharedQuery` 直接删除（`conversation-workbench-store.ts:23`）。连接文件更不保存它：`src/host/saved-connections.ts:70-77` 落盘前整体剥离 `workbench`（字段注释“仅读取旧文件时暂存，落盘前剥离”）。
- **客户端写不进来**：HTTP `workbench` 补丁在 `src/host/connection-service.ts:308` 把 `sharedQuery`／`aiDocument`／`aiCollab` 全部解构丢弃后才合并落盘；客户端补丁本身只含 `{schema, queryTabs, activeTabId}`（`src/client/sql/workspace-bindings.tsx:106`）与 `{visibleSchemas}`（`src/client/workspace/shell/workbench-shell.tsx:245`）。
- **Host 侧写入方只产整数修订与 ≤32768 的 sql**：历史写入函数 `applySharedQueryPatch`／`takeSharedQueryControl`／`returnSharedQueryControl` 的修订号一律是 `previous.revision + N`（`previous` 只能是 `sanitizeSharedQuery` 输出或 `emptySharedQuery()` 的 1），sql 一律 `String(patch.sql).slice(0, SQL_FIELD_MAX_LENGTH)`；浏览器补丁只放行 `sql`／`schema` 两键（`src/host/sql-browser-request.ts:26`），`revision` 只做 `Number.isSafeInteger` 的期望修订校验、从不写入。现已改为写执行文档，`updateExecutionDocument` 同样只做 `previous.revision + 1`。
- **git 历史里不存在写出字符串修订的版本**：仓库首个代码提交（`1a43b10`，2026-09-30）的上述写入方即为整数运算 + 32K 截断，落盘值恒为 `sanitizeSharedQuery` 的输出，没有更早版本可查。若远古磁盘文件真带字符串修订，读入时 `Number(raw.revision)` 会先归一为整数再落盘，产物上不会与 `sanitizeExecutionDocument` 分叉（刻画用例：`test/database-workbench.test.mjs`）。
- **>32768 的 sql 同理不可达**：65536 的文本上限只存在于 `aiDocument.text`；文档 → `sharedQuery` 的投影（`src/host/saved-connections.ts:178`、`connection-service.ts` 的 `getSharedQuery()`）只进 HTTP 响应、不落盘，客户端回写又被 `saveWorkbench` 丢弃。旧 `sharedQuery` 迁进文档走 `legacySharedQueryDocument()`，文本天然 ≤32768，不受文档 65536 上限影响。
- **context 一侧的差异随文档退役**：`sanitizeSharedQuery` 没有 context 概念（只有顶层 `schema` ≤128），context 约束（≤12 键、键 ≤80、值 ≤256）只属于文档 schema；旧 `sharedQuery` 迁移时 context 由 `legacySharedQueryDocument()` 派生（`schema` 单键），同样不会带入超限 context。

## 2026-10-23 收敛同步

本轮把下面几处近似重复收敛到单一实现；遇到同类需求先复用这些入口，不要再各写一份。

- `src/shared/execution-document.ts` 新增 `isDocumentRevision`／`assertDocumentRevision`，文档修订号的校验与比较统一走这两个函数（原先约 10 处直接比较、7 种文案）。各处文案按原样逐处传入，文案保持不变，未统一。
- `src/host/text-operation-runner.ts` 派发前的 context 复核改用 `sameStringMap`，不再用 `JSON.stringify` 逐键比较。`JSON.stringify` 对 key 顺序敏感，等价 context 会被误判为改过目标；这是行为修复，不是等价改写。
- `nativeDriverError`／`driverErrorFields` 从 mysql／oracle driver 收敛到 `src/host/connect-error.mjs`，两个 driver 复用同一实现；mysql／oracle maintenance 的 `wanted` 收敛为共享 `DML_PRIVILEGES`（`src/host/data-sources/maintenance-error.mjs`）。

## 已知缺口与仍开放的取舍

原「尚未收敛的根因」三条已于 2026-10-26 全部处置（切分统一、内部读取单源、依赖根因修复）；同轮后续又关闭了 `lastRun` 缺口、结果采纳两套契约与两个 sanitizer 的规则差异（见下节与上文「已核实为不可达的历史差异」）。剩下的不是重复实现，而是需要产品决策或有意保留的取舍：

1. **`SharedQuery` 公共投影的退役时间点**：`sharedQuery` 现在只剩两个身份——`src/host/saved-connections.ts:176` 的公共兼容投影、旧持久化数据的迁移输入（`src/shared/workbench.ts` 的 `legacySharedQueryDocument()`）。内部代码已不再读它（`test/structure-gates.test.mjs` 有门禁）。彻底删除需要客户端同步改造与旧数据迁移窗口。
2. **`GRID_ROW_HEIGHT` 偏差**（非缺陷）：`src/client/query-detail-layout.ts:1` 的 `GRID_ROW_HEIGHT=28` 与实际行高（`--db-row-height: 34px`，实测 td 37px）不一致，detail 展开时保留行数的预留偏小；现有 `>= 80` 断言稳过，如需精确对齐由该文件持有者校准。

## 2026-10-26 收敛同步

- UI 验收两条长期失败的根因已定位并修复，且**均为脚本／fixture 问题，产品行为未改**：
  - `npm run test:theme-ui`：Kafka 来源有意 keep-alive 双挂载两个 `KafkaOverview`（`src/client/data-sources/kafka.tsx:67`，未激活者 `hidden` 保活），脚本用类选择器 `.db-search-tree-toggle` 定位抽屉开关必然撞两个节点。改为按可访问名定位（`getByRole('button', { name: '打开 Topic 列表', exact: true })`），断言强度不变，strict mode 仍能拦真正的同名重复。
  - `npm run test:ui`：fixture 给了 80 行结果却没传 `resultKey`，与产品契约「有结果必有 `resultKey`」（`src/client/workspace/source/source-workspace.tsx:178`）不一致，紧凑视图停在 `showing-editor`，结果面板 `display:none` 导致 cell 0×0。补 `resultKey` 后按产品状态机自动切到结果视图；折叠往返那组按钮只存在于分栏布局，故改到 768×600 视口执行。紧凑视图契约另有 `scripts/plugin-ui-acceptance.mjs`、`scripts/source-module-ui-acceptance.mjs` 固化，不应改产品。
- 已验证的 UI 子集（`test:plugin-ui`、`test:public-ui`、`test:grid-copy`、`test:theme-ui`、`test:ui`）进入 CI 的 `ui` job；其余 UI 脚本需要真实服务或未在本轮验证，暂不入 CI。
- 测试墙钟时序消除：`database-lifecycle`／`kafka-worker`／`nacos`／`sql-completion-source`／`bounded-parser` 从「断速度」改为「断完成顺序／钉死配置值」（如并发独立性改断「快请求在慢请求仍 pending 时完成」，截止值改用 mock timers 钉死）。20 核压满负载下以 `--test-concurrency=8` 复跑通过；并用探针证明旧的 `fast < 1500ms` 在主线程被饿死 2s 时每轮必假失败。
- SQL 授权切分统一到方言感知：`splitStatements` 不再手写扫描，改为复用 `enumerateStatements` 的方言区域扫描再套原后处理（trim、剥尾随 `;`、丢纯注释段、前导注释仍附着）。三条历史差异按方言修正（**有意的行为变化**）：MySQL 下 `--x` 无空格不再吞掉分号、双引号内反斜杠不再误切、Oracle 的 `#` 不再当注释（MySQL 的 `#` 注释保留）。授权与执行仍共用同一入口（`src/host/query-policy.mjs` 的 `splitStatements`），逐段授权、逐段执行的结构未变，语句计数（`MAX_AI_STATEMENTS`）随之与授权段数一致。原「有意不合并」表中的对应条目已撤销。
- `SharedQuery` 内部读取单源化：`src/host/ai-tools.ts`、`src/host/workbench-editors.ts`、`src/client/schema/refresh.ts`、`src/client/sql/workspace-bindings.tsx` 改读 `aiDocument`／文档派生值，旧 SharedQuery → 文档的迁移输入投影收敛到 `src/shared/workbench.ts` 的 `legacySharedQueryDocument()`。`sharedQuery` 只剩公共投影与旧数据迁移两个身份，`test/structure-gates.test.mjs` 新增门禁禁止别处再读。同轮证实了 `lastRun` 缺口（本轮后续已修复，见下条）。
- npm 默认安装根因修复：`@deepseek-ai/cordis` 对齐到 `4.0.5`（满足 `cordis-plugin-include` 的 `cordis@~4.0.5`），lockfile 以**默认 peer 解析**重生成（`dsh-agent-presets`、`dsh-agent-default-model`、`cordis-plugin-loader`、`cordis-plugin-include` 等 30 个 peer 包首次真正入树）；`npm ci`／`npm install` 零参数即可用，CI 与 `.npmrc` 的 `legacy-peer-deps` 绕过随之删除。同时 `peerDependencies` 全部改为只设兼容下限、不设上限（`@deepseek-ai/cordis >=4.0.2`、`dsh-session`／`dsh-tools >=0.1.2-rc.1`、`react`／`react-dom >=18.0.0`）；`dependencies`／`devDependencies` 仍精确钉死，保证 `npm ci` 可复现。
- 两套数据源注册层定性完成（见上文「两套数据源注册层：构建边界造成的有意分离」）：构建边界证实成立，处置为文档化 + 门禁锁死，不硬合并。同步把两处重复的 runtime 形状校验收敛为单一实现 `src/host/data-sources/runtime-contract.mjs`（`modules.ts` 的 `createRuntimeRegistry` 与 `provider-registry.mjs` 的 `createDataSourceRegistry` 共用；放在 `.mjs` 是构建边界使然）。收敛带来的唯一行为变化：`provider-registry.mjs` 现在也校验 `actions` 元素是非空字符串且无重复（原先只查数组非空），现有 Provider 全部通过；错误文案不变。
- `lastRun` 视图缺口修复（**有意的行为变更，已批准**）：匹配与摘要逻辑抽成 `src/host/connection-service.ts` 的 `lastRunFromExecutions()` 纯函数，`getSharedQuery()` 与 `snapshot()` 共用同一实现、同一份执行记录；`publicConnection()` 增加可选 `lastRun` 入参，只在 SQL 文档重建 `sharedQuery` 投影时补入，无记录时字段不存在；`workbench-editors.ts` 经 `saved-connections.ts` 的 `projectedLastRun()` 读取（公共投影仍是 `sharedQuery` 的唯一读者）。`getSharedQuery()` 返回值不变，不落盘、不新造来源；`database_read_collab` 随之可达。测试：`test/shared-query-document-source.test.mjs`（同源整对象/逐字段、可见性规则、无记录不出现空对象）。
- 结果采纳两套契约统一：`ResultOwner.context` 改为必填，`matchesResultOwner()` 只比较完整 `context`（删除 schema-only 分支），`use-execution-document.ts` 的 `resultOwner()` 对 mysql/oracle 也返回完整 `context`，`text-operation-runner.ts` 不再在回执顶层附 `schema` 快照（`sqlDisplay()` 仍由 `identity.context.schema` 派生显示用 schema）。可达性依据：SQL 源的 `normalizeContext()` 只产出 `{ schema }` 单键 context，因此旧的 schema-only 分支在真实输入上与完整 context 比较等价；新增用例钉住“只带 schema 的 owner 不再判定归属”。`test/execution-state-matrix.test.mjs`、`test/fact-adoption.test.mjs`、`test/sql-receipts.test.mjs` 覆盖。
- `sanitizeSharedQuery` 与 `sanitizeExecutionDocument` 的规则差异核实为不可达（见上文「已核实为不可达的历史差异」），不改行为；`test/database-workbench.test.mjs` 新增刻画用例钉住落盘产物不变量。

## 新增门面的规则

1. 先确认它不是上面这些“有意不合并”之一。
2. 门面必须说明构建路径或边界原因，并登记在本表。
3. `test/structure-gates.test.mjs` 的 `RETAINED` 列表同步更新。

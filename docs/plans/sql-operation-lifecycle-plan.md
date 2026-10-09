# SQL 执行生命周期收口计划

2026-10-02 后续进展：主要 SQL 文本入口及模块声明的实施规格见 [SQL Host 标准文本接入](sql-standard-text-plan.md)，当前接口见 ../data-source-architecture.md。下文保留当轮事实与验收，不作为最新模式声明。

状态：本轮已实施完成，进度与实际证据见 ../data-source-foundation-progress.md。2026-10-01 已验证现有四源测试实例的无豁免 Web 安装；Oracle 19c Service 已通过，SID／真实 Desktop GUI／真实模型仍 NOT_RUN。下述实施前规格保留；用户确认复用现有测试容器的调整及已知解析器并发超时见实施记录，不能以计划替代实际验收报告。

## 1. 本轮交付与后续顺序

四源客户端工作台已经统一。下一轮先将 SQL 共编执行 `runSharedQuery()` 和执行计划 `explainPlan()` 的记录、取消、派发与终态接入 `runOperation()`，保留 SQL 原授权、执行与结果语义。

本轮不把 MySQL／Oracle 模块改名为 standard-text。只有普通查询、AI 查询、执行计划及授权差异均有明确适配后，才能另行切换该声明。Host legacy-adapter 在本轮仍是真实边界。

后续顺序：

1. 本计划：两个已有记录的 SQL 执行入口复用公共生命周期。
2. 后续独立计划：SQL 目录等结构化 AI 工具复用生命周期，处理 ai-tools.ts 的 withRecord；状态、经验和无连接工具分别确认，不能强制套用必须有连接的 OperationBinding。
3. 后续独立计划：普通 SQL 查询和经验试运行的标准文本适配，先决定当前没有 Host 主记录的入口是否新增历史，再设计批量与单步记录关系。
4. 按实际收益评估 SQL AI 文档接口和经验状态复用，继续保留 SharedQuery 物理字段、SQL 相似分析和每条经验独立草稿。

只修改本插件，保留全部已有修改。不得整体重写 Worker、查询池、SessionManager、客户端工作台或存储。

## 2. 当前代码事实与迁移边界

| 入口 | 当前调用与记录 | 本轮处理 |
|---|---|---|
| 普通查询／经验试运行 | connection-bridge 的 execute／executeManual → query／manual-query → request；该链本身不创建 Host 执行主记录 | 保留；不统一增加记录 |
| 人工执行 AI Query | shared-query-run → runSharedQuery，自建记录及控制器 | 迁入公共生命周期 |
| AI 执行 SQL | 已注册执行工具 → runSharedQuery；保留 callId/rootCallId、verify/result 和输出脱敏 | 迁入同一生命周期，不再外包第二条记录 |
| AI Query 执行计划 | shared-query-explain → explainPlan，自建记录及控制器 | 迁入公共生命周期 |
| SQL 目录／经验／状态工具 | ai-tools.ts 的 withRecord 和各工具自己的 complete | 保留，后续逐类处理 |
| 表数据浏览与维护 | browse／maintenance，确认、结构检查、事务与进度有专属语义 | 保留 |

已经确认的接口缺口：

- runOperation 当前创建记录时强制 historyVisible=true，且缺少 SQL schema/sql/tables/executedSql/draft/reason 等元信息；直接替换会改变历史展示。
- runOperation 的成功完成只传摘要；SQL 旧路径会传 Result、结果预览和 conclusion，必须继续经 ExecutionStore 的限量保存。
- SQL 两个入口在调用 request 前就记 dispatched，实际请求还可能等待配额；正确标记点应为 #dispatch 中 postMessage 成功以后。
- runSharedQuery 的控制权／修订检查主要在排队前。授权和排队期间的接管、改文及目标变化需要在派发前再验证。
- SQL 路径存在匿名 abort 转发；AI 执行工具又通过 mergeSignal 包装，缺少对称清理。
- ExecutionStore 已有终态保护；迁移不能让记录保持 unknown 而返回事件硬编码 succeeded。

## 3. 文件、方法与归属

下列新增方法名为拟定名称，可按实际类型调整，但职责不得合并到含糊的万能执行函数。

| 文件 | 修改原因与具体内容 |
|---|---|
| src/host/operation-runtime.ts | 扩展可信记录元信息、成功结果投影、延后 check-passed、执行回调中的 executionId 和真实终态；继续统一创建／结束记录和清理 |
| src/host/execution-store.ts | 优先保持实现，只在需要共享类型时导出创建／完成参数类型；保留预览限量、脱敏、终态幂等和持久化格式 |
| 新增 src/host/sql-operation.ts | SQL 专属生命周期适配：记录元信息、结果／模型投影、终态分类和事件载荷；供 MySQL／Oracle 共用，不解释驱动差异 |
| src/host/connection-service.ts | 改造 runSharedQuery／explainPlan；request 透传 Host 内部派发钩子；保留 #acquireRun/#releaseRun 和已有队列，只执行一次 |
| src/host/ai-tools.ts | 执行 SQL 工具直接传 execution.signal，移除该调用多余的 mergeSignal；保留其他未迁移工具的 withRecord，不整文件删除 |
| src/host/connection-api.ts | 锁定旧 action／返回形状；验证人工来源边界。若客户端依赖浏览器传 initiator=ai，先按第 8 节处理，不静默修改 |
| test/operation-runtime.test.mjs | 新接口默认兼容、记录元信息、预览、终态、派发及清理 |
| test/database-ai.test.mjs | 真实工具注册、原输出字段、脱敏、权限、单记录和事件数量 |
| 新增 test/sql-operation-lifecycle.test.mjs | 实际 ConnectionService、受控 Worker、配额／接管／改文／代次／取消竞争 |
| 新增 test/fixtures/sql-operation-worker.mjs | 只用于隔离测试，显式控制接收、回复、错误和退出；不进入生产注册或发布包 |
| test/execution-store.test.mjs | 核对 SQL 历史可见性、限量预览和已有终态不变 |
| scripts/sql-workspace-ui-acceptance.mjs | 扩展当前实际公共挂载的运行／停止／接管／迟到结果检查 |
| scripts/installed-business.mjs | 仅在缺少相关安装断言时扩展；不改变产品交互或定位放宽 |
| docs/data-source-foundation-progress.md、架构说明、接入指南 | 逐阶段记录代码、保留边界和同源码证据，不把本轮写成全部 SQL 执行统一 |

不预先修改 MySQL／Oracle module.ts、共享 DataSourceId、客户端绑定和 Worker 协议。新增 Host TS 文件由现有 Host bundle 引用；若改成独立运行时文件，必须同步打包并说明原因。

## 4. 公共外围的最小扩展

### 4.1 可信元信息

扩展 runOperation 的 Host 内部 metadata，显式允许 schema、tables、sql、executedSql、draft、reason、conclusion、historyVisible 等现有记录字段。不能接受任意对象覆盖 conversationId、connectionId、generation、initiator 或 callId。

SQL 适配显式传原值；Redis／Kafka 省略新增字段时沿用当前默认值。SQL 不得被公共默认 historyVisible=true 改变原展示方式。所有字段继续由 ExecutionStore 进行原限量和脱敏处理。

### 4.2 结果投影

新增可选 `projectCompletion(result)`，返回现有 complete 所需的 message、受限 Result 和 conclusion。实际结束记录仍由 runOperation 调用一次 complete，适配不能自行再次 complete。

SQL Result 使用当前字段、预览限制和批量摘要。Redis／Kafka 未提供投影时保持现有行为，不持久化 Redis 值或 Kafka 消息正文。模型输出仍在 SQL 工具出口按环境脱敏。

### 4.3 执行上下文

保留原 authorizedWork(signal, markDispatched) 调用兼容；增加第三个 Host 内部上下文参数，至少提供 executionId、markChecked()。SQL 使用显式延后检查标记：记录先创建，原授权失败仍能结束原记录，授权成功后才产生 check-passed。

当前 Redis／Kafka 默认行为保持。不得为本轮改动改变所有调用的事件顺序。

markChecked、markDispatched 均幂等。已终态记录不得被迟到标记重新激活。onFinished 必须携带实际记录终态；必要时扩展为包含失败原因的结构化通知，但错误仍经过原脱敏出口。

### 4.4 SQL 中断策略

新增 `classifySqlInterruption()`，以现有 executionStop、Host 超时规则及当前 explainPlan 行为建立逐入口基线。不得复制 Redis“派发后所有错误均 unknown”的规则。

固定共性：

- postMessage 前取消：没有 dispatched，按已有取消语义结束。
- 授权／修订／目标复核失败：failed，不派发。
- postMessage 后取消：SQL 共编执行沿用当前 unknown 语义；不能宣称服务端撤销。
- Host 查询超时：保留当前 failed 文案及状态。
- 已由取消／断线／代次失效写入 unknown 或 cancelled：保留该终态。
- 明确数据库错误与正常完整响应：按当前 SQL 语义处理，迟到结果不覆盖已有终态。

explainPlan 与 runSharedQuery 当前分类有差异。先记录行为，再保留入口策略；若要统一其用户可见状态，必须作为明确偏差单独说明，不能隐藏在公共默认值中。

## 5. 派发前复核和 SQL 服务迁移

### 5.1 request 的内部钩子

request 最后增加可选 Host 内部选项 `{ beforeDispatch, onDispatched }`。HTTP 不解析、不转发这两个字段。

回调放在原队列的 work 内：配额获得 → 重新取实际连接 → beforeDispatch → #dispatch → postMessage 成功 → onDispatched。只经过原有一次队列。beforeDispatch 完成后的最终比较与 postMessage 之间不得插入新的异步等待。

普通 query/manual-query/browse/maintenance 未传选项时保持原路径、人工保留通道和配额。发送失败、提前取消或复核失败不得产生 dispatched。

### 5.2 runSharedQuery

1. 保留真实身份、连接、SQL 数据源、generation 和语句数校验。
2. 保留 verify/result 判定、是否占用运行锁、AI 发布实际 SQL 的原顺序。
3. 由 runOperation 创建唯一记录；通过执行上下文关联 #connectionRunning 和 EXECUTION_STARTED。
4. 使用原 authorizeStatement、环境权限和 TrustedAuthorization，不迁移或简化解析算法。
5. 授权成功后记录检查事件及原 tables/type/draft 等注释，捕获已发布的 revision、SQL、schema、controller 和 generation。
6. 在派发前再次核对捕获值。AI 接管、修订／文本／Schema 变化或重连后拒绝尚未派发操作。人工选中执行允许执行文本是文档片段，不能错误要求片段等于整份文档；应验证其所属文档修订和原快照。
7. 调用原 request/query，保留 limit、batch、rows、affectedRows、timings 和原结果／模型投影。
8. 用公共实际终态发布一次原完成／失败事件；保持 verify 隐藏结果、写操作显示结果等原规则。迟到完成不能更新新文档 lastRun。
9. 所有出口释放原运行锁和公共控制器，包含记录创建失败、授权失败和 Worker 发送失败。

不得用新记录包住旧 runSharedQuery 记录；替换必须发生在原生命周期处。不得把一条批量中的每个结果块改成新顶层记录。

### 5.3 explainPlan

复用同一外围，保留原 EXPLAIN 输入、SQL 方言处理和结果类型。记录仍为 explain，原 operation/title/reason/queryRevision 保留。运行锁、原 query 请求与结果事件迁移后只保留一份。

### 5.4 AI 工具

SQL 执行工具继续调用 runSharedQuery，并直接传工具原 signal。真实 session/callId/rootCallId 继续从工具上下文取得；UAT/PVT 输出脱敏、verify/result、action=read 及工具名全部保留。

withRecord 仍被其他工具使用，本轮不能删除。mergeSignal 只有在全部调用迁出后才能删除；本轮只删除 SQL 执行处的冗余包装。

## 6. 分阶段实施、验证和删除

| 阶段 | 工作 | 进入下一阶段的门槛 |
|---|---|---|
| S0 | 保存 git status、源码摘要、旧输出字段／记录／事件矩阵；重跑 check | 明确当前基线和旧失败，不能引用上轮 548 项代替 |
| S1 | 公共元信息、结果投影、生命周期上下文和测试 | 公共测试通过；Redis／Kafka 默认行为不变；SQL 预览不丢失 |
| S2 | request 内部钩子、真实服务排队 fixture | 派发前零请求、成功发送一个标记；没有第二层配额；既有 SQL 查询回归通过 |
| S3 | runSharedQuery、explainPlan 和执行工具迁移 | 单主记录、原结果及权限、锁清理、终态事件和迟到保护通过 |
| S4 | 公共工作台与两库实连、四源回归、无豁免安装 | 同源码报告齐全，已知失败有解释，未执行环境单独列出 |

通过相关回归后才删除：两个方法内重复 create/attachAbort/complete、匿名外部取消绑定、排队前 dispatched、硬编码成功终态以及 SQL 工具的多余信号包装。

保留：授权解析、记录注释、SQL 结果投影、SharedQuery 文档发布、运行锁、事务／重试、批量、维护、未迁移工具生命周期。方法名或代码相似不是删除理由。

## 7. 必须验证的场景

- 单次人工共编、真实注册 AI 工具、执行计划各仅一条主记录；保留类型、可见性、callId/rootCallId、revision、SQL 和结果预览。
- 配额占用采用显式释放的 Worker fixture。分别在排队中接管、改文、改 Schema、重连和取消，目标执行次数为零。注意 AI 通道满额时当前可能立即拒绝；用原维护互斥等待或确定的异步授权点制造可等待情形，不能为测试改变配额策略。
- selected SQL 不等于整份文档仍可正确运行；文档所属修订变化后拒绝旧操作。
- 真正发送后只有一个 dispatched；发送失败、提前取消、授权拒绝没有该事件。
- 成功／失败／取消／超时／断线／同步抛错均释放监听器和控制器；下次操作仍可执行。
- 取消与结果竞争时，记录、HTTP 返回状态及工作台事件一致；迟到结果不覆盖历史终态和当前编辑器。
- SQL 共编 SIT 写入、UAT/PVT 拒绝保持；普通人工查询页三种环境的既有规则保持，不能把两类入口混用。
- SHOW、系统对象、链接、锁定读、文件写入和未开放语法继续受原策略限制。数据源错误按原文返回，不再改写或脱敏。
- verify 不抢占当前结果，批量单步重试／继续、维护确认、网格编辑和经验试运行保持原行为。
- Redis 命令／读取、Key 补全不记历史、Kafka 有界读取和取消无回归。

测试命令（新增测试文件后）：

```powershell
npm run typecheck
node --experimental-strip-types --test test/operation-runtime.test.mjs test/execution-store.test.mjs
node --experimental-strip-types --test test/sql-operation-lifecycle.test.mjs test/database-ai.test.mjs test/ai-query-sync.test.mjs
node --experimental-strip-types --test test/sql-execution.test.mjs test/sql-batch.test.mjs test/query-policy.test.mjs test/query-retry.test.mjs
npm run test:sql-workspace
```

最终冻结源码后串行执行：

```powershell
npm run check
npm run test:sql-workspace
npm run test:source-module
npm run test:ui
npm run test:completion-ui
npm run test:workspace-races
npm run test:workspace-ui
npm run test:mysql
npm run test:oracle
npm run test:redis
npm run test:kafka
npm run test:package-closure
```

随后在专用进程中无豁免安装：

```powershell
Remove-Item Env:DSH_TEST_ALLOW_VERSION -ErrorAction SilentlyContinue
$env:DSH_DESKTOP_APP = 'D:\install\DeepSeek Harness'
$env:DSH_TEST_DATABASES = '1'
$env:DSH_TEST_REDIS = '1'
$env:DSH_TEST_KAFKA = '1'
npm run test:host
```

只使用本轮拥有且核对标签／ID 的容器。MySQL、Oracle 分别报告；Oracle Free 不替代 Oracle 19c／SID。真实 Desktop GUI、真实模型、业务集群和未实测 Redis Cluster／Sentinel 保持 NOT_RUN。

## 8. 偏差与停止条件

当前 connection-api 的 shared-query-run 接受浏览器 initiator=ai，shared-query-update 接受 source=ai/system。不能在迁移时把这些字段当成可信身份继续扩散，也不能顺带静默改变兼容行为。S0 列明实际调用者：新 Host 内部生命周期只接受服务端身份；若收紧旧入口需要修改已有外部调用，单列修订方案后再实施该部分。客户端正常人工路径与 Host 工具路径分别验证。

以下情况暂停受影响步骤：需要新增普通查询历史、修改持久化格式、改变权限或确认语义、改变状态展示、迁移 SQL 执行算法、增加公共产品 ID 判断，或无法保留旧结果／批量形状。

保存最小复现、实际调用链及影响范围，区分已有缺陷、过时测试、计划错误和本轮回归。文件名／位置可按实际调整并记录；权限、数据、用户交互或支持范围变化须提出具体修订。不得放宽权限、删有效测试、吞错误或用受控 fixture 冒充实连。

## 9. 完成定义

SQL 共编执行和执行计划复用 runOperation，记录、取消、派发和终态只维护一份；MySQL／Oracle 的原执行、文档、历史及权限行为通过回归。普通查询、目录工具和维护仍明确保留原路径。验收报告绑定源码摘要、命令退出码和安装目录。

本轮结束后再制定普通 SQL 标准文本接入计划。不得将两个入口的迁移表述为“全部 Host SQL 已统一”。

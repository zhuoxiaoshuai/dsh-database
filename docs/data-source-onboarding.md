# 数据源接入指南

## 2026-10-05 执行与结果契约

来源适配只准备、授权和解释本源操作；不维护另一份文档或当前结果。Host 负责捕获必填 `DocumentExecutionIdentity`，来源通过 `projectLiveResult` 提供结果载荷。共编直接响应、错误回执和事件携带原身份；客户端统一使用 `useDocumentResultBus.accept`，不能在编辑器安装结果或补出执行目标。

准备结果以 `sourceKind` 区分，SQL 专属入口和 Worker 授权证明定义在 SQL 适配。授权阶段返回分析，外层记录元数据后复核原快照，再使用现有队列派发。旧 action 只转换协议边界，不得另定修订或权限规则。

HTTP 回包缺失、截断或无效时不能推断写入失败。新增来源需要验证提交后丢回包仍为 unknown，并且没有再次发送。真实环境未运行应保留 NOT_RUN；参考 `scripts/http-browser-receipt-fault-probe.mjs` 的独占临时数据库与浏览器故障验收。

基于 2026-10-03 当前实现。事实优先级为当前代码、当前需求、当前调用链、当前验收；历史计划不能替代这些依据。

## 1. 开始前

浏览器声明不是执行身份或授权证明。现有 SQL 共编接口通过 `sql-browser-request.ts` 和 `updateSharedQueryFromBrowser` 限制可写字段；内部工具仍使用可信服务调用。新增源不得由浏览器指定 ai/system 来源、结果字段或记录元信息。SQL 格式化使用当前 Host SQL 与真实方言验证，不套用到其他命令模型。

客户端仅支持 `standard`，四源 Host 文本能力均为 `standard-text`。MySQL／Oracle 通过共享 SQL 客户端绑定和 createSqlTextExecution 分别接入；共编文档统一使用 ExecutionDocument，SQL Worker 和结构化维护保留专属适配。先定义本源真实连接配置、对象、可执行文本、上下文和结果，再实现差异能力。不要伪造 schema/table/database 等 SQL 字段。

共享类型目前是封闭联合类型，新增源需要显式扩展，并逐项修正类型检查指出的穷尽分支。当前 family 和 descriptor 也按既有类别声明；差异较大的新 family 必须扩展对应类型并验证，不得为了编译把新源伪装成 Kafka。测试 fixture 的类型绕过仅用于隔离验证。

SQL 目录生命周期可参考 `sql-catalog-operation.ts` 与 `ConnectionService.executeCatalogTool()`：结构化读取可以复用 runOperation 而不转换为可执行编辑文本。派发标记只能来自实际 Worker 发送，缓存命中不得伪造 dispatched；同一次工具中的多个底层请求共用一条主记录。工具参数确定的读取目标不跟随编辑器变化，不套用共编控制权要求。工具输出保留原字段，executionStatus 是内部信息。测试参考 `test/sql-catalog-lifecycle.test.mjs`，其工具注册和服务是真实实现，Worker 是可控 fixture，不能宣称业务环境或模型实测。

标准文档复用 `useExecutionDocument` 的控制／保存队列。接管可能增加 Host revision，控制响应不能仅因本地有新输入就丢弃修订基准；不得在控制请求尚未确认时另起独立保存链。交还期间继续输入要保留本地草稿并恢复 Host 人工控制，不自动执行。对应竞态验收使用真实 controlExecutionDocument 模拟“服务端已修改、响应迟到”，并核对卸载后没有排队控制请求。

## 2. 实施顺序和文件归属

| 顺序 | 实际入口 | 必须完成 |
|---|---|---|
| 1 | `src/shared/data-sources/types.ts`、`src/shared/workbench.ts` | 稳定 ID、Dialect、判别连接输入／保存配置、纯描述类型；SQL 范围保持 SQL 专属 |
| 2 | `src/shared/data-sources/<source>.ts`、`registry.ts` | 名称、能力、纯函数；不导入 React、Node、驱动或 Host |
| 3 | `src/host/data-sources/<source>/connection.mjs`、`module.ts` | 验证、指纹、保存配置规范化；必要时 sameLogin、requiresPassword、toSavedSettings |
| 4 | `src/host/<source>-worker.mjs`、源目录 `runtime.mjs` | Worker 握手、受限 actions、请求/取消/超时/资源释放；驱动只在 Worker 路径加载 |
| 5 | 源目录 `execution.ts` | normalizeContext、prepareText、authorize；产生 action/input、摘要和可选终态分类 |
| 6 | 源目录 `explorer.ts`、`ai-tools.ts`、`knowledge.ts` | 对象读取、工具注册与文档投影、经验存储适配和分析 |
| 7 | `src/client/data-sources/<source>.tsx` 及源目录组件 | 表单、总览、编辑器、补全、结果、历史详情；返回 standard bindings |
| 8 | 下表静态绑定及构建 | 两端声明一致、导入闭包、Worker 完整、测试源不进发布包 |

连接接口以 `src/host/data-sources/module-types.ts` 的 HostSourceModule 为准。保存服务继续负责 ID、保护字段和落盘；源模块规范化普通配置。沿用现有密码／CA 保护流程与快照投影，测试新候选成功后才替换旧连接。若新源有当前保护流程未涵盖的敏感字段，先分析并扩展明确接口，禁止放入普通设置或借用无关字段。导入、复制、编辑和恢复必须走同一适配。

客户端接口以 `src/client/data-sources/types.ts` 的 ClientSourceModule 为准；StandardSourceBindings 从真实 SourceWorkspaceProps 分布式省略宿主属性，不另建易漂移的接口。StandardSourceMount 先创建公共导航，再将 navigation 传给 useBindings。命令型模块提供 overview、Editor、Result、runText 等属性；多页签模块提供 SourcePages 的初始化、描述和逐页内容。公共层创建页签、页面容器和状态栏，模块不返回完整工作台或 wrap。EditorContext 不透明；executionContext/key/label 分别用于 Host 目标、客户端比较和用户目标提示。

多页签参考 `src/client/sql/workspace-bindings.tsx`。每个页面必须有稳定 ID；describe 只投影标题和关闭属性，content 只返回单页内容，keepMounted 显式声明是否保留隐藏内容。源自行保存不透明载荷，navigation 只处理 ID。SQL 保留旧 home/sql:*/object:*/ai/templates 标识及保存格式；新源不能依赖这些 SQL 标识。

AI 使用公共 AiQueryFrame。四源共编使用同一个 ExecutionDocument hook，SharedQuery 仅为兼容投影；工作台、历史和文档共享执行订阅。经验使用 KnowledgeLibrary 的展示行、元信息、analysis 和 execution 内容；保留 SQL 分析策略可参考 useSqlKnowledge，不复制列表和整页布局。

### 文档、回执与导入接口

新增文档入口只调用既有 edit/control/run，不自行覆盖文本或修订。在线请求必须携带 generation 与 revision；离线编辑仍须 revision，不能执行。执行响应和事件须携带原始完整身份；展示层不能用当前目标补全旧结果身份。Redis/Kafka 的完整文本仅用于即时及内存归属，持久历史继续遵守来源载荷过滤。

SQL 回执统一经 sqlReceiptSteps 归一化，steps 是逐项事实，batch 只是有界展示；新预览携带 stepIndex。保留旧记录无 steps 的单结果显示，不推造逐项提交事实。来源授权必须对根节点、子查询、派生表和 CTE 同样应用禁止规则。

每个工作台在绑定层只创建一份 useExecutionDocument，编辑器及历史等入口消费同一控制器。edit(text, context) 把文本与目标作为一次人工编辑排队保存；unsaved 是只读状态。执行、格式化及交还复用队列；保存失败保留最新草稿并显式重试。客户端不通过 shared-query-* 修改 SQL 文档。文档恢复由 hook 完成，结果订阅不得补水或修改文档。

SQL 来源复用 SqlReceipts；回执的成功序号对应 batch 预览，不能把最后一个结果当整批结果。unknown 写入只可查看、复制与导航核验，不能直接套用重试。网格丢弃草稿后必须等待新读取成功才恢复编辑。

导入工具 schema 必须与来源配置及 Host 校验贯通。Kafka brokers 是数组，tls 是布尔值，认证枚举为 none/plain/scram-sha-256/scram-sha-512；用户名根据认证规则校验。导入只登记，不登录，不接收非空 password/privateKey/privateKeyPem/caPem。created 按实际来源投影，skipped 外框兼容。

快照及 execution-wait 可携带 storage.executionHistory{degraded,retrying}、storage.workspace{degraded}。新增 action execution-persistence-retry 只接受 action 字段，无执行内容或路径；成功返回 saved=true，实际落盘失败返回 saved=false/503。客户端复用原执行订阅，不能新增状态轮询；缺失状态不等于正常。历史重试不补写失败文档，不访问数据库。

Explorer／Knowledge 的生产入口使用 hostModules。自定义注册工厂属于 test/helpers/source-registries.ts，不能引入生产模块。SQL 关闭页签缓存保留在 SQL 绑定内，不向公共上下文新增状态扩展框架。

## 3. 必须核对的静态绑定及打包

| 文件 | 新源接入修改 |
|---|---|
| `src/shared/data-sources/registry.ts` | 纯描述导入、描述数组、支持 ID |
| `src/client/data-sources/registry.ts` | 客户端模块导入及绑定数组 |
| `src/host/data-sources/modules.ts` | Host 模块导入及绑定数组 |
| `src/host/data-sources/runtime-registry.mjs` | runtime 导入及绑定数组 |
| `src/host/knowledge-policy-registry.ts` | 非 SQL 经验分析策略及支持 ID；SQL 专属分析仍走原适配 |
| `scripts/build.mjs` | 新 Worker 复制；源目录 mjs 已递归复制，检查所有外部相对导入 |
| `package.json` 与锁文件 | 精确驱动版本、Worker 文件清单、专属验收命令；不要静默改变旧命令含义 |

另核对 `src/host/data-sources/registry.mjs` 的底层 Provider 语义：它承载 SQL／Redis Provider，并非所有 family 的总模块入口。新源只有符合其契约才加入，不为满足数组一致而伪造 SQL 能力。根模块、runtime 与客户端的注册才是新标准源必须完成的绑定。

不保证“只改两个文件”。允许修改共享类型和根部静态绑定；不允许新增源时在公共查询、AI、经验或工作台流程加入产品 ID 特判。

## 4. 执行、AI 和经验调用链

人工：SourceWorkspace → 专属 runText → connectionBridge.executeText → 认证 source-execute → 实际连接模块 → normalizeContext → 等待 prepareText／authorize → 按模块记录策略协调生命周期 → 配额等待及派发前复核 → Worker action 白名单 → 专属结果投影 → 公共结果外框。Redis／Kafka owned 创建单一记录；SQL none 返回原 Result、零记录。旧 SQL query/manual-query 也经实际模块，保留原 action 和默认值。

上下文必须由实际连接模块验证。actor、环境、generation 来自 Host，浏览器不能提供可信 AI 身份、授权标记或只读证明。prepared.input 是源模块生成的请求，不直接透传浏览器对象。摘要不得保存凭据或完整业务载荷；持久历史与本次有限结果分开。

AI：真实工具身份／callId → 源参数转换为实际文本 → 发布共编文档 → 复核控制权、revision 和上下文 → 同一执行链 → 单一记录／公共事件。只读列表或状态工具没有实际可执行文本时不要编造。用户接管不撤销已派发动作；迟到结果只能结束自身记录。事件携带连接与 generation，结果不能覆盖新的修订。

经验：公共草稿 → 源校验／规范化指纹／分析 → KnowledgeService 与现有唯一存储。打开、保存和分析均不执行；试运行经正常授权执行，错误／结果匹配草稿版本。没有安全语义分析时明确显示未分析，不虚构相似度。

参考 `src/host/data-sources/kafka/` 和 `src/client/data-sources/kafka.tsx`。Kafka 仅有现有读取能力，PLAIN 可不启用 TLS，启用 TLS 必须验证证书。Redis 保持命令 ACL、默认空黑名单和环境权限；SQL 保持批量、维护确认、网格、事务及恢复。

Kafka 的参考细节：`command.mjs` 同时负责人工文本、结构化 AI 参数格式化和经验校验；`result.mjs` 限制最终结果与列表分页；`completion.ts`/`name-cache.ts` 只提供中文输入辅助和当前连接已读名称。AI 工具经标准执行链和模块 `projectLiveResult` 发布一次结果，不能再手工发布第二个完成事件。只读元数据操作使用 Kafka 专属 scope，不关闭共享 Admin；PEEK 独立 Consumer 不提交 offset。新源可参考这些边界，不应复制整套页面。

## 5. 可运行的接入验收

运行 `npm run test:source-module`。现有 `test/fixtures/source-module-host.ts`、`source-module-client.tsx`、`source-module-worker.mjs` 是测试专属模块；`scripts/source-fixture-registrations.mjs` 只在隔离 esbuild 注册位置加模拟源，生产代码不加载它。

| 能力 | 实际证据 |
|---|---|
| 认证／目标校验 | 未认证 401，非法上下文拒绝 |
| 公共查询 | 真实标准挂载、ConnectionService 和 Worker，单次只产生一条记录 |
| AI | 发布／执行，输入接管拒绝 AI，交还后执行及 execution ID |
| 经验 | 正式存储保存不执行，试运行正常执行且单一记录 |
| 页面 | 420／768／1200 宽度，浏览器无 pageerror |

`test/source-module-contract.test.mjs` 只证明注册契约、缺项／重复／未知 ID 拒绝；不能代替上述闭环。新源另补自身协议、ACL、取消、超时、断线、二进制、分页及结果上限实连测试。

验收顺序：`npm run check` → `test:source-module` → 专属实连 → `test:package-closure` → 补全／竞态／工作台浏览器 → 无版本豁免安装。构建、打包、安装串行。发布检查确认不包含 mock-source、测试 Worker 和 fixture 标识。Web、容器、Desktop、业务集群各自记录；缺环境标 NOT_RUN。

现有测试环境复用：用户明确提供测试实例后，安装验收可设置 `DSH_TEST_EXISTING_ENV=1`；`scripts/existing-test-environment.mjs` 检查当前 mysql8／oracle19／redis／kafka 的运行状态和映射端口，不创建容器、下载镜像或探取认证文件。账号通过本次进程的 DSH_TEST_MYSQL_PASSWORD、DSH_TEST_ORACLE_PASSWORD、DSH_TEST_REDIS_USERNAME／PASSWORD、DSH_TEST_KAFKA_USERNAME／PASSWORD 提供；Oracle 服务可用 DSH_TEST_ORACLE_SERVICE 指定。凭据不写入报告或源码。SQL 仅创建并清理本轮独立测试库／用户，Redis 仅处理随机 Key，Kafka 仅处理随机 Topic；不得在复用模式中清空 Redis DB 或删除既有容器。默认一次性模式保留，后续实连脚本复用环境需沿用相同的明确授权和对象归属规则。

## 6. 偏差与停止条件

遇到公共产品特判、接口必须伪造 SQL 字段、权限或存储语义变化、旧专属方法仍有调用、新客户端无法满足取消／有界读取时，停止受影响步骤。记录实际调用链、最小复现和接口缺口，区分测试过时、旧缺陷、计划错误与本轮回归，再提出修订。不能通过放宽权限、吞异常、删除有效测试、强制点击或把假数据写成实连完成任务。

## Redis 命令作为标准执行参考（2026-10-01）

Redis 命令使用 `standard-text`，参考 `src/host/data-sources/redis/execution.ts`；SCAN、Key 补全／浏览／编辑及读取工具继续保留专属结构化入口，不能将它们描述为已统一。

`PreparedTextOperation` 可以提供 `classifyInterruption(error, { aborted, dispatched })` 和 `completedResultIsDefinitive`。生命周期由 Host 提供；不能从浏览器上传可信派发状态。`runOperation` 回调的 `markDispatched()` 必须在 Worker 的 postMessage 成功后调用。未提供中断分类的模块沿用已有分类。结果事件使用实际记录终态，释放取消监听器及控制器；每次调用只有一条主记录。

Redis 四个命令入口共用模块授权与派发前复核。新数据源应按自己的协议判断未知结果，不复制 Redis 命令规则。参考 `test/operation-runtime.test.mjs` 的取消竞争和 `test/redis-target.test.mjs` 的真实服务／Worker 队列用例；fixture 超时回复是分类测试，实际取消与连接中断另由 Redis fixture 验证。

## SQL 兼容入口复用生命周期

`src/host/sql-operation.ts` 与 ConnectionService 的 runSharedQuery／explainPlan 展示了保留已有协议和执行算法时如何复用生命周期。SQL 文本模块现在为 standard-text；普通查询零记录，共编／解释以 external 复用已有单一主记录。database_catalog 和维护仍是结构化专属接口。

Host 内部 OperationMetadata 显式提供现有 SQL 历史字段及 historyVisible=false；OperationContext 提供 executionId、markChecked，deferCheckPassed 将授权通过事件延后。projectCompletion 返回原 message、Result、conclusion，由 runOperation 唯一调用 complete，结果限量沿用 ExecutionStore。来源不能覆盖绑定中的身份与 generation。

派发标记必须通过 request 的内部 onDispatched 在发送成功后产生；beforeDispatch 在原队列之后复核文档快照。普通人工查询与人工接管共编查询都按账号权限执行 DML；AI 写入只允许 SIT。批量结果属于单次生命周期，逐项回执保留成功、失败、未知和未执行。旧 action 仅薄适配权威文档，修改与执行必须带 revision。相关服务与 Worker 测试见 test/sql-operation-lifecycle.test.mjs。

## SQL 文本入口与记录所有权

参考 `src/host/data-sources/sql-execution.ts` 与 `src/host/text-execution.ts`。prepareText 和 authorize 可以异步，公共层必须等待；异步完成后再次检查取消。TextEntryOptions 只能由 Host 方法构造，不透传 HTTP input 中的 entry、lane、recordPolicy 或授权证明。SQL query、manual-query、shared-query、explain 是模块内部入口，入口身份不能仅从 user/ai 推断。

准备结果的 recordPolicy 默认 owned，queue 默认 manual；无行为的 authorizationLocation 已移除。none 不建立记录；external 要求真实上层 signal 和 onDispatched，不接受 execution ID 代替；owned 由顶层标准服务调用一次 runOperation。dispatchTextOperation 不创建记录、不另起队列。Host 校验并提供可信授权，Worker 继续核对实际对象、连接身份与整批语法。HTTP 输入不得选择身份、lane 或授权证明。

SQL source-execute 支持 `{ text, context?: { schema?: string } }`，返回原 Result，无 executionId/executionStatus，与 manual-query 的人工权限和额度一致。所有普通多语句先整批静态授权，再顺序执行；执行第 N 步失败仍保留已完成步骤，成功和未知写入不自动重放。共编执行只取文档 context，保存、控制与执行共享顺序。EXPLAIN 仅支持 SELECT，复用同一文档及生命周期。

新源优先沿用默认入口；只有实际业务存在权限、配额或记录差异时才定义专属入口。测试参考 sql-text-execution.test.mjs 的真实服务/认证分派、模块与原 SQL 执行器，sql-operation-lifecycle.test.mjs 的授权与排队竞态，以及 installed-sql-text.mjs 的现有实例权限和部分写入验收。

## 本地工具接入生命周期

不需要在线数据库的工具参考 `src/host/local-ai-operation.ts`。先由真实工具入口验证对话和既有参数，再调用 `runLocalOperation()`；可选关联已保存连接，不调用 liveConnection、不伪造 generation、不占数据库配额。与连接操作共用同一私有生命周期，不能再创建／结束第二条记录。

业务回调返回 `{ value, message?, conclusion? }`，value 保持原工具结构，内部 executionStatus 不进入旧输出。上下文提供 executionId、markChecked、markRunning、受限 annotate（sql/draft）；本地操作不能标记 dispatched。当前三个工具的五个分支显式保持 type=tool、historyVisible=false，不向查询历史新增项目，也不发布执行文档完成事件。

提前取消必须阻止业务开始；已提交的保存不承诺取消或回滚，不自动重试。确定的保存回执可返回调用方，但既有 cancelled/unknown 记录不能被覆盖。失败投影必须脱敏，并明确保留已有分类。测试参考 `test/local-ai-operation.test.mjs`（真实工具、离线连接与实际存储）及 `test/operation-runtime.test.mjs`（资源清理与终态竞争）。普通查询与无记录状态工具不因使用公共底座而自动增加记录。

## 结构化 AI 读取复用生命周期的参考

Redis `read-operation.ts` 和 `ConnectionService.executeRedisReadTool()` 展示了不转换为命令文本的结构化读取适配。只允许确定的工具操作及只读 Worker 请求；参数、对象读取和分页归源实现，记录／取消／派发／终态清理由 `runOperation()` 提供。不要给同一工具再创建另一条记录或叠加配额队列。

公共外围可选 `summarizeFailure(error, lifecycle, status)` 仅提供安全持久摘要，未提供时保留默认行为。Redis 读取固定摘要不保存原始 Key／match／结果，保留当前 SHA-256 Key 目标摘要；工具输出不增加内部终态字段。读取不发布虚构文本或编辑器结果事件。

Key 补全不写记录，总览刷新不增加历史噪声。`test/redis-target.test.mjs` 用显式释放队列的 Worker 验证接管、改文、切库、代次与取消；`scripts/redis-read-ui-acceptance.mjs` 挂载实际公共工作台与工具注册，由 `test:workspace-ui` 调用。这是受控 Worker 证据；真实 Redis 普通／TLS 的取消和断线由 `test:redis` 的透明 TCP 中继另行验证。

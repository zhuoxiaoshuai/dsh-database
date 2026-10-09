# DSH 数据源平台架构

## 执行边界与协调收敛（2026-10-05）

- Host 在派发前捕获 `DocumentExecutionIdentity`：会话、连接、来源、generation、规范化 context、修订、完整文档、执行文本和 initiator。成功、失败、事件共享该快照。旧扁平字段仅兼容响应；SQL 内核读取 ExecutionDocument，不通过 SharedQuery 或历史投影检查文档。
- `useExecutionDocument` 只拥有文档、草稿、保存队列和操作状态。`useDocumentResultBus` 是四源共编当前结果的唯一接纳入口；实时、直接和恢复都经过相同归属校验，渲染时即剔除失效结果。同一文档的新结果使此前恢复请求失效。缺少完整身份或结果载荷不恢复当前区域；历史仍可查看。
- 普通 SQL 的重试和继续使用原运行快照及单调递增的失效版本。切回原库不会恢复旧操作资格。两处网格共用 SQL 专属 `useGridSave`，预览返回后再次检查原快照，已经派发的操作保留真实回执。
- HTTP 派发前取消与派发后回执丢失分别记录。fetch 已调用但未收到可信执行回执为 unknown；状态码、截断 JSON 或空成功响应不能证明数据库拒绝。批量 steps 是事实，缺少步骤回执不能臆造未执行；成功和 unknown 写入保留不可重提标记。
- 新增行缺失字段表示未填写并使用默认值；null 表示显式 NULL；空字符串表示显式空字符串。仅提交显式赋值字段。Oracle 自身空字符串语义保持不变。
- SQL 入口、授权分析和 Worker 证明位于 SQL 专属适配，以 `sourceKind` 区分；公共协调不再使用 `afterAnalysis` 回调。Redis/Kafka 内存身份不会扩大磁盘业务正文的持久化范围。

验收证据和未完成的实连项见 [本轮实施记录](plans/execution-boundary-implementation.md)。

## 当前实现边界（2026-10-03）

- 文档 hook 的内部 reducer 是客户端唯一接纳边界：已确认文档和本地草稿分开，未保存状态由编辑版本与确认版本推导。读取捕获代次和编辑版本，旧修订不回退；保存回执推进权威修订但不覆盖较新草稿。同连接重连保留失败草稿，读取后显式重试。
- 在线浏览器的新旧文档修改、控制、执行入口均校验 generation 和 revision；HTTP 身份固定为人工。旧 shared-query action 只转换参数及响应，SQL 执行复用同一协调入口。
- 实时事件、直接响应和断线恢复共用完整执行身份归属函数：连接、generation、规范化目标、文档修订、完整文档内容及 initiator。选区文本只描述实际执行内容，不能通过字符串包含判断归属。旧历史缺少身份时仅供查看。
- 普通 SQL 结果与维护能力绑定发起时快照。换目标或重连使旧能力失效；原结果可只读查看，原草稿冻结。回执按 stepIndex 关联预览，影响行数以 steps 为准，不受预览数量预算影响。锁定读等禁止规则遍历嵌套 AST。

- SQL 浏览器共编入口与 Host 内部更新分开：HTTP shared-query-run 只允许人工身份；shared-query-update 只允许 sql/schema 和 user/format。AI/system 来源及记录字段仅由可信内部服务更新。格式化对照 Host 当前文档和真实方言验证，保持控制权。文本、目标、控制权和执行均须携带当前 revision；旧 action 同样拒绝缺失修订。

- 公共客户端组件位于 `src/client/workspace/`。MySQL、Oracle、Redis、Kafka 均以 standard 模式提供 `useBindings()`，由公共 `StandardSourceMount` 创建 `SourceWorkspace`；不支持整页 render／wrap。
- 编辑器通过不透明 `editorContext` 获得专属补全缓存。`executionContext`、`executionContextKey`、`executionContextLabel` 分别承担 Host 目标数据、客户端比较和可见目标说明；公共工作台不解释 DB、Topic 等字段。
- 文档文本与规范化上下文共同参与 revision。一次原子更新最多增加一次修订；相同目标不增加；上下文单独变化保持控制权。切换目标取消旧作用域，保存失败保留草稿并提供重试。
- 标准文档的控制权变更与自动保存共用同一客户端队列。Host 控制响应即使因后来输入不能替换草稿，仍推进本地保存修订基准；交还期间的新输入在后续保存前恢复 Host 人工控制。卸载或作用域失效后不发送排队的控制权请求。四源均使用 ExecutionDocument；SQL 的 SharedQuery 仅是兼容投影。
- Host standard-text 必须提供 `normalizeContext`、`prepareText` 和 `authorize`。身份、环境和 generation 来自认证入口及实际连接；模块提供 Worker action/input 和结果投影，runtime 再核对允许的 action。
- Redis 配额等待结束后、Worker 派发前复核控制权、修订、文本和目标。普通人工命令台保留发起时目标；人工执行共编文档同样接受修订复核。
- MySQL／Oracle 客户端使用共享 SQL 绑定，四源 Host 文本能力均为 standard-text。SQL 模块由 createSqlTextExecution 分别绑定方言；权限与车道由可信 initiator 决定，记录所有权由既有生命周期决定。SQL Worker、维护、网格和事务保留专属算法；整批 SQL 静态预检后顺序执行并返回逐项回执。
- 测试源只在隔离验收包的静态注册位置加入；生产 ID、注册表和发布包不包含它。验收使用正式注册、认证入口、ConnectionService、Worker、公共页签和经验存储；专属 address 配置无须伪造 SQL 连接字段。
- `shared-query-confirm` 和旧 ApprovalLedger 保持删除，这是已确认的兼容性变化；现有 SQL 维护确认保留。

## 回执与持久化状态（2026-10-03）

普通 SQL、共编结果与历史使用同一逐项回执视图。成功项按结果序号关联有界预览；失败、未知、未执行不借用最后一个成功结果。旧记录没有 steps 时保留单结果展示。Worker 在批量执行前后通过现有进度通道携带已提交前缀；取消或丢失回包可以补充回执，不能把 unknown 终态改成成功。

未知写入只提供原操作查看、原目标导航及丢弃草稿后的新读取。旧代次核验须明确选择当前连接；读取失败继续冻结网格，可信新读取成功才解除冻结。核验不执行原写入、不复用审批、不自动推断提交结果。

工作区快照和 execution-wait 的可选 storage 字段分别报告 executionHistory 与 workspace 降级。客户端在既有共享订阅中显示非阻塞提示。execution-persistence-retry 不接受内容、路径或身份，只把 ExecutionStore 最新内存快照通过原写链落盘，并返回实际 saved 结果；并发合并，失败重新启用 1/5/30 秒有界重试。工作区文档保存仍由文档队列重试。缺失 storage 字段表示未报告，不能宣称正常。

database_import_connections 登记四源配置，Kafka 包括 brokers、tls、saslMechanism 与 username；不登录且拒绝非空密码、私钥或 CA 正文。响应保留 created/skipped 外框并按来源投影。

## 当前模式与接入入口

| 数据源 | 客户端 | Host 执行 | 专属能力 |
|---|---|---|---|
| MySQL | standard（共享 SQL 绑定） | standard-text；目录／浏览／维护专属入口 | SQL、目录、批量、InnoDB 维护、网格编辑 |
| Oracle | standard（共享 SQL 绑定） | standard-text；目录／浏览／维护专属入口 | Service/SID、SQL、目录、时间类型、维护与恢复 |
| Redis | standard | standard-text（命令）；专属结构化入口（SCAN／Key） | 命令隔离连接、SCAN、Key 编辑、DB 上下文与补全 |
| Kafka | standard | standard-text | Topic/组搜索分页、成员与 Lag、有界 PEEK、消息 JSON/预览导出 |

standard 复用公共导航、页面容器、状态栏、执行窗口、AI 历史外框和经验列表布局。SQL 保留多查询／对象页签，Redis／Kafka 保持单查询页；四源共编统一使用 ExecutionDocument。Redis 的 SCAN、Key 浏览／编辑和读取工具继续采用专属入口。新增源采用 standard＋standard-text；完整施工顺序和静态绑定位置见 [接入指南](data-source-onboarding.md)。

## 客户端页面绑定

Kafka 的名称缓存由其 `useBindings()` 持有，通过既有 `editorContext` 供三个编辑器使用；公共工作台不读取 Kafka 名称或解释分页命令。列表/详情/消息的大小限制由 `result.mjs` 执行。模块的 `projectLiveResult` 经现有 ConnectionService 发布一次共编结果，AI 工具不另行发布完成事件。元数据取消与 PEEK 生命周期仍归 Kafka 驱动，未新增公共协议层。

- `workspace-navigation.ts` 在公共挂载层维护页签身份、打开、关闭和回退。来源载荷不透明；SQL 通过原 onWorkbench 格式保存草稿，公共层不解释 schema/table。
- `SourceWorkspace` 使用同一 WorkspaceFrame 创建页签栏、页面容器和状态栏。命令型绑定使用内建查询／AI／经验流程；页面绑定提供 initialItems、initialActive、fallback、describe、content 和显式 keepMounted，不得返回另一套工作台。
- `src/client/sql/workspace-bindings.tsx` 组合 ObjectHome、ObjectWorkspace、SqlWorkspaceTab、AI 与经验内容。查询页继续使用 SqlRunWorkspace／ExecutionWorkbench，维护与批量状态保留在 SQL 组件。
- SQL 在工作台绑定层创建一份 useExecutionDocument。编辑器、历史套用、草稿恢复和经验保存共用其内容、目标与顺序队列；SharedQuery 展示类型只做纯投影。历史明确目标优先，缺失时沿用文档目标。queryBus 只处理执行记录、结果归属和跨连接提示，不恢复或修改文档。所有工作台订阅共享每个 bridge 的唯一 long polling；各源不另建恢复队列。
- 关闭的 SQL 页签草稿缓存属于 SQL 绑定模块，以 bridge 为生命周期边界，按对话和连接隔离；公共 WorkspaceSourceContext 不携带 SQL 缓存。生产 Explorer／Knowledge 直接使用 hostModules，测试注册工厂仅存在于测试辅助目录。
- KnowledgeLibrary 接收展示行、元信息、分析区域和执行内容。SQL 的 useSqlKnowledge 保留每条经验会话、相似分析、版本与变体；SqlTemplateLibrary 是薄兼容入口，不创建第二份草稿状态。
- 客户端 legacy-sql、ActiveConnectionPane 和 Host legacy-adapter 已移除。旧 HTTP action、SQL 草稿和经验存储格式保留。

## SQL 已有记录入口的公共生命周期（2026-10-01）

MySQL／Oracle 的 `runSharedQuery()` 与 `explainPlan()` 复用 `runOperation()`。SQL 专属元信息、结果／模型投影和中断规则位于 `src/host/sql-operation.ts`；模块复用原 authorizeStatement 和 SQL Worker。共享执行器统一创建与结束记录、绑定与释放取消控制器，保留原 SQL historyVisible、Schema、SQL、草稿、类型、callId/rootCallId 及有界结果预览。

`OperationContext` 向 Host 执行回调提供 executionId 和 markChecked，SQL 可以在真实授权后发布检查标记；`projectCompletion` 将现有 SQL Result／conclusion 交给 ExecutionStore 的原限量保存。其他来源省略新选项时沿用默认行为，不增加 Redis 值或 Kafka 消息正文的持久化。

request 的 Host 内部 beforeDispatch 在原配额等待结束后同步复核连接、环境、文档修订、文本、Schema 与控制权；onDispatched 只在 postMessage 成功后调用。Worker 接收 Host 设置的可信 lane、授权证明和结构化效果回执；复用原队列。已派发操作允许结束自己的记录，旧请求不能更新后来编辑的文档；已有终态不接受迟到成功结果或成功网格事件。

共编执行、执行计划和 database_catalog 工具已复用公共记录生命周期。本地 AI 工具的迁移见下节。普通 query／manual-query 现在经过 SQL 标准模块，继续零主记录；维护保持专属入口。SQL 的批量、维护确认、事务恢复、经验存储及 HTTP 来源边界保留；SharedQuery 不拥有写入状态或事件。

### SQL 标准文本接入（2026-10-02）

`src/host/text-execution.ts` 等待同步／异步准备和授权，不判断产品 ID、不创建第二条记录。准备结果声明 queue、recordPolicy（none／owned／external）和可选授权证明；已删除没有行为的 authorizationLocation。省略声明时保持 owned/manual 默认值。none 直接返回原结果；owned 由标准入口调用一次 runOperation；external 必须来自已有生命周期的 AbortSignal 与派发回调。

所有人工 SQL 入口与经验试运行均使用 manual 配额，AI 使用 ai 配额；Host 先完整授权，Worker 继续核验实际对象及连接，保留原 Result。source-execute 只接受可选 `{ schema }`，缺省按人工查询默认目标，不读取 AI 文档；不增加 executionId/executionStatus。HTTP 不能选择内部入口、记录策略、队列或授权证明。

共编仍先建立一条记录，再由模块异步调用原 SQL 授权。Host-only afterAnalysis 钩子在分析后、权限拒绝前复核快照并补充原记录字段，保留旧错误顺序和元信息。随后共用 #queueAndDispatch，在原队列之后再次复核。执行计划复用同一执行链，只支持 SELECT。lastRun/lastExecutionId 从匹配文档修订、目标与代次的执行记录派生；终态事件不能覆盖失效文档。

批量 SQL 一次提交整批，先完成所有静态授权再按顺序执行。每步保留 succeeded/failed/unknown/not-run 回执和已提交事实，不重放成功项或未知项。所有结构化目录／浏览／维护和各驱动仍有自身契约；standard-text 不代表这些业务被转换为文本。

## 本地 AI 工具生命周期（2026-10-02）

`database_import_connections`、`database_templates` 的 search/get/save，以及 `database_read_collab` 经 `local-ai-operation.ts` → `runLocalOperation()`，与 `runOperation()` 共用私有 `runLifecycle()`。连接操作的强类型绑定及公共签名不变；本地操作只要求真实对话身份，可携带已有连接记录，不要求在线、虚构 generation 或 Worker。

公共运行层唯一负责创建／结束记录、取消转发、终态保护、控制器与监听器释放。本地上下文仅提供 executionId、markChecked、markRunning 和 sql/draft 的受限 annotate，不提供 markDispatched。五个分支保留原标题、原因、结论、SQL/草稿、callId/rootCallId、type=tool、historyVisible=false 与 JSON 返回字段；运行状态不会因本地业务开始而伪造数据库派发事件。

本地存储没有可回滚的取消协议。提前取消不进入业务；已进入保存／登记不自动重试、不宣称回滚，完整保存结果继续按原结构返回。ExecutionStore 已产生 cancelled/unknown 时保留该终态，迟到成功不能改写。外部信号在完整本地响应前触发、但尚无终态记录时，明确成功响应沿用原成功语义。本地适配保留超时及断开分类，失败文案使用原文，不影响数据库调用方的分类。

普通 SQL 查询、经验试运行、database_status、database_execute_sql action=read 保持原无记录行为；读取经验／工作台不发布共编结果事件、不改变控制权。验证使用真实工具注册、ConnectionService 与本地临时存储，不等于真实模型验收。

## SQL 目录工具外围（2026-10-01）

`database_catalog` 委托 `ConnectionService.executeCatalogTool()` → `sql-catalog-operation.ts` → `runOperation()` → 原 catalog 队列／缓存／Worker。专属适配保留目录 SQL、参数、标题、原因、结论和查询草稿；不创建或结束记录。目录工具每次有效调用创建一条 catalog 记录，保留 callId/rootCallId 和原 historyVisible=false。目录记录当前不会出现在 AI 查询历史列表中，本轮没有改变过滤规则。

缓存命中仍产生本次工具记录，但没有 dispatched。MySQL 表详情追加的索引请求与表结构共用一条记录，首次 postMessage 成功后才幂等标记一次 dispatched；Oracle 保留原目录组合。每次子请求排队结束后复核会话、连接、generation、取消及原 Schema 访问边界，不新建第二层队列。

目录读取与编辑器控制权、文本修订和选中 Schema 无关：工具参数捕获的目标保持不变，人工接管不阻止读取。目录工具不改写 SharedQuery，不发布编辑器 EXECUTION_FINISHED。schemas/tables 的 unavailable 仍结束为失败；表结构中索引等局部 unavailable 继续作为局部结果返回。取消等待原 Worker 结束或原超时，不提前释放目录队列，不自动重试或关闭共享连接。迟到完成不覆盖已有终态。

## Redis 命令执行外围

命令台与经验试运行经 `source-execute`，人工共编执行经 `runExecutionDocument`，`redis_execute` 在发布实际文档后执行；旧 `redis-command` 只做输入适配。四个入口均委托 `ConnectionService.executeText` → Redis 模块规范化、解析与 Host 授权 → `runOperation` → 配额等待 → 派发前修订／控制权／目标／代次复核 → Worker。旧 action 省略 DB 时使用连接默认 DB。

Redis 专属适配位于 `src/host/data-sources/redis/execution.ts`。公共外围不解释命令名。Worker `postMessage` 成功后才标记 dispatched；派发前取消为 cancelled，派发前拒绝及明确 Redis 错误为 failed，完整正常响应为 succeeded，派发后取消、超时或断线且没有确定响应为 unknown。已有终态不会被迟到结果覆盖，不自动重放。

人工记录保持 query；AI 命令保持 tool 与 callId/rootCallId。共编执行由公共服务发布一次包含 generation、execution ID、queryRevision 和实际终态的结果事件；有限实时结果只驻留内存，持久历史不保存完整命令参数或结果正文。Redis Worker 的独立命令连接及 SQL/Kafka 原有执行算法保留。

## Redis AI 结构化读取外围（2026-10-01）

`redis_keys`／`redis_value` 由 `executeRedisReadTool()` 进入同一 `runOperation()` 生命周期。`data-sources/redis/read-operation.ts` 只组织 SCAN 与强制 read 的 Key 请求、安全标题和摘要；Worker 仍接收原结构化参数。工具真实身份、callId/rootCallId、记录类型 tool、历史可见性及返回字段保持兼容，内部 executionStatus 不新增到工具输出。

读取在创建记录时捕获文档与规范化 DB，配额等待后复核控制权、修订、文本、目标及 generation。postMessage 成功后才发布 dispatched；未派发的旧请求被拒绝。读取不改写 AI 文档，也不发布覆盖当前编辑器结果的共编完成事件。

读取沿用公共默认终态：外部取消为 cancelled，错误／ACL 拒绝／超时／连接错误为 failed；ExecutionStore 已产生的 unknown／cancelled 不被迟到完成覆盖。取消只停止本次结果接收，不宣称撤销 Redis 服务端读取，也不关闭共享浏览连接。`summarizeFailure` 是公共外围可选的持久失败摘要接口。取消和结果未知仍用产品文案；失败摘要是数据源原文，不再经过错误脱敏出口。

**Key 补全继续不写执行记录**，这是本轮确认的行为。总览、Key 浏览与写操作仍是专属入口；没有新增后台刷新记录或补全审计。透明 TCP 中继只存在于一次性验收脚本，延迟真实 Redis 回复用于验证取消／断线，不进入产品。

## 1. 系统定位

DSH Database 是：

“统一数据源工作平台 + 数据源差异化能力扩展体系”。

现有 MySQL、Oracle、Redis、Kafka 已经具备较完整的连接、操作、结果查看、AI 协作、执行记录和经验沉淀流程。

未来新增 Elasticsearch、MongoDB、PostgreSQL 或其他数据源时，不重新开发一整套系统。

核心目标：

新增数据源 ≠ 新开发一个独立工具。

新增数据源 = 接入现有公共底座 + 实现该数据源真正不同的能力。

系统随着数据源数量增加时，公共核心应该越来越稳定，而不是不断增加特殊判断。

---

## 2. 总体结构

逻辑结构：

DSH Data Source Platform
    │
    ├─ 公共产品能力
    │   ├─ Workspace
    │   ├─ AI / 人工协作
    │   ├─ History
    │   ├─ Knowledge
    │   ├─ 公共 UI
    │   └─ 公共交互
    │
    ├─ 公共运行能力
    │   ├─ Connection
    │   ├─ Execution
    │   ├─ State
    │   ├─ Event
    │   └─ Result 生命周期
    │
    └─ Data Source Boundary
        ├─ MySQL
        ├─ Oracle
        ├─ Redis
        ├─ Kafka
        ├─ Elasticsearch
        └─ Future Sources

每个数据源都是公共系统上的能力扩展，而不是独立系统。

---

## 3. 公共底座职责

所有数据源都会经历、且业务语义稳定一致的内容属于公共底座。

包括但不限于：

- 数据源管理整体流程
- 连接管理整体流程
- Workspace 与页签生命周期
- 编辑器公共生命周期
- 执行开始、运行、取消、结束
- 执行身份和状态
- 执行记录与 History
- AI Query 主流程
- AI / 人工共同编辑
- 人工接管和交还
- 修订与结果归属
- 公共 Result 外围
- Knowledge 公共流程
- 草稿与版本
- 公共 Loading / Error / Empty
- 公共布局
- 公共状态外围
- 公共交互行为

这些能力原则上只存在一套。

---

## 4. 数据源职责

数据源只负责真正依赖自身协议和业务模型的内容。

典型包括：

- 连接字段
- 连接协议
- Driver / Worker
- 连接测试方式
- 对象模型
- 对象获取方式
- 对象详情
- 操作文本或命令语义
- 解析
- 数据源专属授权规则
- 实际执行
- 分页 / Cursor / Offset 等专属机制
- 结果数据结构
- 结果专属展示
- 补全
- 专属 Toolbar 动作
- AI 参数到真实操作内容的转换
- 经验保存中的专属校验、指纹和分析
- 只有该数据源才存在的能力

原则：

公共底座负责“流程怎么走”。

数据源负责“具体怎么做”。

---

## 5. 统一什么

系统统一：

- 产品流程
- 生命周期
- AI 与人工协作方式
- 执行记录体系
- History 主流程
- Knowledge 主流程
- 公共页面框架
- 公共视觉语言
- 状态外围
- 错误外围
- 公共交互方式

---

## 6. 不强行统一什么

不同数据源可以拥有完全不同的：

- 连接参数
- 数据模型
- 对象模型
- 操作语言
- 结果数据结构
- 分页模式
- Cursor
- Offset
- Transaction
- 数据源专属行为

不要求：

- 所有连接都有 host/port/database/username
- 所有对象都是 Schema/Table
- 所有对象浏览都是树
- 所有结果都是二维表
- 所有操作都是 SQL
- Redis、Kafka 实现 SQL 语义
- Kafka Offset 与 Redis Cursor 使用同一种分页模型

核心原则：

“统一流程，不强行统一业务语义。”

---

## 7. AI 与人工边界

AI 和人工使用的是同一套工作体系。

逻辑关系：

当前操作内容
    ├─ 人工修改
    └─ AI 修改
         ↓
       执行
         ↓
       结果
         ↓
     执行记录
         ↓
    AI / 人工继续处理

要求：

- AI 可以看到人工修改后的当前内容
- 人工可以看到 AI 实际产生和执行的内容
- 人工可以接管
- 接管后 AI 不能覆盖人工当前内容
- 交还后 AI 可以继续操作
- AI 与人工最终进入同一 Execution
- 共用同一记录和结果体系
- 不为某个数据源重新建立独立 AI Workspace

---

## 8. Execution 边界

所有数据源都存在统一意义上的 Operation / Execution。

但 Operation 不等于 SQL。

例如：

MySQL / Oracle → SQL
Redis → Command
Kafka → Topic / Partition / Offset Operation
Elasticsearch → DSL
MongoDB → Query / Pipeline

公共执行层关心：

- 谁执行
- 在哪个连接执行
- 哪次执行
- 当前状态
- 取消
- 执行记录
- 事件
- 结果关联
- AI / 人工来源

数据源关心：

- 内容是什么
- 如何解释
- 是否允许
- 如何执行
- 返回什么
- 如何展示

公共执行层不应逐渐变成一个理解所有数据源内部业务语义的 God Service。

---

## 9. Result 边界

系统共用结果生命周期和公共结果区域。

但不存在万能结果数据模型。

SQL 可以是 columns / rows。

Redis 可以是 key / value / type。

Kafka 可以是 topic / partition / offset / message。

Elasticsearch 可以是 document / aggregation。

原则：

“统一结果流程，不统一结果内部结构。”

---

## 10. Knowledge 边界

Knowledge 主流程只有一套。

公共能力可以包含：

- 搜索
- 选择
- 草稿
- 保存
- 修改
- 版本
- 归档
- 试运行
- 再次用于当前操作

数据源可以提供：

- 保存校验
- 标准化
- 指纹
- 相似分析
- 专属分析

不得为每个数据源分别建立完整 Knowledge Library。

---

## 11. UI 边界

系统保持统一的产品外框。

公共：

- Workspace
- Tabs
- Toolbar 外围
- AI 区域
- History
- Knowledge
- Result Frame
- Drawer
- Dialog
- Loading
- Error
- Empty
- 公共状态展示

数据源可以提供：

- 专属连接字段
- 对象浏览
- 编辑器能力
- 补全
- 数据源专属 Toolbar 动作
- Result 内容组件
- Detail 组件

数据源不能重新接管整个公共 Workspace。

---

## 12. Client / Host 边界

整体关系：

公共 Workspace
    ↓
数据源 Client 能力
    ↓
公共 Bridge
    ↓
Host
    ↓
公共运行生命周期
    ↓
数据源 Host 能力
    ↓
Driver / Worker
    ↓
真实数据源

Client 主要负责：

- 编辑
- 交互
- 补全
- 展示
- 结果呈现

Host 负责：

- 真实身份
- 凭据
- 权限
- 安全校验
- 实际连接
- 实际执行
- Driver / Worker
- AI 工具真实调用
- 持久化

影响真实权限、安全和执行结果的判断不能只存在于客户端。

---

## 13. 扩展判断

新增功能时依次判断：

1. 是否所有数据源都会使用？
   是 → 公共能力。

2. 是否只属于某个数据源自身语义？
   是 → 数据源能力。

3. 是否因为公共底座缺少一个真正通用的扩展点？
   是 → 完善公共扩展点。

4. 是否只是为了当前数据源开发方便？
   是 → 不把它塞进公共业务层。

---

## 14. 架构退化信号

出现以下趋势时必须重新检查架构：

- 公共 Workspace 大量判断 sourceType
- AI 主流程大量判断具体数据源
- History / Knowledge 出现大量具体数据源分支
- 同一个状态在多个模块维护多份
- 每接一个数据源都复制一套 Workspace
- 每接一个数据源都增加独立 Store
- 每接一个数据源都增加独立 History
- 每接一个数据源都增加独立 AI 工作台
- 公共 Result 被迫加入越来越多业务字段
- 一个小的数据源需求需要修改大量公共业务代码

---

## 15. 当前数据源角色

MySQL / Oracle：

现有成熟 SQL 能力，是兼容基线。

Redis：

已经证明公共流程可以复用，但数据模型、命令和结果可以与 SQL 完全不同。

Kafka：

当前用于验证底座是否能够支持真正跨类型数据源，而不仅是传统数据库。

未来数据源继续遵守同一架构原则。

---

## 16. 最终健康标准

架构健康时应该满足：

- 删除某个数据源模块，公共平台仍然成立
- 新增一个数据源，不需要重新实现公共系统
- 修改公共流程，不需要在所有数据源复制修改
- 修改某个数据源，不影响其他数据源
- 理解公共流程，只需要阅读公共核心
- 理解某个数据源，只需额外阅读该数据源差异代码
- 数据源数量增加时，公共核心复杂度不会同比增长

一句话：

“公共能力只实现一次，真实差异各自实现；统一流程，隔离变化。”

## 2026-10-08 功能修复后的实际边界

本轮沿用已有模块，不新增流程引擎或状态库。ConnectionService 接通权威 ExecutionDocument、现有准备／授权、唯一排队及 runOperation；SharedQuery 保留旧接口适配与只读投影，执行摘要由记录派生，普通 SQL 不为统一而增加记录。目录和 Redis 读取继续使用原生结构化入口。

Worker 进度与终态分开处理；错误保留效果、阶段、分类、数据库码和逐项回执，HTTP 不推断是否提交。文档关联执行在派发前冻结完整 identity，同一快照到达记录、事件、HTTP 和 latest；选区执行保留完整文档原文。取消不承诺已派发写入回滚，缺失可信回执保持 unknown，禁止自动重放。

公共结果 bus 严格接收当前身份，只保存一份已接受结果；编辑／控制变化派生上次只读结果，目标／连接／代次变化清理。公共容器按新的 executionId 展开一次，操作错误独立显示。SQL、Redis、Kafka 保留各自渲染器；过期结果不提供写入草稿动作。SQL 补全与结构面板仅修复实际交互，不引入业务值查询或面板管理器。

本轮四源正式工具到 Host、受控 Worker、事件／HTTP、公共 hook、原生渲染器的浏览器链路已通过。真实数据库、已安装 Desktop 和模型链路仍为 NOT_RUN；详细证据见现有 `docs/plans/root-repair-implementation.md` 的 2026-10-08 续验节。

## 2026-10-09 三项修复后的边界

公共编辑器明确区分外部文本同步和用户事务，外部同步不接管、不保存、不进入撤销历史。验证 SQL 只进入执行记录，结果查询才发布文档；控制权与结果身份规则保持不变。四源链路验收现已挂载真实 CodeMirror，旧 `<pre>` 夹具不作为编辑器同步证据。

MySQL 物理连接失效由驱动持续监听，SessionManager 负责 Catalog 健康，查询池负责单条连接与配额；Worker 只在空闲时探测 Catalog，Host 复用现有有上限的恢复策略。查询连接失效不扩大成整条登录离线，写入 unknown 不自动重放。

SQL 结果仍使用字符串/NULL 单元格，binaryColumns 是可选的只读列索引；新结果显式提供该字段，旧结果按占位符兼容。驱动完成原文转换，结果预览、网格、详情、复制及导出消费同一份结果；Host 维护校验独立禁止二进制文本写回。未增加字节副本、下载入口或存储版本。受控套接字和浏览器证据、真实环境 NOT_RUN 范围见现有实施记录的 2026-10-09 节。

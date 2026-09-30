# 数据源接入指南

基于 2026-09-30 当前实现。事实优先级为当前代码、当前需求、当前调用链、当前验收；历史计划不能替代这些依据。

## 1. 开始前

新源默认采用客户端 `standard` 与 Host `standard-text`。MySQL／Oracle 的 legacy-sql、SQL／Redis 的 legacy-adapter 是既有兼容边界，新源不得借用它们接管整个页面。先定义本源真实连接配置、对象、可执行文本、上下文和结果，再实现差异能力。不要伪造 schema/table/database 等 SQL 字段。

共享类型目前是封闭联合类型，新增源需要显式扩展，并逐项修正类型检查指出的穷尽分支。当前 family 和 descriptor 也按既有类别声明；差异较大的新 family 必须扩展对应类型并验证，不得为了编译把新源伪装成 Kafka。测试 fixture 的类型绕过仅用于隔离验证。

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

客户端接口以 `src/client/data-sources/types.ts` 的 ClientSourceModule 为准；StandardSourceBindings 引用真实 SourceWorkspace props，不能复制为另一套容易漂移的接口。标准挂载由 `src/client/workspace-sources.tsx` 创建公共页面。模块提供 Overview、Editor、Result、runText 等实际属性及专属内容，不返回完整工作台或 wrap。EditorContext 不透明；executionContext/key/label 分别用于 Host 目标、客户端比较和用户目标提示。

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

人工：SourceWorkspace → 专属 runText → connectionBridge.executeText → 认证 source-execute → 实际连接模块 → normalizeContext → prepareText → authorize → runOperation 创建单一主记录 → 配额等待及派发前复核 → Worker action 白名单 → 专属结果投影 → 公共结果外框。

上下文必须由实际连接模块验证。actor、环境、generation 来自 Host，浏览器不能提供可信 AI 身份、授权标记或只读证明。prepared.input 是源模块生成的请求，不直接透传浏览器对象。摘要不得保存凭据或完整业务载荷；持久历史与本次有限结果分开。

AI：真实工具身份／callId → 源参数转换为实际文本 → 发布共编文档 → 复核控制权、revision 和上下文 → 同一执行链 → 单一记录／公共事件。只读列表或状态工具没有实际可执行文本时不要编造。用户接管不撤销已派发动作；迟到结果只能结束自身记录。事件携带连接与 generation，结果不能覆盖新的修订。

经验：公共草稿 → 源校验／规范化指纹／分析 → KnowledgeService 与现有唯一存储。打开、保存和分析均不执行；试运行经正常授权执行，错误／结果匹配草稿版本。没有安全语义分析时明确显示未分析，不虚构相似度。

参考 `src/host/data-sources/kafka/` 和 `src/client/data-sources/kafka.tsx`。Kafka 仅有现有读取能力，PLAIN 可不启用 TLS，启用 TLS 必须验证证书。Redis 保持命令 ACL、默认空黑名单和环境权限；SQL 保持批量、维护确认、网格、事务及恢复。

## 5. 可运行的接入验收

运行 `npm run test:source-module`。现有 `test/fixtures/source-module-{host,client}.tsx/ts` 与 Worker 是测试专属模块；`scripts/source-fixture-registrations.mjs` 只在隔离 esbuild 注册位置加模拟源，生产代码不加载它。

| 能力 | 实际证据 |
|---|---|
| 认证／目标校验 | 未认证 401，非法上下文拒绝 |
| 公共查询 | 真实标准挂载、ConnectionService 和 Worker，单次只产生一条记录 |
| AI | 发布／执行，输入接管拒绝 AI，交还后执行及 execution ID |
| 经验 | 正式存储保存不执行，试运行正常执行且单一记录 |
| 页面 | 420／768／1200 宽度，浏览器无 pageerror |

`test/source-module-contract.test.mjs` 只证明注册契约、缺项／重复／未知 ID 拒绝；不能代替上述闭环。新源另补自身协议、ACL、取消、超时、断线、二进制、分页及结果上限实连测试。

验收顺序：`npm run check` → `test:source-module` → 专属实连 → `test:package-closure` → 补全／竞态／工作台浏览器 → 无版本豁免安装。构建、打包、安装串行。发布检查确认不包含 mock-source、测试 Worker 和 fixture 标识。Web、容器、Desktop、业务集群各自记录；缺环境标 NOT_RUN。

## 6. 偏差与停止条件

遇到公共产品特判、接口必须伪造 SQL 字段、权限或存储语义变化、旧专属方法仍有调用、新客户端无法满足取消／有界读取时，停止受影响步骤。记录实际调用链、最小复现和接口缺口，区分测试过时、旧缺陷、计划错误与本轮回归，再提出修订。不能通过放宽权限、吞异常、删除有效测试、强制点击或把假数据写成实连完成任务。

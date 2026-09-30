# DSH 最简数据源底座与 Kafka 只读接入：执行规格

> 2026-09-30 已确认调整：`shared-query-confirm` 和旧 ApprovalLedger 保持删除，不恢复原确认入口；SQL 维护确认保留。Kafka PLAIN／SCRAM 允许无 TLS，TLS 启用时仍验证证书。当前组件以 `src/client/workspace/` 为准；MySQL／Oracle 保留 legacy-sql，Redis Host 执行保留 legacy-adapter。后续实现和验收不得把旧规格当成恢复已删除入口的依据。

## 1. 目标、范围与执行纪律

### 1.1 最终交付

在保留 MySQL、Oracle、Redis 现有能力的基础上，完成一个最简公共底座，再接入可实际运行的 Kafka 只读工作流。

最终用户可以在同一套交互中完成：

> 连接 → 查看对象 → 编辑操作文本 → 人工或 AI 执行 → 查看结果和记录 → 人工接管／交还 → 保存经验 → 再次使用。

Kafka 只开发自身协议、配置、语法、对象和结果，不另建完整工作台、AI 页面、执行记录系统或经验库。

### 1.2 已确定的首版范围

| 项目 | 固定范围 |
|---|---|
| 现有数据源 | MySQL、Oracle、Redis 保持原功能 |
| Kafka 操作 | 列出 Topic、查看 Topic／分区信息、有界读取单个分区消息 |
| Kafka 认证 | 无认证、TLS、自定义 CA、SASL PLAIN、SCRAM-SHA-256、SCRAM-SHA-512 |
| Kafka 不支持 | 发送消息、创建／删除 Topic、改配置、提交消费位置、持续消费、业务消费组管理 |
| 暂不支持的认证 | Kerberos、OAuth、客户端证书认证 |
| 页面 | 沿用现有风格，窄侧栏辅助区折叠为抽屉 |
| 部署 | 保持单一 `dsh-database` 插件 |
| 后续数据源 | ES 等只做接口适配性验证，本轮不接真实驱动 |

### 1.3 实施纪律

1. 只修改本仓库，保留所有已有修改。
2. 先适配、再迁移、最后删除，不一次性重写工作台。
3. 每阶段必须通过对应验证，才能进入下一阶段。
4. 文件名包含 SQL／Redis，不构成删除理由。
5. 不新增动态插件加载、通用消息总线、第二套全局状态或独立 npm 包。
6. 不为满足“只改两个文件”的形式目标建设注册代码生成系统。允许修改共享类型、两端静态绑定及打包声明；**不允许新增数据源时修改公共业务流程。**
7. 下文新增文件、方法都是拟实施内容，不代表当前已存在。

---

## 2. 固定架构：抽取什么，保留什么

### 2.1 底座职责

公共层负责：

- 连接列表及新建、测试、编辑、复制、重连、断开流程。
- 工作区页签和公共页面外围。
- 编辑器生命周期、补全交互、运行／停止工具栏。
- AI 文档修订、接管、交还及迟到结果保护。
- 执行身份、代次、取消、记录和事件。
- 结果外框。
- 经验列表、元信息、草稿和版本操作。

数据源负责：

- 专属连接配置、驱动和连接策略。
- 操作文本语法及 Host 授权。
- 对象总览和详情。
- 执行、分页、结果限量与专属展示。
- 专属工具栏动作。
- AI 参数到操作文本的转换。
- 经验保存校验、指纹和分析。

### 2.2 第一轮禁止整体重写的区域

以下实现继续使用，只允许因明确接口需求进行局部适配：

- SQL Worker、SessionManager、查询池。
- MySQL／Oracle SQL 解析、授权、维护及恢复。
- SQL 批量步骤、单步重试、继续执行。
- SQL 网格编辑、DML／DDL 草稿及确认。
- SchemaCache 和 SQL 补全元数据。
- 现有连接文件、密码保护器。
- 现有 SQL 模板规范化、相似分析、变体。
- DSH 插件入口和认证方式。

### 2.3 不强行统一的内容

- 不要求所有总览都是树。
- 不要求所有结果都是行列表格。
- 不要求所有连接都有 `host/port/database/username`。
- 不要求 Redis、Kafka 实现 SQL catalog／maintenance。
- 不把 SQL 的维护确认扩展为所有命令的统一确认。
- 不将 SQL offset、Redis SCAN cursor、Kafka offset 转换成同一种业务分页。
- 不把“取消请求”等同于“服务端已经撤销操作”。

---

## 3. 文件与接口设计

以下路径均相对于项目根目录；已有关键入口分别为 [客户端工作区注册](../../src/client/workspace-sources.tsx)、[连接服务](../../src/host/connection-service.ts)、[HTTP 入口](../../src/host/connection-api.ts)。

### 3.1 数据源模块注册

**新增：**

| 文件 | 职责 |
|---|---|
| `src/client/data-sources/types.ts` | 定义客户端模块接口 |
| `src/client/data-sources/registry.ts` | 客户端静态模块绑定和校验 |
| `src/client/data-sources/mysql.tsx` | 组合现有 MySQL 客户端能力 |
| `src/client/data-sources/oracle.tsx` | 组合现有 Oracle 客户端能力 |
| `src/client/data-sources/redis.tsx` | 组合现有 Redis 客户端能力 |
| `src/host/data-sources/module-types.ts` | 定义 Host 模块接口 |
| `src/host/data-sources/modules.ts` | Host 静态模块绑定和校验 |
| 各 Host 数据源目录下的 `module.ts` | 组合对应数据源的 Host 能力 |

客户端模块固定提供：

```text
descriptor   名称、图标、能力声明
connection   专属连接字段和默认值
overview     总览与详情组件、从对象创建查询
editor       编辑器、补全、帮助、文本选择规则
execution    专属动作和执行适配
results      专属结果及历史详情展示
knowledge    分析展示、专属经验操作
```

Host 模块固定提供：

```text
connection   验证、指纹、凭据分离、安全快照、Worker 绑定
execution    解析、授权、执行、限量结果、中断判定
ai           工具注册及操作文本映射
knowledge    校验、指纹、分析、现有存储适配
```

**修改：**

- `src/shared/data-sources/types.ts`、`registry.ts`：补充共享 ID／纯描述；禁止导入 React、Node 或 Host。
- `connection-form-registry.ts`、`workspace-sources.tsx`、`execution-details.tsx`：从客户端模块取能力。
- `explorer-service.ts`、`knowledge-service.ts`：从 Host 模块取能力。
- `register.ts`：按模块注册 AI 工具，原工具名保持不变。

**删除：**各能力注册文件重复维护的产品数组和公共产品分支。

**保留：**纯注册校验函数、旧导出和现有专属 Provider 契约。

模块不能通过 `renderWholeWorkspace()` 重新接管整个公共工作台。

---

### 3.2 连接配置扩展

**修改：**

| 文件 | 为什么修改 |
|---|---|
| `src/shared/connection-input.ts` | 将固定字段校验限制在现有数据源适配中 |
| `src/shared/workbench.ts` | 将连接输入改为按数据源判别的类型，不要求 Kafka 伪造 SQL 字段 |
| `src/host/saved-connections.ts` | 支持模块配置及受保护字段，保留旧记录读取 |
| `src/client/connection-form.tsx` | 公共外框调用专属字段组件 |
| `src/host/connection-service.ts` | `open/update/duplicate` 使用模块配置转换，不自行解释 Kafka 字段 |

新增模块方法：

```text
normalizeConfig(raw)
validateConfig(config)
fingerprint(config)
splitSecrets(config)
toPublicSnapshot(config, secretPresence)
toWorkerInput(config, resolvedSecrets)
```

约束：

- Host 必须重新验证配置，不能信任客户端验证。
- 现有三种数据源的存储形状、ID、指纹及密码读取规则保持原样。
- Kafka 普通配置保存于专属配置对象；密码、CA 使用现有保护器封装，不能明文进入普通配置。
- 受保护数据与连接 ID 绑定。
- 浏览器快照只提供 `hasPassword`、`hasCa` 等存在标志，不返回保存的密码和 CA。
- 编辑采用“验证候选成功后替换旧连接”，失败保留原连接。
- 导入、复制、脱敏均必须经过同一模块适配，不能只改连接表单。

**不新增第二套连接存储服务，不整体抽走 ConnectionService。**

---

### 3.3 公共执行外围

**新增：**

- `src/host/operation-runtime.ts`
- `src/shared/source-operation.ts`

核心方法：

```text
resolveBinding(owner, connectionId, generation)
runOperation(binding, metadata, authorizedWork)
```

`authorizedWork` 是 Host 内部经过模块解析、授权后的回调，不接受 HTTP 上传的函数或可信标记。

公共外围负责：

- 身份和代次复核。
- 关联 execution ID、callId。
- 取消信号与监听器清理。
- 执行状态和终态事件。
- 调用模块的安全摘要和结果投影。

模块执行接口：

```text
prepareText(text, context)
authorize(prepared, trustedActor, environment)
execute(authorized, boundWorker, signal)
projectLiveResult(result)
projectHistoryPreview(result)
summarize(operation)
classifyInterruption(error, dispatchState)
```

**修改：**

- `connection-service.ts`：普通新入口与 AI 文档执行按模块分派。
- `connection-api.ts`：增加 `source-execute`。
- `shared/database-actions.ts`：增加 action 声明。
- `connection-bridge.ts`：增加 `executeText()`。
- `execution-store.ts`：复用原记录存储，统一终态幂等处理。
- `shared/execution-result.ts`：供主执行窗口使用，不仅服务历史详情。

`source-execute` 输入固定为：

```text
connectionId（外层沿用现有 id 字段）
generation
text
context
```

人工 HTTP 不能传入有效的 `initiator: ai`；AI 从 Host 工具调用内部入口。

**SQL 接入规则：**

- 初期适配既有 SQL 执行方法，禁止外围再创建第二条主记录。
- 将现有记录生命周期逐入口提取到 `operation-runtime`，执行算法保持原样。
- SQL 批次和步骤关系保持现有语义，不将每个步骤误记为新的顶层操作。
- 旧 `query/manual-query/shared-query-*` 等 action 保持输入和返回兼容。

**删除：**已经迁出的重复取消绑定、记录创建、结束发布，以及公共层中的 Redis 专属解析和结果投影。

---

### 3.4 AI 共编与文档

**新增：**

- `src/client/use-execution-document.ts`
- `src/shared/execution-document-sync.ts`

公共 hook 提供：

```text
load()
edit(text, context)
takeOver()
returnToAi()
applyEvent(event)
```

**修改：**

| 文件 | 抽取内容 |
|---|---|
| `ai-collab-pane.tsx` | 保存队列、接管、交还、公共冲突处理 |
| `ai-query-bus.ts` | 文档／结果匹配逻辑转交公共同步函数 |
| `redis-workspace.tsx` | 移出 `editAiText/runAiText/setControl` 和编辑队列 |
| `shared/execution-document.ts` | 文本和 context 共同参与修订 |
| `conversation-workbench-store.ts` | 调用数据源的可保存文档投影 |
| `ai-tools.ts`、`redis-ai-tools.ts` | 共用身份、文档发布与执行外围 |
| `workbench-editors.ts` | 通过文档适配读取当前内容 |

固定规则：

- 用户输入立即在客户端标记人工控制，Host 保存时复核修订号。
- AI 必须先发布实际要执行的内容，随后执行对应修订。
- 执行前再次检查控制权及修订，避免发布后被人工修改仍继续执行。
- 接管不撤销已经发出的操作。
- 迟到结果只更新自己的记录，不能替换新文本或其他连接结果。
- 重开会话恢复文本，控制权按既有规则恢复为 AI。
- SQL 旧 `SharedQuery` 通过适配投影；每个连接只保留一份权威文本状态，不双写可变副本。
- 第一轮允许 SQL 与其他数据源沿用不同的物理存储字段，但公共界面只能通过同一文档接口访问。

---

### 3.5 公共页面与经验库

**新增：**

- `src/client/source-workspace.tsx`
- `src/client/use-knowledge-library.ts`

**修改：**

| 文件 | 处理 |
|---|---|
| `workbench-shell.tsx` | 公共连接和辅助栏容器 |
| `workspace-tabs.tsx` | 公共页签编排与关闭规则 |
| `active-connection-pane.tsx` | 移出通用页签／AI／知识编排，保留 SQL 内容 |
| `redis-workspace.tsx` | 移出公共编排，保留 Key 专属内容 |
| `sql-run-workspace.tsx` | 公共按钮和编辑器插槽，SQL 动作独立 |
| `execution-workbench.tsx` | 继续承担拖动和折叠，不新增替代布局 |
| `query-result-frame.tsx` | 接受统一外围结果，载荷交模块展示 |
| `knowledge-library.tsx` | 删除固定 Redis 标签及分析文案 |
| `sql-template-library.tsx` | 复用公共列表／草稿／试运行，保留 SQL 分析扩展 |
| `knowledge-service.ts` | 协调统一知识操作 |
| `knowledge-provider.ts` | 明确保存校验、指纹、分析及存储适配 |

`useKnowledgeLibrary()` 提供：

```text
search()
select()
updateDraft()
save()
archive()
tryRun()
useForQuery()
```

存储默认值：

- 继续以 `knowledge.json` 为唯一可写文件。
- 本轮不重新设计整个物理文件格式。
- SQL 相似分析和变体语义由 SQL 适配保留。
- 历史未绑定条目只读；用户选择连接后另存。
- 同一来源 ID／版本重复绑定同一连接不产生副本。
- 打开、保存、分析均不自动执行；试运行走正常授权。

**禁止抽取：**`SqlWorkspaceTab` 中的 SQL 批量步骤、网格维护、确认、单步重试；Redis 的 Key 类型编辑逻辑。

---

## 4. Kafka 实现规格

### 4.1 客户端与依赖选择

首选精确锁定 `kafkajs@2.2.4`，仅在 Kafka Worker 内加载。官方发布页列出的稳定版本为 2.2.4；文档提供 TLS、PLAIN 和 SCRAM 配置。[发布记录](https://github.com/tulios/kafkajs/releases/tag/v2.2.4)、[认证配置](https://kafka.js.org/docs/configuration)

在正式接入前做独立探针，验证当前 Node 24、打包环境、认证、seek 和取消。**文档支持不等于当前环境实测通过。**

如果探针失败：

- 暂停 Kafka 适配。
- 报告不兼容的 API、运行环境和最小复现。
- 不使用库内部私有接口、不偷偷换客户端、不复制另一个完整 Kafka UI。
- 重新分析客户端选择后再继续。

### 4.2 文件归属

**Host：**

```text
src/host/kafka-worker.mjs
src/host/data-sources/kafka/
  module.ts
  runtime.mjs
  connection.mjs
  driver.mjs
  command.mjs
  result.mjs
  execution.ts
  explorer.ts
  ai-tools.ts
  knowledge.ts
```

| 文件 | 方法／职责 |
|---|---|
| `connection.mjs` | 验证 Brokers、TLS、SASL；指纹和安全投影 |
| `driver.mjs` | `connect/probe/listTopics/describeTopic/peek/disconnect` |
| `command.mjs` | `parseCommand/formatCommand`，Host 唯一执行语法 |
| `result.mjs` | 字节值编码、结果限量、历史摘要 |
| `execution.ts` | 接公共执行外围，解析／授权／调用 Worker |
| `explorer.ts` | Topic／分区总览及创建读取文本 |
| `ai-tools.ts` | 注册 Kafka 工具和结构化参数转换 |
| `knowledge.ts` | 保存校验、规范化指纹、说明 |
| `kafka-worker.mjs` | 握手、受限 action、取消、超时、资源释放 |
| `module.ts/runtime.mjs` | 静态绑定及运行能力声明 |

**客户端：**

```text
src/client/data-sources/kafka.tsx
src/client/kafka/
  connection-fields.tsx
  overview.tsx
  editor.tsx
  completion.ts
  results.tsx
src/shared/data-sources/kafka.ts
```

禁止新增 `KafkaAiWorkspace`、`KafkaExecutionStore`、`KafkaKnowledgeLibrary` 等平行实现。

### 4.3 连接字段

```text
brokers: 非空地址列表
tls: 默认 false
caPem: 可选
saslMechanism: none | plain | scram-sha-256 | scram-sha-512
username/password: 使用 SASL 时必填
```

规则：

- 地址逐项校验，最多 16 个，支持域名和合法 IP／端口。
- Brokers 去重；指纹使用规范化并排序后的地址集合。
- 指纹包含数据源、Brokers、TLS、认证机制、用户名、CA 摘要；不包含密码。
- PLAIN 不强制 TLS，可连接 SASL_PLAINTEXT；启用 TLS 时仍验证证书，不提供跳过证书验证选项。
- 不支持的认证机制明确报错，不能忽略后降级连接。
- 不允许用户填写业务消费组 ID。
- `clientId` 由模块生成，不作为首版表单选项。
- 测试连接使用元数据探测；不读取消息，不创建 Topic。
- 连接成功不等于每个 Topic 都有权限；对象和读取操作单独处理 ACL 拒绝。

### 4.4 首版操作语法

只实现三种命令：

```text
TOPICS

DESCRIBE "topic-name"

PEEK "topic-name" PARTITION 0 FROM BEGINNING LIMIT 20
PEEK "topic-name" PARTITION 0 FROM LATEST LIMIT 20
PEEK "topic-name" PARTITION 0 FROM OFFSET 123 LIMIT 20
```

固定解析规则：

- 命令和关键字大小写不敏感；Topic 大小写保持原样。
- Topic 使用 JSON 双引号字符串规则。
- 每次只接受一条命令。
- 不支持分号、多命令、Shell、SQL 或任意 Kafka 管理命令。
- `PARTITION`、`FROM` 必填；`LIMIT` 可省略，默认 20，范围 1～200。
- offset 以十进制字符串处理，用 BigInt 比较，禁止转为可能失真的 Number。
- 未识别字段、重复参数、负数或越界值直接拒绝。
- 补全和参数提示全部中文，但命令关键字保持上述形式。
- AI 结构化参数必须通过 `formatCommand()` 转成同一语法，再经过同一解析与执行流程。

`LATEST` 定义为：以读取开始时的分区末尾位置为界，从 `max(low, high - LIMIT)` 开始读取。它不承诺恰好返回最后 N 条可见消息；压缩或 offset 空洞可能导致数量不足，界面必须说明。

### 4.5 有界读取与取消

- 每次 PEEK 只读取一个 Topic 的一个分区。
- 获取开始时的 low／high，high 是本次读取上界；不跟随随后新写入的数据。
- 返回最多 200 条、序列化结果最多 1 MiB。
- 总操作截止时间固定 30 秒，包含连接、协调和读取。
- 达到数量／字节上限返回部分结果并标记原因。
- 到达本次 high 返回完成；截止时间前无法确认完成则标记未完成，不伪装成空结果完成。
- 禁用 Topic 自动创建。
- 使用每次操作独立生成的 `dsh-peek-*` 临时消费组，不使用业务消费组。
- `autoCommit: false`；不得调用 commitOffsets、commitOffsetsIfNecessary 或事务提交。
- seek 完成前不得向结果收集器交付消息；过滤非目标分区和范围外消息。
- 取消后停止接收结果并关闭本次 Consumer；不关闭共用 Admin 连接。
- 不在消息处理回调内等待自身 `stop()`，避免关闭死锁。
- 连接中断后不从头重放整次 PEEK；返回失败或明确的部分读取状态。
- Consumer 关闭失败时清理 Worker 中本次资源；若必须回收整个 Worker，则更新 generation 并使旧请求失效。

KafkaJS 文档明确要求 seek 在 Consumer 启动后调用，并指出关闭自动提交会影响 seek 的提交行为，因此这两项必须通过实连验证。[消费与 seek 文档](https://kafka.js.org/docs/consuming)

“只读”指不修改业务消息、Topic 配置和消费位置；临时消费组协调仍需要相应 Group ACL。不得向用户宣称完全没有服务端协调状态。

### 4.6 结果与历史

结果组件展示：

- Topic、Partition、Offset、时间。
- Key、Value、Headers。
- 本次范围、返回条数、是否截断／未完成。

规则：

- Key、Value 区分 null、空字节和二进制。
- 可无损 UTF-8 解码时展示文本，否则展示 Base64 和长度。
- JSON 仅为展示模式，不能覆盖原始文本／字节表示。
- 大值只保留受限预览及原始长度，整包仍受 1 MiB 限制。
- 历史只保存操作、目标摘要、数量、耗时、状态，不持久化消息正文、Key 或 Headers。
- 当前 AI 调用可以收到限量后的实际结果；持久历史不等于 AI 实时输出。
- 首版不提供跨请求继续读取游标；需要继续时生成带明确 OFFSET 的新草稿，由用户或 AI 显式执行。

### 4.7 AI 工具

固定新增：

```text
kafka_status
kafka_topics
kafka_describe
kafka_peek
```

- 不新增任意 `kafka_execute` 管理入口。
- 三种环境下均只允许上述读取能力，仍受真实对话身份和 Kafka ACL 限制。
- `kafka_status` 只记状态历史，不伪造操作文本。
- 其余工具发布对应 TOPICS／DESCRIBE／PEEK 文本，复用公共控制权和修订检查。
- 人工接管后拒绝后续 AI 改写及执行；已发出的操作允许结束自己的记录。
- 工具输出必须包含 execution ID，以关联工作台历史。

---

## 5. 调用链与必须删除的重复逻辑

### 5.1 公共查询链

```text
SourceWorkspace
→ 当前页签文档
→ 公共执行窗口
→ 数据源执行适配
→ connectionBridge
→ 认证 HTTP
→ 实际连接模块
→ operation-runtime
→ 原 SQL 服务 / Redis Worker / Kafka Worker
→ 专属限量结果
→ QueryResultFrame + 专属渲染器
```

### 5.2 AI 链

```text
工具调用及真实对话身份
→ 数据源参数校验
→ 公共文档修订／控制权检查
→ 发布实际执行文本
→ 同一执行链
→ 单一 ExecutionStore
→ 公共事件订阅
→ 匹配文档的结果展示
```

### 5.3 经验链

```text
当前执行内容
→ 公共经验草稿
→ 数据源保存校验／指纹／分析
→ 现有统一存储

试运行
→ 公共执行窗口
→ 同一执行授权
```

### 5.4 删除清单

只能在调用迁移和回归通过后删除：

- Redis 页面自有 AI 编辑队列及控制权状态。
- Redis 页面自有经验列表、草稿和试运行状态。
- SQL 页面中迁出的通用 AI／经验外围逻辑。
- 公共代码中 Redis 命令解析、结果解释、工具名筛选。
- 重复的运行取消监听、主记录创建和终态发布。
- 能力注册表中的重复产品清单。
- 已无调用的布局和样式。

删除前检查代码引用、测试引用、构建复制及包清单。仍承担专属行为的函数不得删除。

---

## 6. 分阶段任务、验证与停止条件

| 阶段 | 实施内容 | 验证通过标准 | 停止条件 |
|---|---|---|---|
| S0 基线 | 记录修改、检查结果及旧失败；Kafka 客户端探针 | SQL／Redis 基线可复现；Kafka 探针可说明支持边界 | 当前代码与前述状态明显不同，先更新分析 |
| S1 页面 | 修复 Redis 遮挡和补全；辅助栏抽屉 | 实际安装页面可点击、编辑、执行；420／768／1200px 宽度无遮挡 | 只能靠强制点击或改大窗口通过 |
| S2 模块 | 注册、配置适配、原三源接回 | 旧记录无需迁移；模块隔离；Worker 启动正常 | 公共层仍要求新源伪造 SQL 字段 |
| S3 公共流程 | 执行外围、AI 文档、经验草稿 | SQL 原流程不变；Redis 实际复用；无重复记录 | 权限、确认、接管、结果归属发生变化 |
| S4 Kafka | 按第 4 节实现 | 连接、元数据、PEEK、认证、取消实连通过 | 需私有客户端 API 或无法保证不提交 offset |
| S5 闭环 | Kafka 接公共查询／AI／历史／经验 | 完整闭环不新增平行页面 | 公共业务文件出现 Kafka 特判 |
| S6 最终 | 全部回归、打包、文档、冗余清理 | 同一代码版本的最终报告齐全 | 存在未解释失败或旧行为回归 |

S0 开始时新增 `docs/data-source-foundation-progress.md`，逐阶段记录：

```text
状态
实际修改文件
迁移的方法及新位置
保留的兼容入口
运行命令与退出结果
报告路径
偏差及调整原因
下一阶段前置条件
```

不能仅写“已完成”，必须附对应验证证据。

---

## 7. 测试文件与验收命令

### 7.1 必须新增或扩展的测试

| 测试 | 覆盖内容 |
|---|---|
| `source-module-contract.test.mjs` | 缺能力、重复／未知 ID、根模块分派、无整页绕过 |
| 新增 `source-connection-config.test.mjs` | 多地址、敏感字段、旧记录兼容、失败编辑保留 |
| 新增 `operation-runtime.test.mjs` | 单一主记录、取消、终态幂等、代次、监听器清理 |
| `execution-document.test.mjs`、`ai-query-sync.test.mjs` | 修订、context、接管、迟到结果 |
| `knowledge-service.test.mjs`、`knowledge-store.test.mjs`、`sql-templates.test.mjs` | 统一调用、旧模板、历史绑定和版本 |
| 新增 `kafka-command.test.mjs` | 三类命令、引号、参数重复、offset 精度、拒绝未知操作 |
| 新增 `kafka-result.test.mjs` | null／空／二进制、Headers、总字节上限、历史不含正文 |
| 新增 `kafka-worker.test.mjs` | 取消、超时、无提交调用、错误脱敏、资源清理 |
| 新增 `kafka-ai.test.mjs` | 身份、控制权、发布文本、限量输出、记录关联 |
| 新增 `kafka-completion.test.mjs` | 中文帮助、参数位置、接受候选不执行 |
| `package-runtime-closure.test.mjs` | Kafka Worker 及相对导入完整，客户端／Host 主入口无驱动 |

Mock 驱动测试必须断言 `commitOffsets` 等方法调用次数为零，但不能以此替代实连断言。

### 7.2 Kafka 实连脚本

新增：

- `scripts/kafka-fixture.mjs`
- `scripts/kafka-acceptance.mjs`
- `scripts/installed-kafka.mjs`

要求：

- 创建本轮拥有、带 run ID 标签的一次性 Kafka 容器。
- 镜像使用固定版本，首次成功运行记录 digest；后续同轮回归使用相同镜像。
- fixture 准备 Topic、分区、测试消息和独立业务消费组基线。
- 产品客户端使用受限读取账号；fixture 管理账号不得进入产品连接。
- 验证无认证、TLS、自定义 CA、PLAIN、两种 SCRAM。
- 验证错误密码、错误 CA、Topic ACL 拒绝、临时 Group ACL 拒绝。
- 验证消息为空、二进制、offset 空洞、越界、超大值、取消、断线及超时。
- 比较前后业务消费组已提交位置不变；检查本次临时组没有提交 offset。
- 清理前验证容器 ID 和标签，只清理本轮资源。

认证 fixture 无法运行时，相应场景标记 `NOT_RUN`，Kafka 完整验收保持未完成，不把无认证通过写成全部认证通过。

### 7.3 现有命令

```powershell
npm run typecheck
npm test
npm run build
```

或运行完整组合：

```powershell
npm run check
```

已有浏览器与包检查：

```powershell
npm run test:completion-ui
npm run test:ui
node scripts/unified-workspace-ui-acceptance.mjs
node --experimental-strip-types --test test/package-runtime-closure.test.mjs
```

### 7.4 新增 npm 命令

在 `package.json` 中新增：

```text
test:workspace-ui     → unified-workspace-ui-acceptance.mjs
test:kafka           → kafka-acceptance.mjs
test:package-closure → 实际构建产物及发布包闭包检查
```

保留原 `test:package` 的行为，不静默改变命令含义。

修改 `host-acceptance.mjs`，增加 `DSH_TEST_KAFKA=1` 开关，并调用 `installed-kafka.mjs`。

### 7.5 最终顺序

```powershell
npm run check
npm run test:package-closure
npm run test:completion-ui
npm run test:workspace-ui
npm run test:mysql
npm run test:oracle
npm run test:redis
npm run test:kafka
```

Redis 测试必须先改为本轮自建 fixture；当前含清库操作的固定端口脚本不能无确认目标归属地直接运行。

最后在专用 PowerShell 进程执行无豁免安装：

```powershell
Remove-Item Env:DSH_TEST_ALLOW_VERSION -ErrorAction SilentlyContinue
$env:DSH_TEST_DATABASES = '1'
$env:DSH_TEST_REDIS = '1'
$env:DSH_TEST_KAFKA = '1'
npm run test:host
```

构建、打包和安装不得并行修改同一产物。发布包必须维持 Host ESM、客户端 ModuleLoader 包装；Kafka 驱动仅属于 Worker。

---

## 8. 不允许改变的行为

1. 旧连接 ID、已保存密码读取、Oracle Service／SID 和旧指纹。
2. 工作区连接共享与现有对话身份规则。
3. SQL 系统对象限制、语句拒绝、维护确认、结构核对和影响行数限制。
4. MySQL／Oracle 事务与恢复差异。
5. Redis 空默认黑名单、人工命令规则、SIT／UAT／PVT AI 权限差异。
6. Redis 命令隔离连接和写入结果未知时不自动重放。
7. 用户修改即接管、交还前 AI 不覆盖、迟到结果不覆盖当前文档。
8. SQL 批量、选择执行、重试和可编辑结果体验。
9. 补全接受与命令执行分离，输入法和快捷键保持正常。
10. 知识打开不执行、试运行重新授权、旧模板和历史条目不丢失。
11. 密码、CA、驱动原始异常不进入客户端快照和执行记录。
12. 单元测试、受控工具调用、Web、Desktop、容器和业务环境分别报告，不互相替代。

---

## 9. 遇到偏差时的强制处理流程

出现以下任一情况，停止受影响步骤：

- 方法职责或调用关系与计划不同。
- 待删除代码仍承担专属行为。
- 现有记录或配置格式与预期不同。
- 客户端能力不能满足 Kafka 有界读取要求。
- 必须扩大权限、改变旧操作路径或修改持久化语义。
- 为接 Kafka 需要在公共业务代码加入产品特判。

处理顺序：

1. 保存最小复现、失败报告和相关调用链。
2. 判定属于旧缺陷、测试问题、计划错误或本轮回归。
3. 在进度文档记录原假设、实际证据、影响范围和修订方案。
4. 仅名称、文件位置等实现差异可在既定范围内调整。
5. 涉及权限、数据、用户体验或首版范围的变化，提出具体方案并重新确认。
6. 修订后的阶段验证通过后再继续。

禁止通过删除有效测试、放宽权限、吞掉错误、强制点击、使用假数据冒充实连，或重置已有修改来完成任务。

**最终完成定义：现有三种数据源无回归，Kafka 按本规格走通连接、总览、读取、AI 共编、记录和经验闭环；其新增业务实现集中在 Kafka 模块，公共流程没有为 Kafka 另写一套。**

## 当前文档入口（2026-09-30）

本文件保留历史施工与决策。当前接入步骤以 ../data-source-onboarding.md 为准，当前模式和兼容边界以 ../data-source-architecture.md 为准；本说明不改写历史验收证据。

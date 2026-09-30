# 数据源底座实施记录

## 2026-09-30 组件抽取后修复（本轮）

- S0 基线：本轮重跑 typecheck 和完整测试均退出 0，510/510；没有使用旧评审的 509/510 作为结果。保留原有修改，未提交、未重置。构建产物继续由现有脚本生成。
- S1 实际文件：`src/shared/execution-document.ts`、Host `connection-service.ts`／`connection-api.ts`／`redis-ai-tools.ts`；客户端 `workspace/source/use-execution-document.ts`／`source-workspace.tsx`、`workspace/knowledge/use-knowledge-library.ts` 和 `redis/workspace.tsx`。文本与目标原子修订，旧 database 输入仍转发到相同更新实现。目标保存失败可重试；旧草稿试运行、保存、归档错误不得回写新草稿。
- Redis 最终复核已移动到 `#withReadonly` 回调，位于 `#dispatch` 之前。真实服务＋Worker fixture 验证 AI 与人工共编执行排队期间接管、改文本、切库和更换 generation 不派发；人工文档拒绝保留单一主记录。`test/redis-target.test.mjs` 12/12 通过。
- S2 实际文件：客户端绑定 types、`workspace-sources.tsx`、Redis workspace 及公共 SourceWorkspace；移除 `wrap`／React 整页 Context Provider，改为 editorContext。Redis 补全 identity 加 DB，历史和候选状态回调核对目标。公共 DbTable 提供比较器；Kafka 水位、offset、lag 使用 BigInt 比较，空值仍放末尾、相同值稳定。
- S2 Host：module-types、modules、Redis module 和 Kafka execution 增加规范化目标及明确授权；标准模块缺少任一能力会拒绝。模块提供 Worker input；SQL／Redis 保留兼容适配。没有新增 Kafka 操作。
- S3：扩展实际 Hook 浏览器脚本，新增切库迟到结果、上下文保存失败重试、草稿迟到错误。测试源通过 `source-module-ui-acceptance.mjs` 仅在隔离构建的静态绑定处注册，走正式认证、ConnectionService、Worker、公共页签、AI 工具和经验持久化；未加入生产 ID 或发布包。
- 最终运行时代码验证：`npm run check` 退出 0，519/519 测试、类型检查和构建通过。`test:package-closure`、`test:completion-ui`、`test:workspace-races`、`test:workspace-ui`、`test:kafka-tree`、`test:mysql`、`test:oracle`、`test:redis`、`test:kafka` 均退出 0。日志逐项保存于 `artifacts/foundation/`。容器为本轮自建 fixture；Kafka 含 TLS／CA、PLAIN 有无 TLS、两种 SCRAM、错误密码／CA、Topic／Group ACL，未提交临时组 offset，业务组位置保持不变。
- 保留兼容入口：SQL legacy-sql、SQL／Redis legacy-adapter、旧 HTTP action（已确认删除的 shared-query-confirm 除外）、原经验存储格式。ApprovalLedger 不恢复。
- 偏差依据：现有 Worker 注入只覆盖 SQL，新增可选 Worker factory 以测试真实 Redis 并发队列；生产默认创建逻辑及资源限制不变。模拟源不修改公共业务代码，只在测试构建中增加静态注册；发布包闭包继续验证隔离。
- 环境边界：Oracle 19c／SID、真实 Desktop、业务集群、Redis Cluster／Sentinel 为 NOT_RUN；本轮 Redis fixture 关闭 TLS，其 TLS 增量不得借 Kafka TLS 结果标为通过。
- 安装验收适配：通过 `DSH_DESKTOP_APP` 指向本机 DSH Desktop 安装目录。`scripts/host-acceptance.mjs` 支持当前 ASAR CLI 和旧安装布局；通过官方 CLI 启动一次性 profile，未重启实际 Desktop。新增 `scripts/harness-onboarding.mjs`，只处理平台公开的“预览版说明／内测声明”和“稍后配置”；`installed-business.mjs` 在 reload 后复用。不强制点击、不配置模型 API Key。`installed-redis.mjs` 搜索定位同步为当前“搜索 Key”。这些是验收脚本调整，未修改运行时代码。
- 最终安装：设置 `DSH_DESKTOP_APP` 后移除 `DSH_TEST_ALLOW_VERSION`，开启 DATABASES／REDIS／KAFKA 后 `npm run test:host` 退出 0。实际平台版本 `0.2.0-rc.2`；无豁免安装、真实挂载会话、认证、SQL 维护、Redis 命令／Key／AI 文档／经验、Kafka Topic／PEEK／AI 文档／经验均通过，浏览器无 pageerror。报告为 `artifacts/host/latest.json`，完整输出为 `artifacts/foundation/test-host.log`。真实模型工具调用和实际 Desktop GUI 仍为 NOT_RUN；这里验证的是已安装平台的 ASAR CLI＋Web。
- 源码摘要：408 个文件（src、test、scripts、package.json、package-lock.json），按路径排序的逐文件 SHA-256 清单再取摘要：`57a59a5629d28fc721c6fdcf2aa59f037befa237565afaa9008f59ddd4c1de6c`。最终运行时代码通过上述整套验收；最后只修正安装脚本的路径、平台初始弹窗、现有 Redis 定位与人工记录断言，未再修改 src。脚本语法检查通过。
- 旧安装断言偏差：人工 Redis 命令现有设计会建立记录，因此将“没有人工记录”改为 PING／SET／GET 各一条，且不保存 Key 参数、不持久化结果；未改变产品行为或放宽权限。
- 本轮交付边界：执行目标、修订、队列和草稿隔离修复完成；标准模块上下文及授权接口完成，测试源走真实公共认证、查询、AI 接管／交还、单一记录和经验闭环。SQL 专属流程与部分 Redis 执行外围继续由兼容适配承载，不表述为全部迁移完成。

## 2026-09-30 修复与最小接口收口基线

- 工作区已有大量未提交及未跟踪改动，保留原状；本轮仅修改 `dsh-database`。
- 包版本 `0.1.0-alpha.12.15`，KafkaJS 精确锁定 `2.2.4`。
- `npm run typecheck`：PASS；`npm test`：495/495 PASS。计划中的 490 项是旧快照，后续按本次实际数量记录。
- `npm run build`：FAIL，esbuild 写入 `lib/index.js` 返回 `Access is denied`。尚不能判定为代码错误；后续单独核对文件锁、权限与构建产物，不以旧安装报告代替当前代码验收。
- 当前 `artifacts/host/latest.json` 的成功报告早于本轮 Redis 工作区迁移，需在同版本代码上重跑。
- Kafka PLAIN 可在无 TLS 时连接是用户确认的规则；计划及文案需同步，TLS 开启时仍必须验证证书。
- 本轮顺序：异步正确性、Redis 本地 Key 补全、Kafka 读取、最小模块接口、同版本验收。每阶段记录实际改动与验证结果。

## 2026-09-29 基线

- 工作目录：本仓库根目录。仓库已有大量未提交改动；本轮不重置或覆盖其他插件。
- `npm run check`：Host/Client 类型检查通过；468 项测试中 467 项通过，`test/bounded-parser.test.mjs` 首次运行报 `PARSE_TIMEOUT`，因此构建未进入。单独重跑该文件 3 项全过，说明该 5 秒测试存在负载敏感性；不把首次失败算作本轮回归，也不放宽其断言。
- 既有 `artifacts/host/latest.json` 是 Redis 已安装 Web 验收失败，执行按钮被 Key 列表挡住；另外有 Key 补全候选超时记录。
- 现有 MySQL/Oracle/Redis、Web/Desktop、真实模型的通过或 NOT_RUN 状态需要在最终版本重新逐项验收。

## 阶段 S1：窄侧栏布局与 Redis 安装验收

- 状态：主要阻塞已解除；多宽度与深浅色专项尚未运行。
- 当前修改：`src/client/ai-executions.tsx` 根据实际宽度将历史及记录详情变为浮层；`src/client/redis-workspace.tsx` 增加 Key 抽屉；`src/client/style.css` 让内容区成为容器查询边界，窄时保留执行区域。
- `npm run typecheck`：PASS。
- `npm run build`：PASS（受控沙箱需写入权限）。
- `node scripts/unified-workspace-ui-acceptance.mjs`：PASS。
- 无版本豁免 `DSH_TEST_REDIS=1 npm run test:host`：第一次已越过此前失败的执行和补全步骤，随后旧脚本的 `getByLabel` 同时匹配容器和输入框；修正为 textbox 并打开抽屉后重跑 PASS。报告：`artifacts/host/run-KsOLaL/report.json`。
- 尚需：420／768／1200px、深浅色专项；修正 `bounded-parser` 基线的负载敏感性之前不放宽测试要求。

## 阶段 S0 / S2 增量证据

- 完整 `npm run check` 曾在 S1 后通过：468/468 测试、类型检查和构建均成功。S2 模块接回后再次执行，473 项中 472 项通过；唯一失败仍为迁移前同一条 `bounded-parser` 5 秒超时，构建因此未进入。保留原测试，后续重跑以区分负载抖动。
- 客户端新建 `src/client/data-sources/` 静态模块，现有三源表单和工作区通过它接回。Host 新建各源 `module.ts`，对象浏览和经验服务从统一模块取能力。`npm run typecheck` 和 `test/source-module-contract.test.mjs` 通过，后者新增缺项、重复及未知 ID 拒绝。
- KafkaJS 2.2.4 以精确版本安装；Node 24 公共 API 探针通过。第一次临时 broker 的 advertised listener 不可达，重建为完整 KRaft 配置后通过元数据读取。一次性 broker 为 `apache/kafka@sha256:77e3df9054047a88b520d0cc46e16696d3b22022e1d580aeccd2632df6532837`、Kafka 4.3.1，容器带 `dsh.run=foundation-probe-20260929` 标签。`scripts/kafka-client-probe.mjs` 实测 KafkaJS seek 及产品 PEEK 原型读取两条消息，临时组无提交位置。KafkaJS 产生 Node 24 负数计时器警告但未阻止读；认证和取消尚未探测。
- Kafka 命令解析及结果编码已独立落到 `src/host/data-sources/kafka/`，目标测试 4 项通过。它们尚未接入正式 Host 或界面，不计作 Kafka 工作流完成。

## 阶段 S2 / S3 / S4 当前增量

- 状态：Kafka 已接入正式静态注册、连接表单、Topic／分区总览、公共查询页、AI 共编页、历史详情和经验入口。旧三源继续保留原工作区。公共执行入口目前由 Kafka 模块解析命令并选择 Worker action；SQL／Redis 的执行记录外围尚未迁入 `operation-runtime`，不能宣称 S3 全部完成。
- 主要新增：`src/client/data-sources/kafka.tsx`、`src/client/kafka/`、`src/host/data-sources/kafka/`、`src/host/kafka-worker.mjs`、`src/host/operation-runtime.ts`；改动两端静态模块、连接服务、共享连接类型、执行详情、打包文件清单。Kafka AI 工具只注册 status/topics/describe/peek；执行文本先写入共编文档，实际派发前再核对修订和控制权。
- `scripts/kafka-host-probe.mjs` 对本轮带标签的一次性无认证 broker 实测：测试及打开连接、保存脱敏、TOPICS、DESCRIBE、PEEK 均通过。KafkaJS 2.2.4 在 Node 24 仍发出负数 timer 警告；未把这个警告视为功能通过的证明。TLS、CA、PLAIN、SCRAM、ACL、取消、超时和浏览器 Kafka 页面尚未实测。
- `npm run check`：PASS，475/475 测试、类型检查、Host/client 构建均通过。`test/package-runtime-closure.test.mjs` 随完整测试通过，Kafka Worker 已加入复制和发布文件清单。尚需做实际 npm pack／安装后的运行时闭包验证。
- 偏差：旧 `src/host/data-sources/registry.mjs` 是 SQL／Redis 专属 Provider 注册表，不含 Kafka；正式全源入口是 Host `modules.ts` 与 `runtime-registry.mjs`。因此更新旧 Redis 测试断言以明确区分两个注册层，没有给 Kafka 伪造 SQL／Redis Provider。
- 下一阶段前置：补有主权的一次性 Kafka 验收 fixture，验证 SASL/TLS 和消费位置；补 AI 控制权／记录单测与 Kafka 浏览器流程；随后跑实际发布包、无豁免 Web 安装及 MySQL／Oracle／Redis 回归。缺少环境的项目逐项标 `NOT_RUN`。

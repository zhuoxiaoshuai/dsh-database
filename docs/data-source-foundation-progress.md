# 数据源底座实施记录

## 当前根因修复

本轮权威事实收敛、权限及批量语义已经改变。当前实现和验收以 [根因修复实施记录](plans/root-repair-implementation.md) 为准。下方为历史阶段记录，其旧 SharedQuery、配额、权限、部分执行及安装验收结果不作为当前版本验收证据。

## 2026-10-02 Kafka 只读完善与评审修复（完成）

- S0：保留全部既有修改，HEAD b31a2cf7f7bca068537e5d30bc8b0ec2300ef807；基线 typecheck、653/653 测试通过。记录 artifacts/kafka-readonly-status-before.txt、kafka-readonly-baseline-typecheck.log、kafka-readonly-baseline-test.log；旧验收未作为本轮通过证据。
- S1：Kafka operation-scope 增加元数据统一预算/取消；driver 保留独立 Consumer、固定 low/high、不提交 offset、不重启、30 秒与 1 秒清理预算。新增去重和范围跨越判断，纯过滤/控制批次缺证明时仍 deadline/未完成。Worker 区分连接故障与 ACL/输入错误；Admin 连接失败清理有上限。该记录里的错误改写已改为原文返回。
- S1：overview 复用公共 request-scope，连接/代次/分类/刷新/卸载使旧子节点及详情失效。result.mjs 增加 Kafka 专属 JSON UTF-8 结果限量、数量/字节列表分页及明确的详情截断。公共工作台、协议、存储格式和 SQL 算法未修改。
- S2：command 增加 TOPICS/GROUPS SEARCH/CURSOR 和 GROUP TOPICS CURSOR；关联 Topic 可继续加载，结果生成下一页草稿而不执行。ai-tools 新增 kafka_groups/group/group_topics/group_topic，topics 增加可选分页参数，经原标准文本链复核文档及单一记录。execution 的 projectLiveResult 委托现有公共服务一次发布结果，工具不再重复发布完成事件。
- S2：completion 根据 JSON 引号、光标和参数位置补全；name-cache 每类 5,000 项、总 UTF-8 1 MiB，连接/代次隔离，三个编辑器共用既有 editorContext，无在线名称扫描。消息支持完整 JSON 格式化、复制预览、有限结果导出；message-view 复用现有 formatValue 保留大整数和重复字段，不改原文/字节。导出不补读，Blob URL 及时释放。
- S3：删除未使用 kafkaHistorySummary、pageByCursor、旧拆词和重复 AI 完成事件，替代位置见 docs/kafka-readonly-review.md。没有新增公共产品判断、平行 Kafka 工作台或全局状态。经验校验实际位于既有 knowledge-policy.ts，直接复用同一解析/格式化，无需另建计划中拟名 knowledge.ts。
- 专项修复证据：kafka-group-health-repro.log 保存 Lag 将网络故障当作未知指标的修复前失败；driver 现在重新抛出连接/认证/超时错误，仅 ACL/单项指标不可用保留部分信息。kafka-json-precision-repro.log 保存格式化大整数显示失真的修复前失败；现有格式化 helper 修复并有回归。
- 测试前置偏差：安装首次失败 artifacts/host/run-my4Co1/report.json，Oracle 19c 新建 TEXT_FLOW 后只读快照报 ORA-01466。artifacts/kafka-oracle-ddl-probe.json 用原始驱动复现立即失败、稍后成功；installed-business 仅在准备测试表时做最多 5 秒的原始驱动 readiness，其他错误仍抛出，不重试任何产品请求。浏览器脚本原 getByRole 默认排除隐藏抽屉节点，改为 DOM 挂载前置检查后真实点击；未强制点击、改布局或放宽权限。
- S4 全部 PASS：npm run check 退出 0，683/683、typecheck/build 通过；test:kafka-readonly-ui、test:kafka-tree、test:sql-workspace、test:source-module、test:workspace-races、test:workspace-ui、test:completion-ui、test:package-closure 均退出 0。日志 artifacts/kafka-readonly-final-check.log、kafka-readonly-final-test-*.log。Kafka UI 通过实际 StandardSourceMount/模块挂载及受控桥接，420/768/1200px × 深浅色、三个编辑器名称缓存、键盘/鼠标/组合态、不执行补全、JSON/导出、下一页草稿及旧子节点失效；受控测试不当作实连。
- 实连 PASS：DSH_TEST_EXISTING_ENV=1 npm run test:kafka-existing，artifacts/kafka-readonly-existing-report.json，7 项专项。现有 PLAIN 无 TLS容器跨 100 项搜索分页、四个组工具/Lag、二进制/空值/重复 Header/大预览、单记录/一次事件/关联/经验/接管；真实临时组无提交位置，测试业务组位置不变。中止事务 range [0,2) 返回 deadline 且无中止消息；实际 Consumer 读取中取消后共享 Admin 仍可用。仅操作本轮唯一命名对象，清理 PASS。
- 安装 PASS：artifacts/host/run-DSun4R/report.json，Harness 0.2.0-rc.2 的 ASAR Node runtime，一次性 Web profile，无 allow-version，复用 mysql8/oracle19/redis/kafka。MySQL 与 Oracle 19c Service 读写权限、部分执行、共编、解释和维护回归通过；Redis 安装流程通过；Kafka 新组/Topic/Lag、PEEK/JSON、历史、人工文档及经验通过；无浏览器 pageerror。日志 artifacts/kafka-readonly-final-host.log。Tab 挂载、认证、重复进入、ModuleLoader/Host ESM 和 Worker 包依赖通过，不需要修改平台声明。
- 最终源码：441 个 src/test/scripts/包声明文件，artifacts/kafka-readonly-source-final.json SHA-256 `48ab7800a60551ee44197f93240cea970b28eebb1f365004b64f176c0e046d71`；after-install 清单完全一致。说明文档在验收后补写，不在源码摘要内。
- 清理 PASS：artifacts/kafka-readonly-cleanup.json，四个既有容器 ID 不变且运行中；MySQL/Oracle 测试命名空间、Redis fixture Key、Kafka fixture Topic 残留均 0。未下载镜像、创建替代容器或更改 listener/ACL。
- 交付：docs/kafka-readonly-review.md、当前架构/接入指南、中英文 README、artifacts/kafka-readonly-report.json。KafkaJS 2.2.4/Node 24 的既有 TimeoutNegativeWarning 保留日志，未修改库私有实现。
- NOT_RUN：真实 Desktop GUI、真实模型/安装后实时模型 callId、业务集群、Oracle SID、Redis Cluster/Sentinel、当前实例之外的 TLS/SASL、受限 Topic/Group ACL 拒绝、实际 broker 断线注入/压缩调度。需要相应 listener/CA 和受限测试账号后再独立验收；单元/受控组件/容器/Web 不互相替代。

## 2026-10-02 本地 AI 工具生命周期收口

- S0 PASS：保留工作区全部已有修改，HEAD `b31a2cf7f7bca068537e5d30bc8b0ec2300ef807`；基线 typecheck 和 npm test 退出 0，607/607。日志 `artifacts/local-ai-baseline-typecheck.log`、`artifacts/local-ai-baseline-test.log`；源码清单 `artifacts/local-ai-source-before.json`，文件 SHA-256 `ac48abae0c1f785174bf30121a9c94333ca029ef31fb7dcc24a9a260d51e3421`。lib 无已跟踪产物；未重置其他修改。
- S1/S2：`operation-runtime.ts` 提取私有 runLifecycle，保留 runOperation 签名并新增 runLocalOperation；新增 `local-ai-operation.ts` 保留原脱敏错误分类。ai-tools 的导入、经验 search/get/save、读取共编五个分支委托新适配；删除 withRecord、mergeSignal 及分支 create/complete/控制器。业务服务、持久化和权限未修改。
- 兼容对照：五个分支均保留 tool/隐藏历史、原标题/原因/结论、callId/rootCallId、JSON 字段及 SQL/草稿补充；无连接关联时保持缺省，离线保存不创建 Worker。get 缺失模板继续产生失败记录；缺必要参数在记录前拒绝；普通 query/manual-query 和状态读取继续不记主记录。新增加的明确修复是提前取消不进入业务以及所有出口释放监听器/控制器。
- 专项证据：`artifacts/local-ai-targeted-fixed.log` 54/54。首次 `artifacts/local-ai-targeted.log` 两项失败均为新增测试前提错误：工具参数混入 password 被既有 schema 拒绝；离线连接没有 generation，不能模拟数据库代次失效。测试改为合法导入参数和真实 cancelConversation；未修改产品校验、持久化或 ExecutionStore。额外补充 Host 超时分类和记录创建失败清理，随最终 check 验证。
- 中断记录：首次测试补丁因自动审批服务用量限制未执行，用户要求继续后正常补写；没有绕过审批。最终代码、浏览器、发布包和现有四容器安装验收尚待本节追加，旧报告不作为本轮结果。
- 本地保存取消边界：已经提交的保存仍返回完整回执，不重试；已有 cancelled/unknown 保持终态。外部信号单独取消且收到确定成功结果时沿用原成功语义。真实注册工具＋ConnectionService＋实际临时经验存储验证了这一点，不等于模型实测。
- S3 最终 PASS：`npm run check` 退出 0（629/629、typecheck、build），日志 `artifacts/local-ai-final-check.log`。串行 `test:sql-workspace`、`test:source-module`、`test:workspace-races`、`test:workspace-ui`、`test:completion-ui`、`test:package-closure` 全部退出 0，日志 `artifacts/local-ai-final-test-*.log`。浏览器包含两种 SQL 方言、真实标准挂载、420/768/1200px、深浅色、竞态及补全；受控桥接不代替实连。
- 最终源码：426 个 src/test/scripts/包声明文件，清单 `artifacts/local-ai-source-final.json` 的文件 SHA-256 为 `1ac363457edd2095c83aef4407767d7f91f7e3c3cdd364ef390f8824c9d9613f`；安装后重新生成 `artifacts/local-ai-source-after-install.json`，摘要完全相同。相对基线仅 7 个源码／测试文件改变：ai-tools、operation-runtime、新 local-ai-operation，以及 operation-runtime/database-ai/database-host/new local-ai-operation 四个测试文件；其他修改为本轮三个说明文档，已有工作保持。
- 四源安装 PASS：`artifacts/host/run-OXYLwT/report.json`，Harness 0.2.0-rc.2，`DSH_TEST_EXISTING_ENV=1`，无 allow-version。现有 mysql8、oracle19、redis、kafka 完成目录／查询／维护／共编／经验等安装回归；Oracle 为 19c Service，Kafka 为 PLAIN 无 TLS。日志 `artifacts/local-ai-final-host.log`。没有下载镜像或重建容器。
- 清理 PASS：`artifacts/local-ai-cleanup.json` 确认四个容器 ID 不变且运行中；DSH_WEB 数据库／Oracle 用户、Redis fixture Key、Kafka fixture Topic 剩余均为 0。只读核对版本 MySQL 8.4.11、Oracle 19.0.0.0.0、Redis 8.10.2。KafkaJS 在核对中输出既有 TimeoutNegativeWarning，保留警告记录，没有忽略失败或修改运行时。
- 汇总交付：`artifacts/local-ai-report.json` 含命令、退出码、源码摘要、包摘要、安装与清理路径。真实 Desktop GUI、真实模型调用及安装环境实时工具 callId 关联、Oracle SID、业务集群、Redis Cluster/Sentinel 为 NOT_RUN；本轮现有实例之外的 TLS/SASL 矩阵未重跑，不以旧报告替代。SQL Host 仍为 legacy-adapter，普通查询／维护算法未迁移，普通 SQL 不新增历史。

## 2026-10-01 恢复现有容器后补验收与接管保存竞态

- 用户恢复 Docker 后，确认 mysql8、oracle19、redis、kafka 都在原端口运行。开始时源码与目录阶段的 `64dd82edd93aac4b9c60fd4102b5d9caa78c98bb051f8fdc223de9a4942cd24e` 一致；无镜像下载或容器替换。
- 首次四源报告 `artifacts/host/run-TJ5DVj/report.json` FAIL；MySQL、Oracle 19c Service、Redis 通过，Kafka 普通查询通过，AI 共编执行失败，页面明确显示“当前内容尚未保存，不能执行”。原失败日志和截图保留，不能将其改写为全部通过。
- 实际原因：标准 useExecutionDocument 的 control 请求与 saveDraft 独立排队，Host 接管增加 revision，而本地有新输入时控制响应未推进 revisionRef；后续保存可能用旧修订被拒绝。局部修复将控制与保存串行，保留立即人工接管；控制响应只更新修订基准、不覆盖新草稿；交还途中输入的补偿人工控制在后续保存前完成，不等待自身队列；卸载／旧作用域不发送后续控制请求。
- 实际文件：`src/client/workspace/source/use-execution-document.ts`、`scripts/workspace-race-ui-acceptance.mjs`。没有改 SQL 保存队列、Host 授权、持久化或 Kafka 操作能力。最初新增竞态用例仅延迟服务端应用，仍通过；随后改为真实 controlExecutionDocument 已生效但响应迟到，并断言后续保存必须等待修订确认。另验证卸载不会派发排队控制请求。没有放宽 Kafka 安装脚本的等待时间或重试执行。
- 修复后同版本 check：607/607、类型检查和构建通过。SQL 工作台、模拟源、工作台竞态、公共四源页面、补全及包闭包全部退出 0；日志 `artifacts/catalog-four-source-final-*.log`。424 个文件源码摘要 `1c6a002d7d1381be8bc7a49f6bd939d4c907769e4e2ce4c59148c318a4d7aafb`，清单 `artifacts/catalog-source-after-takeover.json`。
- 四源最终无豁免安装正在补跑；最终报告及清理检查在本节追加，之前 PARTIAL_ENVIRONMENT_BLOCKED 是上一版本的历史阶段状态。
- 最终四源安装：`artifacts/host/run-exBsqz/report.json` PASS，Harness 0.2.0-rc.2，无 allow-version；MySQL 8.4、Oracle 19c Service 的目录／查询／维护／共编，Redis 命令／Key／共编／经验，Kafka PLAIN 无 TLS 的 Topic／有界 PEEK／共编／经验全部通过，浏览器无 pageerror。未增加重试或延长 Kafka 页面等待来规避失败。
- 汇总报告 `artifacts/catalog-report.json` 更新为 PASS；原报告另存 `artifacts/catalog-report-before-four-source.json`，第一次失败的安装目录仍保留。最终源码 SHA-256 `1c6a002d7d1381be8bc7a49f6bd939d4c907769e4e2ce4c59148c318a4d7aafb`，安装前后相同；上节目录阶段的旧 SHA 不作为本次新增修复的证据。
- 清理核对：`artifacts/catalog-four-source-cleanup.json` PASS，四个容器 ID 与既有环境一致且保持运行；MySQL/Oracle 的 DSH_WEB 测试命名空间、Redis dsh:web 测试 Key 和 Kafka dsh_web 测试 Topic 均为 0。无容器替换、无镜像下载。Oracle 19c Service 已完成本轮实连，SID、真实 Desktop GUI、真实模型调用、业务集群及未验证的 Redis Cluster/Sentinel 继续 NOT_RUN。

## 2026-10-01 SQL 目录工具生命周期收口

- S0：HEAD `b31a2cf7f7bca068537e5d30bc8b0ec2300ef807`；保留已有未提交改动。typecheck 退出 0，基线完整测试 591/591，日志 `artifacts/catalog-baseline-tests.log`。首次沙箱日志写入被拒绝，随后在获准执行环境记录；未把未执行的测试写成通过。
- 实际文件：新增 `src/host/sql-catalog-operation.ts`；ConnectionService 增加 executeCatalogTool、catalog 的 Host 内部生命周期回调；ai-tools 的 database_catalog 改为委托服务。删除目录分支自有 create/complete/提前 dispatched 和仅供该工具使用的目录辅助实现；保留其他工具仍使用的 withRecord、mergeSignal、clipName 和 queryDraft。
- 保留入口与行为：工具名称、参数、返回字段、type=catalog、historyVisible=false、callId/rootCallId、目录 SQL/参数/草稿及原目录队列缓存。MySQL 追加索引仍为同一条主记录；表的局部 unavailable 不改成整体失败。普通目录 HTTP、总览刷新仍不建立工具记录。
- 专项：新增可控 sql-catalog-worker 与真实注册工具／ConnectionService 的 16 项测试，覆盖两种方言、冷/全/混合缓存、排队取消/会话失效/重连、编辑器目标独立、两请求间取消、ACL/错误/超时/退出、发送失败及迟到终态。最终 check 退出 0，607/607 测试及 typecheck/build 通过，日志 `artifacts/catalog-check.log`。
- 浏览器：SQL 标准工作台脚本加入实际工具与服务产生的目录记录，再传入真实客户端模块；MySQL/Oracle 页签、批量、共编、格式化、经验及 420/768/1200px 深浅色回归通过。报告日志 `artifacts/catalog-sql-ui.log`。新增测试最初传入 undefined 字段，被工具 lossless JSON 校验拒绝；fixture 改为按真实 JSON 请求序列化，未放宽生产校验。
- 计划偏差：当前目录记录已被 AI 查询历史过滤，实际页面没有目录历史项；保留该行为，改为验证真实目录记录不新增历史项或覆盖编辑结果，不为验收修改 historyVisible 或新增页面入口。目录 SQL/草稿的保留由真实服务测试验证。SQL 模块仍为 legacy-adapter，普通查询及其他工具后续单独迁移。
- 其他同源码检查：test:source-module、test:workspace-races、test:workspace-ui、test:package-closure 退出 0；日志为 `artifacts/catalog-test-*.log`。
- 环境：Docker Desktop Linux 引擎管道当前不存在，已请求用户恢复现有 mysql8/oracle19/redis/kafka。四源实连安装暂为 NOT_RUN，旧安装通过报告不作为本轮证据。不下载镜像、不创建替代容器。当前代码、浏览器及安装的最终源码摘要和报告将在本轮验收清单中记录。
- 最终同版本清单：`artifacts/catalog-report.json`；424 个源码／测试／脚本及包声明文件，按路径排序的逐文件摘要清单 SHA-256 为 `64dd82edd93aac4b9c60fd4102b5d9caa78c98bb051f8fdc223de9a4942cd24e`，安装前后相同。check 607/607、test:sql-workspace、test:source-module、test:workspace-races、test:workspace-ui、test:package-closure 均退出 0；最终日志 `artifacts/catalog-final-*.log` 与 `artifacts/catalog-check.log`。
- 本轮无豁免 Web 安装：`artifacts/host/run-iAThIi/report.json` PASS，Harness 0.2.0-rc.2；当前包串行构建／打包后在一次性 profile 安装，认证、挂载会话、公共工作台及执行列表通过，浏览器无 pageerror。本次明确关闭四源实连开关，不能替代被 Docker 环境阻塞的四源回归。总体阶段状态为 PARTIAL_ENVIRONMENT_BLOCKED；待现有容器恢复后补跑四源安装。真实 Desktop GUI、模型调用、SID、业务集群、Cluster/Sentinel 仍分别 NOT_RUN；上轮 Oracle 19c Service 成功保留为历史证据。

## 2026-10-01 SQL 共编浏览器入口收紧

- S0：HEAD `b31a2cf7f7bca068537e5d30bc8b0ec2300ef807`；保留本轮开始时全部未提交改动。基线 typecheck 退出 0；默认并发完整测试 582/582。本轮未修改 Oracle 解析器预算或断言。首次写 artifacts 日志受到沙箱限制，后续报告写入使用获准的执行权限。
- Host：新增 `sql-browser-request.ts`，HTTP run 仅接受省略或 user 身份；update 仅接受 user/format 和 sql/schema。`updateSharedQueryFromBrowser` 从真实保存连接取方言，断开时仍可编辑，校验后委托原可信内部方法。
- 格式化：核对当前文档、可选修订及未变化的 Schema，提交内容必须是原文或 Host 使用现有 sql-formatter 计算出的完整结果；不执行 SQL、不建记录、不改变控制权，校验和写入同步完成。
- 客户端：独立 `formatCurrentQuery` 等待已发保存，读取权威版本；编辑序号、连接/generation、Schema、控制操作和卸载使旧任务失效。格式化失败显示错误；保留当前草稿。未整体替换原保存流程或 SharedQuery 状态。
- 删除／替代：浏览器 ai/system 更新、AI 执行身份及任意 Partial<SharedQuery> 断言由受限适配替代；客户端格式化通用 onChange 和空 catch 由专用流程替代。Host 内部 AI/system 更新、权限和执行外围保留。
- 测试调度：npm test 固定文件并发 4，测试集合和解析器原超时语义不变。阶段服务和请求测试通过；最终命令、源码摘要与安装证据在本轮报告中记录，不能使用上轮报告替代。
- 浏览器偏差：新增断言起初错误地假定默认格式化器会大写关键字；实际默认保留大小写，已按现有格式配置修正。新增卸载场景中旧计数将已取消等待回收的请求当作活跃订阅，fixture 改为在取消时同步结束并移除监听器，仍断言活跃订阅最大为 1。连接切换实际会恢复查询页，验收明确回到 AI 页再验证 Schema。
- 实施边界：本轮不迁移 catalog、普通 SQL、批量、维护，不改变存储格式。安装复用 mysql8/oracle19/redis/kafka，不拉镜像或创建替代容器；后续最终验收结果另行追加。
- 最终证据：`artifacts/foundation/sql-browser-report.json`。源码范围为 src/test/scripts/package.json/package-lock.json 共 421 个文件，SHA-256 `946b81ced0064866102259167a6da3084087391fe34ff545c332eedf0b75b82b`；最终验收前后核对一致。完整测试固定并发 4 连续三次 591/591，最终 check 同为 591/591，typecheck/build 退出 0；解析器预算及超时测试未改。
- 同源码最终通过：check、test:sql-workspace、test:source-module、test:workspace-races、test:workspace-ui、test:completion-ui、test:package-closure。逐命令退出码及日志见 `artifacts/foundation/sql-browser-commands.json`。前两次最终浏览器尝试及原失败日志保留，不用后续成功覆盖失败证据。
- 额外 fixture 偏差：连接切换后的旧 onWorkbench 回调原来会写入当前连接，现按 ID 隔离并恢复原连接；释放迟到响应前等待 React 真正完成身份变化／卸载。保留原 SELECT 100 草稿恢复及“不派发格式化”的断言，没有改生产持久化逻辑。
- 安装：`artifacts/host/run-n2UWEA/report.json` PASS；Harness 0.2.0-rc.2，无 allow-version；新 tgz 在一次性 Web profile 安装，MySQL 8.4.11、Oracle 19.3.0.0.0 Service、Redis 8.10.2、Kafka PLAIN 的四源流程通过。两种 SQL 的认证入口拒绝伪造来源、身份和结果字段，合法格式化保留控制权，共享 SQL／EXPLAIN 各一条记录及一次 dispatched。
- 环境清理：`artifacts/foundation/sql-browser-existing-cleanup.json` PASS，四个容器 ID 前后相同且继续运行；测试 SQL 数据库／用户、Redis fixture Key、Kafka fixture Topic 均为 0。只清理安装脚本本轮创建的对象，没有重建容器或拉镜像。KafkaJS 在 Node 24 的既有负数 timer 警告仍单独保留，未阻止验收。
- NOT_RUN：真实 Desktop GUI、真实模型及安装后的真实 AI tool/callId 关联、Oracle SID、业务集群、Redis Cluster/Sentinel。内部工具身份与关联由真实注册工具／ConnectionService 加可控 Worker 测试覆盖，不冒充实际模型调用。Oracle 19c Service 已实连通过，不再写为 NOT_RUN。

## 2026-10-01 SQL 执行生命周期收口

- 状态：S0～S4 本轮完成；现有四源无豁免安装、最终代码检查和清理核对通过。仅修改本插件，保留上一轮工作台和 Redis 生命周期的全部已有修改，未重置或提交。
- S0：当前 typecheck 通过。第一次完整检查为 547/548，已知 Oracle 解析器负载敏感超时；原文件单独 3/3 通过，原始 check 重跑 548/548、build 退出 0。日志 sql-lifecycle-baseline-check.log、sql-lifecycle-baseline-parser.log、sql-lifecycle-baseline-check-retry.log 位于 artifacts/foundation。未修改解析器或超时断言。
- S1：operation-runtime.ts 新增可信 OperationMetadata、执行回调的 OperationContext（executionId／markChecked）、延后 check-passed、projectCompletion 和完成消息；SQL historyVisible=false、SQL／Schema／目标／草稿及结果预览继续由 ExecutionStore 原限制保存。Redis／Kafka 的默认事件和无正文持久化行为保留。
- S2：ConnectionService.request 新增 Host 内部 beforeDispatch／onDispatched，经过原配额后同步复核，postMessage 成功后标记 dispatched；HTTP／Worker 无新字段，也没有第二层队列。
- S3：新增 sql-operation.ts，组合共编／执行计划的元信息、结果摘要／模型和 SQL 中断策略；runSharedQuery、explainPlan 使用 runOperation 的唯一记录和控制器。SQL 授权、TrustedAuthorization、原 query 请求、批量、维护、SharedQuery、历史可见性及模型脱敏保留。AI 执行工具直接传 execution.signal；withRecord／mergeSignal 仍服务其他未迁移工具。
- 删除与替代：两个 SQL 方法的 create／attachAbort／complete、匿名 abort 转发、提前 dispatched 和重复控制器由公共生命周期替代；保留原运行锁并在所有出口释放。旧终态晚到正常回执不再发布成功结果，失败事件使用记录实际状态。普通 query／manual-query 不增加主记录。
- 实际测试：新增 sql-operation-lifecycle.test.mjs 及测试专属 Worker，真实 ConnectionService 和真实注册工具检查排队接管／改文／Schema／generation／取消、发送失败、单主记录、外部取消清理、历史预览、选择执行、原权限及迟到结果。test:sql-workspace 增加两方言实际公共挂载的停止行为，已通过；浏览器 fixture 为受控 bridge，不冒充实连。
- 测试调整：第一次新执行计划取消测试仍阻塞下一次探测，导致 32 秒超时；恢复本轮 fixture 的 postMessage 包装后通过。另一个新断言原期待未知回执完全没有 lastRun，实际正常失败回执保存空列／零行／原 unknown 文案；改为核对该失败摘要且不保留正常结果，没有放宽终态保护。
- 保留边界：当前旧 HTTP shared-query-run 的 initiator 和 shared-query-update 的 source 兼容行为有实际测试与既有调用，本轮不改入口权限。新的内部钩子不能由 HTTP 提供；普通人工和 Host 工具分别验证。后续身份入口收紧须独立评估，不能将旧字段宣称为已完成可信身份收口。
- S4 已执行：原运行时代码的完整 check 为 582/582、typecheck／build 通过；test:sql-workspace、test:source-module、test:ui、test:completion-ui、test:workspace-races、test:workspace-ui、test:mysql、test:oracle、test:redis、test:kafka、test:package-closure 均退出 0。日志为 artifacts/foundation/sql-lifecycle-final-*.log。Oracle 实连为 Oracle Free，不替代 19c。
- 安装增量：installed-ai.mjs 原来仅验证页面入口，现新增真正的已安装共享 SQL／EXPLAIN 读取及单记录、一次 dispatched、历史可见性和结果预览断言；MySQL 已在 run-N3UffG 中通过。该轮随后因 Oracle 固定镜像拉取超过容器启动时限失败；准备该镜像后，run-2xwTrA 又因 MySQL 固定镜像缺失／拉取超时失败。两个完整失败日志均保留，不计为四源安装通过。
- 用户调整：现有本地容器均为测试环境，后续复用 mysql8、oracle19、redis、kafka，不再新建测试容器。验收新增 DSH_TEST_EXISTING_ENV=1 选择分支，默认一次性模式保留。existing-test-environment.mjs 只检查容器状态及端口，凭据从显式测试环境变量获取。读取 Kafka JAAS 凭据的拟议补丁被自动审批拒绝，未落地；随后用户提供现有实例连接配置，仅传入本次进程，不探取认证文件、不把凭据写入源码或报告。
- 复用隔离：installed-business.mjs 在现有实例中创建本轮 DSH_WEB_<随机标识> 库／用户，关闭插件连接后仅删除该命名空间；installed-redis.mjs 使用本轮随机 Key，复用模式不执行 FLUSHDB，仅 DEL 该 Key；installed-kafka.mjs 使用本轮随机 Topic，不删除容器。host-acceptance.mjs 区分现有测试实例和一次性实例证据；Oracle 19c／Service 尚待实测，SID 仍 NOT_RUN。
- 脚本调整后检查：sql-lifecycle-reuse-final-check.log 为 581/582（同一已知 Oracle 解析器超时）；sql-lifecycle-reuse-parser.log 为 3/3；原命令 sql-lifecycle-reuse-final-check-retry.log 为 582/582、typecheck／build 通过，没有修改解析器断言。
- 现有 Redis 安装尝试：run-Tk8WIr／sql-lifecycle-existing-redis-host.log 在无密码 HELLO 时返回 NOAUTH，未开始测试读写；据此修订复用脚本显式要求 DSH_TEST_REDIS_PASSWORD（可选 DSH_TEST_REDIS_USERNAME），不再推测无认证。Oracle 服务经只读监听查询确认为 orclpdb1／ORCLCDB，现有容器均在运行，不下载更多镜像。凭据请求待用户回复。
- 现有环境修正：run-QWyrJU 的快照断言将合法用户名与同名密码误判为泄漏；改为递归拒绝 password／caPem／protectedPassword／protectedCa 字段，并在密码不同于用户名时保留原文本检查。run-ZhhAwu 的 Oracle 19c 临时用户创建因未引用密码超过 30 字符报 ORA-00972；仅缩短 fixture 随机密码，未改驱动和权限。
- 四源安装：sql-lifecycle-existing-final-host-retry2.log 退出 0，报告 artifacts/host/run-YbbCAo/report.json，Harness 0.2.0-rc.2、无版本豁免。现有 MySQL／Oracle 19c Service 验证真实共享 SELECT／EXPLAIN 的单记录、一次 dispatched、历史可见性及预览，原目录、查询、DML／DDL、冲突回滚和三种宽度通过；Redis 验证认证、命令、SCAN、Key、AI、经验和历史；Kafka 验证 PLAIN 无 TLS、Topic、PEEK、AI、经验和历史。没有真实模型调用。
- 清理证据：artifacts/foundation/sql-lifecycle-existing-cleanup.json 为 PASS，四个容器 ID 未变且仍运行，DSH_WEB_ 测试库／用户、dsh:web:随机标识:fixture Key、dsh_web_ Topic 均为零。实际版本 MySQL 8.4.11、Oracle 19.3.0.0.0、Redis 8.10.2；不将本地可变镜像标签当固定版本认证范围。
- 最终代码检查：sql-lifecycle-existing-final-check.log 再次出现已知 Oracle 解析器 5000ms 超时，581/582；当前 availableParallelism=20，改用 4 个测试进程诊断，全部 582/582 通过，再按未修改的 npm run check 重跑亦 582/582、typecheck／build 通过。日志 sql-lifecycle-existing-tests-concurrency4.log、sql-lifecycle-existing-final-check-retry.log，未改解析器、测试断言、超时或 npm 命令定义。该基线不稳定项保留，不能只展示重跑成功而删除失败记录。
- 最终包闭包：sql-lifecycle-existing-final-package-closure.log 退出 0；发布包 64 文件、626687 字节，相对导入完整。安装包在 README 本次说明更新前生成，仅文档不同，可执行源码未改。浏览器、实连矩阵及后续安装脚本调整的时间顺序在机器报告中区分，不以旧安装报告代替本轮结果。
- 最终源码：419 文件（src/test/scripts/package.json/package-lock.json），逐路径 SHA-256 清单摘要 f1852fb9c13f517f81ca0ed3c5d91d6581356d9f391059e516a417697cc78f7e。HEAD 0dc3970d8a451fa9c568304ec74741094f3f47e9，工作区仍有本轮和已有未提交修改。清单 sql-lifecycle-source-manifest.json 与最终 PASS 报告 sql-lifecycle-report.json 位于 artifacts/foundation。
- 完成边界：Oracle 19c Service 已验证，Oracle SID、真实 Desktop GUI、真实模型、业务集群及 Redis Cluster／Sentinel 仍 NOT_RUN。SQL 普通查询、目录工具和维护外围仍为兼容路径，本轮不宣称全部 Host SQL 已统一。

## 2026-10-01 MySQL／Oracle 标准工作台接入

- 状态：本轮完成；四源标准工作台、同源码回归和无豁免安装通过。保留本轮开始前 Redis 生命周期等已有修改，没有提交或重置。
- S0：typecheck 退出 0、npm test 548/548。原 SQL 布局验收首次因已有 artifacts 写权限失败，经批准在隔离产物运行后 PASS；不是 SQL 功能失败。构建前 style-css.ts 没有已有差异。
- S1：新增公共 workspace-navigation.ts；SourceWorkspace 使用统一 WorkspaceFrame；Redis／模拟源／读取工作台浏览器回归通过，无 pageerror。
- S2：新增 sql/workspace-bindings.tsx；SQL 对象、SchemaCache、树动作、草稿保存和状态投影进入共享适配；SqlWorkspaceTab、ObjectWorkspace、维护及批量算法保持原调用。隔离双源探针通过后才切换生产模块。
- S3：AiQueryFrame 支持受控历史，SQL 使用既有 queryBus 单订阅；useSqlKnowledge 保留草稿会话及相似分析，SqlTemplateLibrary 委托公共 KnowledgeLibrary。
- S4：MySQL／Oracle 模块均为 standard，客户端类型和注册校验移除 legacy-sql；删除 ActiveConnectionPane，旧源文件测试迁到新适配／公共外框，保留原行为断言。
- 新验收：scripts/sql-workspace-ui-acceptance.mjs／test:sql-workspace，真实生产客户端模块与 StandardSourceMount，受控 bridge（不冒充实连）。覆盖动态页签、恢复、关闭缓存、批量失败／重试／继续、对象去重、AI 控制权、经验会话／变体、单订阅及深浅色／三种宽度。
- 兼容入口：SqlTemplateLibrary、SharedQuery／shared-query-*、SQL 维护确认和 Host legacy-adapter 保留；shared-query-confirm 不恢复。连接和经验物理格式未迁移。
- 偏差：当前 SQL 查询页的「运行」按钮已经执行全部步骤，没有独立「运行全部」按钮；验收按实际按钮验证批量行为。经验列表按钮包含摘要，采用明确列表区域定位，未使用强制点击。
- 最终结果和源码摘要见下方；旧 Redis 报告不代替本轮证据。
- 额外边界修复：审查原 SQL 客户端时发现经验异步回写使用旧 selectedId 闭包、共编结果使用返回时修订。增加客户端身份／草稿版本／执行目标检查；控制请求期间改文不派发，迟到 AI 结果不覆盖新内容，旧经验试运行失败不污染新草稿。未改 SQL Worker、授权、批量或维护算法。对应延迟响应已加入实际 SQL 挂载脚本。
- 第一轮全量回归已通过，但随后补上上述客户端边界，第一轮报告记为中间证据；下述最终验收已经对修复后的统一源码重新执行。
- S5 最终代码验收：`npm run check` 退出 0，548/548、类型检查与构建通过；`test:sql-workspace`、`test:source-module`、`test:ui`、`test:completion-ui`、`test:workspace-races`、`test:workspace-ui`、`test:mysql`、`test:oracle`、`test:redis`、`test:kafka`、`test:package-closure` 均退出 0。日志为 `artifacts/foundation/sql-workspace-final-*.log`。SQL 专项真实挂载生产客户端模块和公共工作台，使用受控 bridge；该专项不冒充数据库实连。
- 已知负载失败：补完客户端边界后的第一次完整测试为 547/548，Oracle 有界解析器 5 秒负载敏感超时；原文件单独复跑 3/3 通过，随后原始 `npm run check` 全部通过。没有删除测试、放宽断言或修改被测超时。一次串行验收申请曾因自动审批额度不足未执行；用户继续后批准并完成。
- 实连：MySQL 8.4.5、Oracle Free 23、Redis 7.4 普通／TLS、Kafka 普通及 TLS／PLAIN（有无 TLS）／SCRAM／ACL 场景均通过；仅操作本轮拥有的一次性 fixture。Kafka 故障注入的错误日志和既有 TimeoutNegativeWarning 单独保留，没有把预期负例视为正常连接成功。Redis Cluster／Sentinel 不在该结果内。
- 最终安装：无 `DSH_TEST_ALLOW_VERSION`，使用 `D:\install\DeepSeek Harness`，DATABASES／REDIS／KAFKA 均为 1；`test:host` 退出 0，平台 `0.2.0-rc.2`。本轮报告 `artifacts/host/run-FseELm/report.json`，日志 `artifacts/foundation/sql-workspace-final-test-host.log`。安装包内四源页面、SQL 受控 DML／DDL、Redis／Kafka 文档和经验操作通过，无 pageerror。这是已安装 ASAR CLI＋一次性 Web，未重启用户 Desktop。
- 最终源码：415 文件（src/test/scripts/package.json/package-lock.json），路径排序的逐文件 SHA-256 清单摘要 `a02859a4a3423896a2d7a66b3cac937e8ba5d0258464b288f784a18f4c3c6c24`；HEAD `0dc3970d8a451fa9c568304ec74741094f3f47e9`。清单与机器可读报告为 `artifacts/foundation/sql-workspace-source-manifest.json`、`sql-workspace-report.json`。发布包 64 文件，运行时相对导入闭包通过；测试源不进入产物。
- 冗余删除：ActiveConnectionPane 整页入口及旧客户端 legacy-sql 分支由 SQL bindings＋公共 WorkspaceFrame 替代；旧 useWorkspaceTabState 由 workspace-navigation 替代；SQL 经验重复列表／元信息布局由 useSqlKnowledge＋KnowledgeLibrary 替代。保留 SqlTemplateLibrary 薄导出、SQL 内容组件、SharedQuery 协议、原草稿格式及 Host legacy-adapter。
- 交付边界：四种数据源的客户端工作台已经统一。SQL 专属执行、文档协议和部分经验逻辑通过适配复用；Host SQL 执行外围仍是独立后续工作。真实 Desktop GUI、真实模型调用、Oracle 19c／SID、业务集群、Redis Cluster／Sentinel 均为 NOT_RUN。

## 2026-10-01 Redis AI 结构化读取生命周期收口

- 状态：本轮完成，代码、实连、浏览器及四源无豁免安装验收均通过。仅修改本插件并保留已有修改，未提交／重置；上轮 528 项结果不代替本轮基线。
- S0：本轮 typecheck 与 npm test 均退出 0，528/528；日志 `artifacts/foundation/redis-read-baseline-typecheck.log`、`redis-read-baseline-tests.log`。既有工具标题 SCAN／READ、READ 的 SHA-256 Key 摘要、tool 类型及 callId/rootCallId 已核对。
- 实际方法：新增 `src/host/data-sources/redis/read-operation.ts` 的 prepareRedisReadOperation，限定 redis_keys／redis_value，Key 请求强制 read，复用现有 DB／Cluster 校验；新增 ConnectionService.executeRedisReadTool，捕获真实文档／目标并使用 runOperation，透传 Host 内部 onDispatched 到已有结构化派发。无需新 HTTP action、Worker 字段或存储格式。
- 公共外围：operation-runtime.ts 增加可选 summarizeFailure；读取的取消和未知仍用产品文案；失败摘要改为数据源原文。其他调用未提供该选项时保持原行为。读取错误／ACL／断线为 failed，外部取消为 cancelled，已有 unknown／cancelled 终态保持；取消不关闭共享浏览连接。
- 删除与替代：redis-ai-tools.ts 移除两个读取工具自有的记录创建／结束、AbortController、匿名监听器、提前的 running／dispatched 和重复 action 参数，替代为 executeRedisReadTool → runOperation → redisRequest → #dispatch。注册函数原签名保留，兼容接收 ExecutionStore 参数；工具名称、参数、原数据字段和 execution ID 保持，内部 executionStatus 不添加到返回值。
- 派发复核：真实 ConnectionService＋可控 Worker 验证两工具排队期间接管、改文、切 DB、generation 或取消不派发，且各一条主记录；三个环境读取权限、发送失败清理、安全持久摘要及不改文档／不发共编结果事件覆盖。
- 测试偏差：第一轮把切库自身的文档事件算进读取事件，修正为只观察读取阶段；后续发现原 fixture 固定阻塞 300ms 不保证慢重连发生在排队阶段，改为显式释放 BLOCK 回复。不放宽超时或删除断言，原命令排队用例同样使用受控释放。生产 Worker 协议没有变化。
- 针对性验证：42/42，日志 `redis-read-targeted.log`；首次完整检查 548/548、typecheck、build 退出 0，日志 `redis-read-check.log`。受控服务浏览器读取历史、接管／交还、切库迟到回复、历史取消及编辑器内容保留通过，日志 `redis-read-ui-probe.log`。
- 实连：Redis 7.4 普通／TLS 均通过。一次性透明 TCP 中继延迟真实回复，验证取消一个读取后其他读取／浏览可用、读取连接中断失败；原命令、五种 Key、TTL、编辑、ACL 与补全通过。最终脚本另增加占满配额后的读取取消及无派发断言。
- 最终代码验收：npm run check 退出 0（548/548、typecheck、build）；test:source-module、test:redis、test:kafka、test:package-closure、test:completion-ui、test:workspace-races、test:workspace-ui 均退出 0。日志 `artifacts/foundation/redis-read-final-*.log`。工作台浏览器由原验收依次调用模拟源与新增读取验收，无 pageerror；Kafka 认证／读取／ACL 回归通过，已有 KafkaJS TimeoutNegativeWarning 未作为本轮修复范围。
- 源码摘要：412 文件（src/test/scripts/package.json/package-lock.json），路径排序的逐文件 SHA-256 清单摘要 `dae5ff57d73ab0000aad4669541f1d85976746b8c6294b6b86388c2ed3e80de8`；HEAD `0dc3970d8a451fa9c568304ec74741094f3f47e9`。
- 明确行为：Key 补全继续不写执行记录；成功、失败、提前取消及旧 generation 补全均不创建记录，以记录 ID 集合不变验证。总览刷新不增加记录；Key 写操作、SQL 批量／维护／事务仍保留原路径。
- 最终安装：移除 DSH_TEST_ALLOW_VERSION，DSH_DESKTOP_APP 指向 `D:\install\DeepSeek Harness`，DATABASES／REDIS／KAFKA 均为 1；npm run test:host 退出 0，平台 `0.2.0-rc.2`。报告 `G:\ai\DSH\dsh-database\artifacts\host\run-uWHQlw` 及 `artifacts/host/latest.json`；日志 `artifacts/foundation/redis-read-final-test-host.log`。MySQL 8.4.5／Oracle Free 23 与四源工作台通过，无浏览器 pageerror；这是已安装 ASAR CLI＋一次性 Web。
- 机器可读清单：`artifacts/foundation/redis-read-report.json`。
- 环境边界：真实 Desktop GUI、真实模型工具调用、Oracle 19c／SID、业务集群、Redis Cluster／Sentinel 继续 NOT_RUN。受控 Worker 浏览器和实际 Redis 网络测试分别报告。

## 2026-10-01 Redis 命令统一执行外围

- 状态：本轮完成，代码、专项、实连与无豁免安装验收通过。仅修改本插件；保留其他开发的 README、打包元信息和既有脚本修改，未提交或重置。
- S0：新基线 typecheck、npm test 均退出 0（519/519），日志 `artifacts/foundation/redis-unify-baseline-*.log`。HEAD 为 `0dc3970d8a451fa9c568304ec74741094f3f47e9`；既有 SQL／Redis／Kafka 的状态由当前代码重新核对，没有复用旧验收作为本轮结果。
- S1：`src/host/operation-runtime.ts` 增加 Host 内部派发标记、中断分类、可信记录类型、单次完成通知与实际终态返回；`execution-store.ts` 增加匹配控制器的释放方法。`connection-service.ts` 在 postMessage 成功后标记派发；同步发送失败清理监听器。已有终态保持，外部取消监听器／执行控制器释放。Kafka 未提供新分类时沿用原行为。
- S2：新增 `src/host/data-sources/redis/execution.ts`，承担 DB／Cluster 目标规范化、单条解析、Host 黑名单及环境授权、安全摘要、实时限量投影与中断判断；Redis module/runtime 启用 standard-text。命令台和经验试运行调用 source-execute；人工 AI 文档及 redis_execute 经 executeText；旧 redis-command 委托同一入口，省略 DB 时仍使用连接默认库。
- 派发复核：配额等待结束后核对真实连接、generation、控制权、revision、文本及规范化目标。真实 ConnectionService＋可控 Worker fixture 验证接管、修改文本、切库和重连后不派发。四个入口各一条主记录，人工 query、AI tool，保留 callId/rootCallId；共编结果事件只发布一次并使用实际终态。
- 删除与替代：移除 runExecutionDocument 的 Redis 记录／取消／结束代码和 redis_execute 的独立记录生命周期，替代为 executeText → runOperation；移除 recordUserRedisCommand、redisCommandRecordsHistory、redisAiDispatchAllowed 及 record:false 绕过。`redis-request.ts` 只保留 DB 校验与结构化请求适配；公共服务不再解析 Redis 命令或投影其载荷。命令前置快速校验保留，最终授权由模块统一执行。
- 客户端：`src/client/redis/workspace.tsx` 使用 executeText；`result.tsx` 展示 unknown／cancelled／无载荷失败，防止结果事件没有正文时继续显示旧成功。SCAN、Key 缓存、补全、浏览、编辑及 redis_keys／redis_value 保留专属路径，SQL Worker、批量、维护及事务算法未迁移。
- S3 最终代码：npm run check 退出 0（528/528、typecheck、build）。test:source-module、test:redis、test:kafka、test:package-closure、test:completion-ui、test:workspace-races、test:workspace-ui 均退出 0；日志 `artifacts/foundation/redis-unify-check-final.log` 和 `redis-unify-final-test-*.log`。最后一次运行基于同一份运行时代码。
- 实连证据：本轮拥有的 Redis 7.4 fixture 普通与 TLS 均 PASS；验证派发后取消和 CLIENT KILL 本轮命令连接为 unknown、仅一条记录、没有重放。fixture TIMEOUT 回复仅证明分类，不能宣称完整等待 Host deadline 的实连证据。Kafka 原读取、TLS／CA、PLAIN 有无 TLS、两种 SCRAM、ACL 拒绝矩阵通过；保留现有 KafkaJS TimeoutNegativeWarning，未放宽断言。Redis 镜像 `redis@sha256:858f009f9709ce576febc734aa78b8f6d624b82571f9ddb6bda4377c833b3499`。
- 浏览器证据：公共源认证闭环、三个编辑器、接管／交还、连接和上下文竞态、草稿迟到错误、补全键鼠／IME／失焦／快捷键通过。模拟与受控延迟测试不代替真实模型调用。
- 最终源码摘要：410 文件（src/test/scripts/package.json/package-lock.json），按路径排序的逐文件 SHA-256 清单摘要 `f07125b75d95cd30db6cf06f962df77cc4b00aa1d1d3adcf158ac6984f2eba3c`。文档与旧报告分开保留。
- 最终安装：清除 DSH_TEST_ALLOW_VERSION，设置 DSH_DESKTOP_APP 为 `D:\install\DeepSeek Harness`，开启 DATABASES／REDIS／KAFKA；test:host 退出 0，平台 `0.2.0-rc.2`。本轮报告 `artifacts/host/run-1VdUuV` 和 `artifacts/host/latest.json`，日志 `artifacts/foundation/redis-unify-final-test-host.log`；MySQL 8.4.5／Oracle Free 23 实连与四类工作台通过，无 pageerror。这是 ASAR CLI＋一次性 Web，非真实 Desktop／模型。
- 机器可读清单：`artifacts/foundation/redis-unify-report.json`。
- NOT_RUN：真实 Desktop GUI、真实模型工具调用、Oracle 19c／SID、业务集群、Redis Cluster／Sentinel。SQL 仍 legacy-sql／legacy-adapter；Redis 仅命令外围已统一，不表述为所有 Redis 操作已迁移。

## 2026-10-01 稳定底座与接入规范

- 状态：本轮完成。文档、模拟源、Redis TLS 和最终安装闭环通过。本轮不修改 src，不迁移 SQL／Redis 执行算法、不改变连接或经验存储。
- 文档：删除架构说明重复章节、更新 Kafka 当前状态和四源模式表；新增 `docs/data-source-onboarding.md`，列明封闭类型、五组静态绑定、底层 Provider 边界、真实接口和调用链。索引、AI 上下文指南、README 中英文与历史计划入口同步；旧验收不改写。
- 实际脚本：`package.json` 的独立 `test:source-module`；`source-module-ui-acceptance.mjs` 新增经验试运行与单一记录断言；`package-closure.mjs` 检查模拟源、测试 Worker 与标识不进产物或发布文件。契约单元测试名称明确其证据范围，不代替浏览器闭环。
- Redis：`redis-fixture-acceptance.mjs` 使用随机映射端口、run ID、独立临时 OpenSSL 配置、CA／正确和主机名不匹配证书、固定版本镜像与运行 digest；容器清理前核对 ID／名称／标签，临时目录核对范围。`redis-acceptance.mjs` 接受显式端口／证书路径，验证正常 TLS、缺失／错误 CA、错误主机名、保存恢复、快照／记录脱敏及失败编辑保留原连接。普通／TLS 分别写阶段结果，总失败不能标为通过。
- 首次 TLS 失败原因：本机 OpenSSL 默认配置不存在，发生于证书生成、未连接数据库。改为 fixture 自有配置后实连通过，未放宽证书校验。上次自动审批因额度不足中断，本轮继续后验证成功。
- 当前验证：`npm run check` 退出 0（519/519、类型检查、构建）；`test:source-module`、`test:redis`、`test:package-closure`、`test:completion-ui`、`test:workspace-races`、`test:workspace-ui` 均退出 0。日志位于 `artifacts/foundation/stability-*.log`。Redis 普通与 TLS 均 PASS，镜像 digest 为 `redis@sha256:858f009f9709ce576febc734aa78b8f6d624b82571f9ddb6bda4377c833b3499`。
- 安装脚本偏差：其他开发新增 `LICENSE`、`README.zh.md`，旧发布文件精确清单拒绝它们；确认 package.json 声明后仅补允许这两个文档文件。没有放开未知文件或测试 fixture。
- 代码基准：HEAD `0dc3970d8a451fa9c568304ec74741094f3f47e9`；当前未提交源码 409 文件（src/test/scripts/package.json/package-lock.json）摘要 `d1c71eebcc2798768f2c6dfbeb837fa2c38585e65e115481493e97cabb830bf9`。最后修正了脚本报告字段和合法打包文档清单，脚本语法检查通过。
- 最终无豁免安装：移除 DSH_TEST_ALLOW_VERSION，DSH_DESKTOP_APP 指向 `D:\install\DeepSeek Harness`，DATABASES／REDIS／KAFKA 开关均为 1；`npm run test:host` 退出 0。平台版本 `0.2.0-rc.2`，四类工作台、认证、SQL 维护、Redis 与 Kafka 的 AI 文档／经验操作全部通过，浏览器无 pageerror。报告 `artifacts/host/latest.json`；日志 `artifacts/foundation/stability-test-host.log`。这属于已安装 ASAR CLI＋一次性 Web，不代替真实 Desktop 或真实模型验收。
- NOT_RUN：真实 Desktop GUI、真实模型调用、Oracle 19c／SID、业务集群、Redis Cluster／Sentinel。之前 Redis TLS NOT_RUN 属于历史结果，本轮已补实连证据。
- 机器可读清单：`artifacts/foundation/stability-report.json`，包含命令、退出码、日志、源码摘要、Redis digest 和安装运行目录。

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
## 2026-10-02 SQL Host standard-text 接入（完成）

- S0：HEAD b31a2cf7f7bca068537e5d30bc8b0ec2300ef807；保留现有未提交修改。typecheck 与 629/629 测试通过，日志 artifacts/sql-standard-baseline-typecheck.log、artifacts/sql-standard-baseline-test.log，差异清单 artifacts/sql-standard-status-before.txt。
- S1：扩展 Host 文本契约以支持异步准备／授权、Host 固定入口及 none/owned/external 记录策略。新增 text-execution.ts 作为不创建记录的协调与传输层；SQL 生产入口在阶段验证前保持原路径。
- S1 验证：首次类型检查暴露旧 executeText 未等待 Promise，修正 await 后 typecheck 与 24 项定向测试通过；未修改运行时业务规则。
- S2：新增 data-sources/sql-execution.ts，query/manual-query/source-execute 接入模块；从 request 抽取 #queueAndDispatch，共用原配额与 #dispatch。83 项定向回归通过（含 Redis/Kafka）。新增测试初跑的 Oracle 大写对象名、Host conversationId 注入和原配额错误文案断言均按现有实际行为修正，产品行为没有为测试调整。
- S3：共编授权与解释请求改为模块能力，仍由原 runOperation 持有唯一记录。增加 Host-only afterAnalysis 钩子，因原代码必须在分析后、权限拒绝前复核快照及注解记录；这是保留原先后顺序的接口补足。授权期间接管／改文／Schema／代次／取消和原队列竞态通过；MySQL/Oracle 三环境权限单元测试及原 SQL 执行器逐条授权测试通过。
- S4：两库执行声明改为 standard-text；删除 legacy-adapter 类型、静态例外和迁移期间临时 text 绑定。Redis/Kafka/测试模拟源显式声明 owned/manual/host，原返回和生命周期保持。
- 新位置：text-execution.ts（异步协调与无记录传输）、data-sources/sql-execution.ts（方言绑定、入口策略与原授权委托）、ConnectionService.#queueAndDispatch（原 request 的配额与派发）。删除公共服务中直接调用 authorizeStatement 及组装共编授权证明的重复实现；保留 SQL 文档协调、元信息及结构化业务。
- S5 PASS：npm run check 退出 0，653/653，typecheck/build 通过，日志 artifacts/sql-standard-final-check.log；串行 test:sql-workspace、test:source-module、test:workspace-races、test:workspace-ui、test:completion-ui、test:package-closure 均退出 0，日志 artifacts/sql-standard-final-test-*.log。浏览器包含实际标准挂载、两方言批量／重试／停止／维护外围、AI／经验竞态、深浅色、420/768/1200px、鼠标／键盘／IME；受控桥接与实连分别报告。
- 四源安装 PASS：artifacts/host/run-Dn97aN/report.json，Harness 0.2.0-rc.2 的 ASAR Node runtime 与一次性 Web profile，无 allow-version，DSH_TEST_EXISTING_ENV=1。两库三环境 query/manual/source-execute 权限、零普通记录、部分写入、共编单记录实连矩阵通过；两库维护、共编与解释及 Redis/Kafka 安装回归通过；无浏览器 pageerror。日志 artifacts/sql-standard-final-host.log。
- 源码冻结：430 个 src/test/scripts/包声明文件，artifacts/sql-standard-source-final.json 的 SHA-256 为 d1ab359298b89c39060dbb09844fad7d9bfd4e17f6bd314e8d582f5f73a6707d；安装后清单 artifacts/sql-standard-source-after-install.json 摘要一致。说明文档不在源码摘要内；文档验收说明在运行结果形成后补写。
- 清理 PASS：artifacts/sql-standard-cleanup.json，现有四容器 ID 未变且运行中；本轮 DSH_WEB 数据库/Oracle 用户、Redis fixture Key、Kafka fixture Topic 残留均 0。实测 MySQL 8.4.11、Oracle 19.0.0.0.0 Service、Redis 8.10.2。没有下载镜像或重建容器；只读 Kafka 核对出现既有 TimeoutNegativeWarning，保留日志，不影响通过结果。
- 交付：artifacts/sql-standard-report.json 汇总命令、退出码、源码摘要及报告。真实 Desktop GUI、真实模型调用／安装工具实时 callId、Oracle SID、业务集群、Redis Cluster/Sentinel 为 NOT_RUN；当前容器之外的 TLS/SASL 矩阵未重跑。主要 SQL 文本标准接入已完成，SQL Worker/SharedQuery 协调/目录/浏览/维护及旧协议保留自身契约。
- 兼容约束：旧 action、结果字段、SharedQuery、SQL/Redis/Kafka 权限、队列、终态及持久化不变；source-execute 的 SQL 新增支持返回原 Result、零记录。
- 偏差处理：旧请求默认值、语句顺序与记录元信息逐入口保留。授权不能通过成功响应 fixture 验证，需原执行器测试与已有容器实连。SID、真实 Desktop GUI、真实模型和业务环境独立报告。


## 2026-10-03：剩余闭环与适配层收敛

SQL 工作台统一文档协调与历史编辑入口；Kafka 导入 schema 及来源投影贯通；SQL 草稿缓存退出公共上下文，测试注册工厂退出生产模块；逐项回执、未知写入核验和存储降级／重试入口已完成。受控 UI 与隔离 MySQL／Oracle Free 回包故障验收已运行；本轮 Oracle 19c／SID、安装环境和真实模型仍未验收。细节、证据和矩阵见 [实施记录](plans/remaining-closure-implementation.md)，不可用旧阶段结果代替本轮验收。

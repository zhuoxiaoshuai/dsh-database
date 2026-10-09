# Kafka 只读完善与代码评审（2026-10-02）

## 功能和边界

Kafka 继续使用 `StandardSourceMount → SourceWorkspace`，复用查询、AI 文档、执行历史和经验库。本轮未修改公共工作台、SQL 算法、权限、Worker 消息结构或持久化格式。

| 操作文本 | 功能 | AI 工具 |
|---|---|---|
| `TOPICS [SEARCH "片段"] [CURSOR 100]` | Topic 包含匹配及分页 | kafka_topics |
| `DESCRIBE "topic"` | 分区、副本、水位 | kafka_describe |
| `PEEK "topic" PARTITION 0 FROM LATEST LIMIT 20` | 单分区有界消息预览 | kafka_peek |
| `GROUPS [SEARCH "片段"] [CURSOR 100]` | 消费组包含匹配及分页 | kafka_groups |
| `GROUP "group"` | 状态、成员、分配 | kafka_group |
| `GROUP "group" TOPICS [CURSOR 100]` | 关联 Topic 分页 | kafka_group_topics |
| `GROUP "group" TOPIC "topic"` | 已提交位置、末尾位置、Lag | kafka_group_topic |

`kafka_status` 保留状态查询；没有任意管理命令工具。SEARCH 必须在 CURSOR 之前，每页最多 100 项，列表变化可能重复或遗漏。名称保持原样并使用 JSON 双引号插入；查询、AI、经验三个编辑器共享本连接/代次已读名称，缓存每类 5,000 项、总计 1 MiB，不发在线补全请求。

消息保持原文、null、空字节、Base64、长度及截断标记。只有完整且合法 JSON 才能切换格式化视图。复制和导出使用当前有限预览，不后台补读；持久历史不保存消息正文、Key、Headers。

## 问题与修复证据

| 问题 | 影响与修复位置 | 验证 |
|---|---|---|
| 文本列表没有下一页表达 | command.mjs 增加固定顺序 SEARCH/CURSOR；driver.mjs、explorer.ts 使用同一 kafkaNamePage；结果只生成下一页草稿 | kafka-command、result、现有容器跨 100 项分页、安装脚本 |
| 消费组没有 AI 读取工具 | ai-tools.ts 新增四个结构化工具，经同一解析、文档发布、标准执行和队列复核 | kafka-ai、真实 ConnectionService 的 kafka-lifecycle、容器 Lag |
| AI 与人工文档结果发布分离 | execution.ts 提供 projectLiveResult，删除工具的手工完成事件 | 单一主记录、一次 dispatched/完成事件、callId/rootCallId，三个环境工具测试 |
| 元数据取消不能约束后续动作 | operation-scope.mjs 的 withKafkaReadScope 统一 30 秒预算，结束后不再启动下一 Admin 调用 | 晚到元数据、截止时间、实际取消后 Admin 可用 |
| 总览子节点缺刷新/分类作用域 | overview.tsx 复用 request-scope，刷新/切类/代次/卸载取消旧详情和子节点，旧 finally 不回写 | 实际 StandardSourceMount 浏览器延迟子节点测试 |
| 元数据结果无全包大小限制 | result.mjs 按最终 JSON UTF-8 大小限量，列表保留可继续的位置；成员/分区详情声明截断 | 大元数据、分页、包大小单元测试 |
| 空洞/新消息可能影响 PEEK | 忽略 seek 前、非目标分区、重复及范围外数据；收到范围外有序记录可证明越过上界但不纳入结果 | kafka-worker 与实际中止事务读取 |
| 错误总报告 ready | result.mjs 区分连接故障、资源回收、ACL/输入错误；单对象权限失败不关闭 Admin | health 分类测试；实际 ACL 拒绝待受限账号 |
| Lag 把网络故障当作未知指标 | driver.mjs 对连接/认证/超时错误重新抛出；仅单项权限/指标不可用保留有说明的部分结果 | kafka-group-health-repro.log 保存修复前 Missing expected rejection；kafka-group.test 的 ACL 与连接故障对照回归 |
| 长凭据先截断后脱敏 | Worker 返回 Broker 原文，不再替换密码/CA 或截断错误文本；连接失败仍清理 Admin | Worker 错误原文；代码出口评审 |
| 补全按空格估算参数位置 | completion.ts 使用容忍 JSON 引号的词法位置，name-cache.ts 仅缓存已读名称 | 参数位置、转义、光标中间替换；六组宽度主题、键盘/鼠标/组合态浏览器 |
| JSON 格式化改变数值/重复字段 | message-view.ts 复用公共 formatValue 按原始 token 缩进，不重新序列化解析值；原文和导出始终保留 | kafka-json-precision-repro.log 保存修复前失败；大整数、重复字段、截断文本、二进制回归 |
| Oracle 安装矩阵的新表时序 | 原始驱动独立复现立即只读事务 ORA-01466、稍后成功；installed-business.mjs 仅在准备测试表时等待其可读，最多 5 秒且只处理 1466 | artifacts/kafka-oracle-ddl-probe.json；首次失败安装报告保留 run-my4Co1，修正后 run-f0WrJM 四源 PASS，产品查询未增加重试 |

## 删除和替代调用链

- 删除 Kafka AI 工具手工发布的执行完成事件：由现有公共服务调用模块投影一次发布。
- 删除未使用的 kafkaHistorySummary：主记录继续使用 execution.ts 的安全摘要。
- 删除已无调用的 pageByCursor：列表统一使用 Kafka 专属 kafkaNamePage。
- 替换旧空格补全拆词和缺作用域的子节点回写；未删除组总览、Lag 或原消息编码。
- 不新增公共分页协议、快照服务、全局状态或平行 Kafka 页面。Kafka 模块只使用现有 editorContext 和结果扩展口。

## 保守完成判断

仍使用公开 eachMessage API。KafkaJS 对纯过滤/控制批次可能不调用 eachMessage，换 eachBatch 也不能据此证明范围遍历完毕；本轮没有调用私有 API。无证明时返回 deadline/未完成；初始范围为空可以完成。实际中止事务测试检查没有暴露中止消息，并按实际 low/high 判断完成或未完成。

PEEK 保留单 Topic/分区、固定初始范围、最多 200 条/1 MiB、30 秒预算、1 秒总清理预算、autoCommit=false 和不重启。无法确定 Consumer 清理完成时由 Worker 回收使 generation 失效；不会提交 offset、创建 Topic、重放 PEEK。

## 验收与环境

最终命令、源码清单、日志和安装结果见 `artifacts/kafka-readonly-report.json` 及进度文档。专项 UI 是实际公共组件加受控桥接；实连和已安装 Web 分别记录，互不替代。

使用既有 `kafka` 的 PLAIN 无 TLS；只创建和清理本轮唯一命名 Topic/组，检查业务测试组位置不变、产品临时组没有提交位置。不下载镜像、不重建数据库容器。

最终 check 的 683 项、六组 Kafka UI、公共浏览器回归、发布包闭包、7 项现有 Kafka 实连和四源无豁免安装均通过。安装报告 `artifacts/host/run-DSun4R/report.json`；源码清单 441 项，SHA-256 `48ab7800a60551ee44197f93240cea970b28eebb1f365004b64f176c0e046d71`，安装后完全一致。四容器 ID 保持不变，本轮对象残留为零。KafkaJS/Node 24 的既有 TimeoutNegativeWarning 仍可见，未用私有 API 或改库消除它。

真实 Desktop GUI、真实模型、业务集群、当前容器之外的 TLS/SASL 组合、Topic/Group ACL 拒绝、真实压缩调度分别为 NOT_RUN。ACL 实测需用户提供有确定允许/拒绝 Topic 和 dsh-peek-* Group 权限的测试账号；其他认证需相应可达 listener 和 CA。不会为验收修改现有 listener、ACL 或提高账号权限。

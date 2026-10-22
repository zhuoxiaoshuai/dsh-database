# Kafka 关联查看与消费排查实施记录

日期：2026-10-16。依据当前工作区实施，保留原有未提交改动；没有修改业务消费组位点。

## 页面与操作

- Topics：名称、分区数、副本因子和健康状态；详情包括分区、消息、关联消费组。
- Topic 关联只展示组名及当前分配／历史提交依据。点击直接定位 Group / 来源 Topic 的分区消费，支持返回；查询及 AI 草稿保持原样。
- Consumer Groups：State、Members，以及按页手动加载的 Topics、Total Lag、异常／未提交分区数。
- Group 详情：Topic 汇总、分区消费、成员。分区展示 Earliest、Committed、End、Lag、Host、位点状态、Consumer ID、Client ID；Host 位于 Lag 旁，长表在内部滚动。成员直接展示实例标识和分配分区数。
- 详情可独立刷新并显示采集时间；刷新失败保留旧结果。两个入口分别保存浏览状态，重连清空旧代次状态。

## 查询与数据边界

- 新增只读 `kafka-topic-groups` Worker action、`TOPIC_GROUPS "topic" [CURSOR n]` 命令和 `kafka_topic_groups` AI 工具；复用 Explorer、标准文本执行及单一执行记录链路。
- 关联为当前 Assignment 与历史有效提交的并集；分配解码错误、权限不足、超时和截断均保持未知／不完整状态。任一侧不可读时仍保留另一侧已确认的关联。
- 反向查询最多检查 100 个候选组／页、4 个并发候选、30 秒总期限。游标按候选扫描推进，超时不跳过未完成候选；空匹配页也可能还有下一页。动态列表可能重复或遗漏，完整重查须刷新第一页。
- 列表仅获取当前页元数据和成员状态，不扫描 Topic 的全部关联。消费汇总按最近加载的一页手动触发；Group 的 Topic 汇总按需读取。
- 完整成功结果按 Worker 隔离缓存 15 秒，最多 100 项、合计 8 MiB。手动刷新绕过缓存；失败、不完整或截断结果不进入缓存；重连使用新的缓存。
- 位点区分正常、未提交、早于 Earliest、超过 End、不可读。异常位点不产生正常 Lag，也不提供“从积压起点”读取动作。Offset 权限失败仍展示已知分配、Host 和 End。
- Offset 与 Lag 使用字符串／BigInt；不相加 Offset。总 Lag 仅在所有关联分区完整且有效时显示，否则展示未知总值、已知小计和覆盖范围。
- 部分 Topic Offset 不可读时，仍展示可获取的 Leader、副本和 ISR。连接、认证、超时不会降级成健康的空结果。
- Offset 差值不是精确消息条数，在线和零 Lag 均不证明下游业务完成。各次 Admin 查询不是原子快照。

## 验证证据

| 验证 | 结果 | 本地证据 |
|---|---|---|
| `npm run check` | PASS，958/958；类型检查和构建通过 | `artifacts/kafka-implementation/check.log` |
| `test:kafka-tree` | PASS，14 个场景，无页面错误 | `artifacts/kafka-implementation/tree.log` |
| `test:kafka-readonly-ui` | PASS，7 组回归，含窄屏／主题／关联跳转／草稿保留 | `artifacts/kafka-readonly-ui/report.json` |
| `test:kafka` | PASS，隔离 Kafka、Host、TLS、PLAIN、SCRAM、ACL 拒绝及恢复 | `artifacts/kafka-implementation/live.log` |
| 最终关联查询实连探针 | PASS，未提交新组、历史组、Host、Lag、退出后刷新和执行记录 | `artifacts/kafka-implementation/inspection-live-final.log` |
| `test:package-closure` | PASS，80 个运行文件，包含新 Worker 模块及相对依赖 | `artifacts/kafka-implementation/package.log` |

受控测试覆盖了空匹配分页、4 并发上限、超时续查、取消、部分 ACL、Assignment 解码失败、越界位点、大整数、缓存过期／隔离／容量及截断。受控 UI 还验证了消息及 Headers、汇总、刷新失败保留详情和长表内部滚动。

真实探针只使用本轮带标签的一次性 Broker 和独立组；建立的历史提交基线在读取前后保持一致，容器由 fixture 的 finally 清理。真实单节点 Broker 的 Host 验证不等同于真实双机房切换；两个不同 Host 的展示由受控 UI 覆盖。

SCRAM 验收脚本原先把 `restoreRemembered` 误当成同步就绪；本轮按其现有异步契约增加了最多 15 秒的就绪等待，没有修改连接恢复实现。测试临时目录使用工作区 `artifacts`，以避开沙箱 TEMP 的原子重命名限制；浏览器和 Docker 验收在获准的本地环境运行。

KafkaJS／Node 24 的 `TimeoutNegativeWarning` 仍保留，未使用私有 API 屏蔽。

## 未运行的路径

- 已安装 DSH Desktop／Web 的最终包验收：`NOT_RUN`。
- 真实模型工具调用、业务 Broker 和实际双机房切换：`NOT_RUN`。
- 新增关联查询在真实受限 ACL 矩阵下的所有组合：`NOT_RUN`；部分权限降级由受控测试覆盖，既有 Group／Topic ACL 拒绝由隔离 Broker 覆盖。

截图位于 `artifacts/ui/kafka-catalog-tree/` 和 `artifacts/kafka-readonly-ui/`。当前源码、构建与证据摘要见 `artifacts/kafka-implementation/report.json`。

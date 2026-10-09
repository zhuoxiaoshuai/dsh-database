# Kafka 排障与修复实施记录

日期：2026-10-04 至 2026-10-05。基于已有 Kafka 只读工作台和 SIT 单条发布增量实现，保留工作树原有修改。

## 已实现

- 定位：发布回执、Lag 行和完整消息可生成 PEEK 或重发草稿；PEEK 支持下一段、指定 Offset；可查看 Topic 配置、记录会话内 Lag 快照、复制无正文摘要。
- 检索：按时间定位各分区 Offset；跨最多 8 个分区扫描最多 200 条、30 秒，Key／Header 精确匹配最多返回 50 条，结果遵守 1 MiB 上限。未完成时返回各分区续读位置，不自动继续或提交消费位点。
- 修复：单条 UTF-8／显式 Base64 字节发布，Key／Value／Headers 解码总量最多 64 KiB；同 Topic 最多 10 条、总量最多 256 KiB 的逐条批量发布；完整 PEEK 消息可编辑重发，截断预览不可直接重发；compact Topic 的非空 Key 墓碑。
- 管理：SIT 创建 `dsh-test-` Topic，先经 Broker 参数验证，随后创建并回读元数据；无运行成员的消费组按指定 Offset 或时间调整位点，写前对比调用者提供的旧位置，写后回读。目标时间后无消息时使用当时分区末尾位置。
- Host、Worker、命令与 AI 工具复用 Kafka 参数校验及现有执行生命周期。写操作仅限 SIT；AI 可直接调用，人工页面显示确认。派发后的超时、取消或回执丢失记为结果未知，不自动重试；批量保留已确认逐条回执。Kafka 共编命令上限提升到 512 KiB，其他数据源原上限不变；共编草稿会保存消息内容，执行摘要不保存正文。

## 验收边界

- `npm run check`：PASS，类型检查、735/735 单测及 Host／client 构建通过。
- `npm run test:kafka-readonly-ui`：PASS，7 组受控浏览器检查，覆盖既有页面以及新增二进制草稿、批量人工确认和回执回读；无 `pageerror`。
- `npm run test:package-closure`：PASS，65 个运行时文件，Kafka Worker 与相对导入闭包通过。
- `npm run test:kafka`：本轮实现期间曾 PASS，隔离 Kafka Host／Worker 探针验证二进制发布回读、批量、墓碑、创建 Topic、时间定位、扫描和消费组位点调整，并通过认证／ACL 读取矩阵。2026-10-05 最终重跑因 Docker Desktop Linux Engine 未运行，在容器创建前失败；尝试启动 Docker Desktop 和服务，服务启动被本机系统拒绝。最终代码状态的隔离实连重跑记为 `NOT_RUN`，先前通过记录不冒充最终重跑。

已安装 Web／Desktop、真实模型调用及业务 Broker：`NOT_RUN`。受控浏览器与隔离 Broker 证据不等于这些环境的验收。

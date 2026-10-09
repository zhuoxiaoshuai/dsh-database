# Kafka 单条消息发布实施记录

日期：2026-10-03。优先解决开发排障时只能查看、不能向已有 Topic 发送一条测试或修正事件的问题。此项是 2026-10-02 Kafka 只读闭环之后的本地增量；保留既有工作树修改，未安装、提交或发布插件。

## 范围与入口

- `PRODUCE {"topic":"orders","key":"case-1","value":"hello"}` 一次只发一条；可选 `partition` 和字符串 `headers`。Value 为最多 3072 UTF-8 字节，不提供二进制、批量、null tombstone 或原消息改写。
- Topic 总览提供“发布单条消息草稿”；查询页人工执行和 AI 共编页人工执行会确认目标。AI 工具 `kafka_produce` 使用当前共编文档修订、控制权、连接代次及 Host 队列复核。
- Host 按可信连接环境限制在 SIT；Broker ACL 仍决定实际写权限。生产 Worker 在发送前读取现有 Topic 元数据，禁用自动建 Topic，单次 `acks=-1`，不在结果未知后自动重试。
- Broker 回执只返回 Topic、分区、可用 Offset、Value 字节数及执行 ID，不返回正文、Key、Headers。执行记录不保存消息正文；AI 共编草稿会保存命令原文，因此不得输入凭据或私密数据。Kafka 经验库拒绝保存发布命令。
- 派发后取消、超时、连接关闭或丢失发送回执均按 `unknown` 处理；提示先核对目标再决定是否重发。没有改变 PEEK 的临时消费组和不提交 offset 契约。

## 本轮验证

| 验证 | 结果 | 边界 |
|---|---|---|
| 类型检查、全量单测 | PASS，721/721 | 本地源码；不等于已安装或模型调用 |
| 构建与发布包闭包 | PASS | 构建需在可写权限下覆盖先前生成的 `lib/index.js`；包闭包 65 文件 |
| Kafka 命令、授权、生命周期 | PASS，31 项定向测试 | SIT 一次派发，UAT/PVT 拒绝，取消后 `unknown`，无自动重放；含受控 Worker |
| Kafka 公共工作台 UI | PASS，6 组 | 420/768/1200px、深浅色；Topic 草稿、人工确认、AI 共编人工确认、回执显示及重连名称缓存；受控桥接 |
| 隔离真实 Kafka | PASS | `npm run test:kafka` 使用已有缓存镜像创建并清理一次性 broker；正式 Host/Worker/KafkaJS 发布并回读一条，其他 TLS/SASL/ACL **读取**矩阵回归通过 |

`NOT_RUN`：本轮已安装 Web/Desktop、真实模型调用及工具 `callId` 关联、现有测试 broker、业务集群、Kafka PRODUCE 的 TLS/SASL/受限写 ACL、发送过程真实网络断线注入。此前只读功能的实连与安装通过记录不能当成本轮发布能力验收。

下一阶段若继续扩展排障写能力，应单独设计消费组位点调整的停组检查、范围预览和显式确认；Topic 创建/删除/配置管理不在本次范围。

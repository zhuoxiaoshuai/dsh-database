# Kafka

Kafka 可搜索并分页列出 Topic／消费组，查看分区、成员、Lag 与 Topic 配置，按时间定位及有界扫描消息。SIT 可发布单条或限量批量消息、重发完整消息、发布压缩墓碑、创建测试 Topic，以及调整无运行成员消费组的位点。

```text
TOPICS SEARCH "orders" CURSOR 100
GROUPS SEARCH "billing"
GROUP "billing" TOPICS
GROUP "billing" TOPIC "orders"
PEEK "orders" PARTITION 0 FROM LATEST LIMIT 20
PRODUCE {"topic":"orders","key":"case-1","value":"hello"}
TOPIC_CONFIG "orders"
TIME_OFFSETS {"topic":"orders","timestamp":1760000000000}
SCAN {"topic":"orders","partitions":[0,1],"timestamp":1760000000000,"key":"case-1"}
PRODUCE_BATCH {"topic":"orders","messages":[{"value":"first"},{"value":{"base64":"AAE="}}]}
TOMBSTONE {"topic":"orders","key":"case-1"}
CREATE_TOPIC {"topic":"dsh-test-example","partitions":1,"replicationFactor":1,"cleanupPolicy":"compact"}
SET_GROUP_OFFSETS {"groupId":"billing","topic":"orders","expected":{"0":"12"},"offsets":{"0":"10"}}
```

把 `"orders"` 换成你实际有的 Topic 名。

认证支持：无认证、TLS+CA、PLAIN、SCRAM-SHA-256 / 512。PLAIN 和 SCRAM 可以不开 TLS；一旦开了 TLS，就会校验证书。不支持 Kerberos、OAuth 和客户端证书。所有写操作仅在 SIT 开放，还须 Broker 账号具有相应权限；创建 Topic 仅允许 `dsh-test-` 前缀。

PRODUCE 兼容原有文本写法，Key、Value 和 Headers 也可使用显式 Base64 字节；每条解码后总量最多 64 KiB。批量限同一 Topic 的 10 条、总量 256 KiB，逐条发布，失败或结果未知即停止。人工运行写操作前会显示目标和变更确认；AI 工具可直接执行，但仍受共编控制权、连接代次、SIT 与 Host 参数校验约束。Broker 回执显示分区与 Offset；取消、断线或超时后可能已经写入，历史标为结果未知，须先核对再决定是否重发。消息正文不进执行摘要；共编草稿会保存命令原文，请勿放入凭据或私密数据。已有消息不能原地修改，重发会产生新消息；墓碑只用于 compact Topic，压缩异步完成。

Peek 使用临时消费组 `dsh-peek-{uuid}`，并且 `autoCommit: false`。这些组不会出现在 GROUPS 列表里。如果 stop 或 disconnect 超时，会丢掉当前 Worker 再开一个新的。

列表每页最多 100 项。“下一页草稿”只填写命令，不自动执行；列表变化可能导致重复或遗漏。查询、AI Query 和经验编辑器共享本连接／代次已读取的名称候选，提供中文补全和参数说明，不发在线名称扫描。

消息保留原文、null、空字节、Base64、长度和截断标记；完整合法 JSON 可切换格式化查看。复制／导出只包含当前有限预览，不后台补读。结果包最多 1 MiB；详情截断和读取未完成均明确显示。纯控制记录或过滤批次无法证明到达范围上界时，PEEK 会在截止时间返回未完成。

历史只读评审与各阶段验收边界见 [Kafka 只读评审](../kafka-readonly-review.md)。单条发布的历史记录见 [实施记录](../plans/kafka-produce-implementation.md)；排障扩展的阶段验收见 [Kafka 排障与修复实施记录](../plans/kafka-repair-implementation.md)。

最终代码实连重跑、安装版和真实模型的未验收项以实施记录中的 `NOT_RUN` 为准。

[返回首页](../../README.zh.md) · [English](kafka.en.md)

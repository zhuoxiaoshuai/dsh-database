# Kafka

Kafka 可搜索并分页列出 Topic／消费组，查看分区、成员、Lag 与 Topic 配置，按时间定位及有界扫描消息。SIT 可发布单条或限量批量消息、重发完整消息、发布压缩墓碑、创建测试 Topic，以及调整无运行成员消费组的位点。

```text
TOPICS SEARCH "orders" CURSOR 100
TOPIC_GROUPS "orders"
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

## 表单生成命令与多命令查询

在「查询」工具栏点击「生成命令」，按中文操作选择参数。覆盖 14 个命令的 16 种操作形式；消息、Headers、分区和位点均可用表单填写，支持文本和 Base64。Topic、消费组候选在使用字段时按需读取，可搜索、继续加载，也可直接手填；候选读取失败不阻止手填。切换操作保留当前工作区的表单草稿，重连或切换连接后清空。

点击「生成」将命令换行追加到查询末尾，不自动执行；一次撤销可撤回本次追加。命令预览自动处理 JSON 和引号，日期时间按界面显示的浏览器时区转换为毫秒时间戳。位点调整可「读取当前位点」辅助填写；未知位置须核验，不能当作未提交。

有选区时「执行选中」，无选区时「执行全部」。换行或分号分隔命令，多行 JSON 和字符串内部的分隔符不会拆开命令。每次最多 50 条，编辑器总长度最多 512 KiB 字符；单条参数及网络请求大小仍受原有限制。先校验全部待执行命令，再对写操作汇总确认一次，之后依次执行。

每条命令有独立结果页签；「消息」页显示进度、错误和执行 ID。失败、取消或结果未知时停止后续执行，保留已完成结果，其余标为未执行。已成功的操作不会回滚；停止后已发送的写入可能生效，应先核验。查询运行期间的编辑只影响下次执行，结果中的命令是本次执行快照。AI Query 和经验库仍一次执行一条命令。

## Topic 与消费组关联查看

Topics 列表展示分区数、副本因子和健康状态；Topic 详情提供分区、消息、关联消费组三个页签。分区展示 Earliest、End、Leader、副本、ISR 和健康；消息可指定分区和 Offset 限量读取。关联组区分当前分配与历史提交，点击组名直接定位到该 Group / 当前 Topic 的分区消费，支持返回来源 Topic，保留浏览位置和查询草稿。

消费组列表展示 State 与 Members；“加载本页消费汇总”按需获取 Topic 数、Total Lag 和已知异常／未提交分区数。详情包括 Topic 汇总、分区消费和成员；分区表直接显示 Consumer ID、Client ID、Host，便于核对主备机房分配。

未提交、早于 Earliest、超过 End 和不可读分别显示；未知或异常位点不显示 Lag 为 0。总 Lag 只有完整且全部分区有效时展示，否则显示 `-`、已知小计与覆盖数量。Offset 差值不是精确消息条数；在线或 Lag 为 0 不代表下游业务完成。

`TOPIC_GROUPS` / `kafka_topic_groups` 按当前分配与历史提交反查。每次最多检查 100 个候选组、并发最多 4、期限 30 秒；空匹配页也可能有下一页，须继续使用 nextCursor。完整遍历且无失败后才能认定未发现关联组；权限不足、解析失败、超时、截断均提示不完整。消费组列表变化可能造成重复或遗漏，完整重查请刷新第一页。主列表不会自动扫描全部组的 Topic 关联。

详情显示采集时间并支持独立刷新；成功且完整的查询按连接 Worker 缓存 15 秒（最多 100 项、合计 8 MiB），手动刷新绕过缓存，重连清空。各次查询不是 Broker 的原子快照。

认证支持：无认证、TLS+CA、PLAIN、SCRAM-SHA-256 / 512。PLAIN 和 SCRAM 可以不开 TLS；一旦开了 TLS，就会校验证书。不支持 Kerberos、OAuth 和客户端证书。所有写操作仅在 SIT 开放，还须 Broker 账号具有相应权限；创建 Topic 仅允许 `dsh-test-` 前缀。

PRODUCE 兼容原有文本写法，Key、Value 和 Headers 也可使用显式 Base64 字节；每条解码后总量最多 64 KiB。批量限同一 Topic 的 10 条、总量 256 KiB，逐条发布，失败或结果未知即停止。人工运行写操作前会显示目标和变更确认；AI 工具可直接执行，但仍受共编控制权、连接代次、SIT 与 Host 参数校验约束。Broker 回执显示分区与 Offset；取消、断线或超时后可能已经写入，历史标为结果未知，须先核对再决定是否重发。消息正文不进执行摘要；共编草稿会保存命令原文，请勿放入凭据或私密数据。已有消息不能原地修改，重发会产生新消息；墓碑只用于 compact Topic，压缩异步完成。

Peek 使用临时消费组 `dsh-peek-{uuid}`，并且 `autoCommit: false`。这些组不会出现在 GROUPS 列表里。如果 stop 或 disconnect 超时，会丢掉当前 Worker 再开一个新的。

列表每页最多 100 项。“下一页草稿”只填写命令，不自动执行；列表变化可能导致重复或遗漏。查询、AI Query 和经验编辑器共享本连接／代次已读取的名称候选，提供中文补全和参数说明，不发在线名称扫描。

消息保留原文、null、空字节、Base64、长度和截断标记；完整合法 JSON 可切换格式化查看。复制／导出只包含当前有限预览，不后台补读。结果包最多 1 MiB；详情截断和读取未完成均明确显示。纯控制记录或过滤批次无法证明到达范围上界时，PEEK 会在截止时间返回未完成。

历史只读评审与各阶段验收边界见 [Kafka 只读评审](../kafka-readonly-review.md)。单条发布的历史记录见 [实施记录](../plans/kafka-produce-implementation.md)；排障扩展的阶段验收见 [Kafka 排障与修复实施记录](../plans/kafka-repair-implementation.md)。

最终代码实连重跑、安装版和真实模型的未验收项以实施记录中的 `NOT_RUN` 为准。

[返回首页](../../README.zh.md) · [English](kafka.en.md)

# Kafka 只读闭环实施记录

本轮依据已确认的 Kafka 只读完善计划实施，保留已有修改，不新增写操作、不下载镜像、不创建替代数据库环境。

## S0 基线

- 2026-10-02：类型检查通过，653/653 测试通过。
- 日志：`artifacts/kafka-readonly-baseline-typecheck.log`、`artifacts/kafka-readonly-baseline-test.log`。
- 既有改动：`artifacts/kafka-readonly-status-before.txt`；历史验收不是本轮验收。

## 顺序

1. S1：有界读取、取消、结果限量、总览竞态和单一结果事件。
2. S2：列表分页、消费组 AI、缓存名称补全、消息 JSON／导出。
3. S3：引用与冗余检查，保持公共工作台及协议边界。
4. S4：同源码单元、浏览器、现有容器实连、发布包和无豁免 Web 安装。

KafkaJS 2.2.4 对纯过滤批次不调用 eachMessage／eachBatch。无法用公开回调证明扫描上界时必须保持 deadline／未完成，不能伪装完成。首轮继续使用 eachMessage，避免为读取控制记录增加私有 API。

实际文件、偏差、结果和 NOT_RUN 在进度文档及本轮报告记录。

本计划已实施，当前功能与评审证据见 [Kafka 只读评审](../kafka-readonly-review.md)，最终同版本命令和安装报告见进度文档及 `artifacts/kafka-readonly-report.json`。历史失败报告保留，不改写为通过。

本计划已实施，当前功能与评审证据见 [Kafka 只读评审](../kafka-readonly-review.md)，最终同版本命令和安装报告见进度文档及 `artifacts/kafka-readonly-report.json`。历史失败报告保留，不改写为通过。

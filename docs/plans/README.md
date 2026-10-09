# 实施计划目录

本目录保存具体任务的实施计划。

Plan 和 Architecture 职责不同。

Architecture：

描述长期系统边界。

Plan：

描述某一次具体修改怎么完成。

Plan 可以包含：

- 文件
- 方法
- 调用链
- 迁移顺序
- 测试
- 验收
- 停止条件
- 临时兼容方案

## 执行原则

执行计划前：

1. 确认计划对应的代码版本和当前代码没有发生重大偏差。
2. 阅读计划涉及的实际代码。
3. 按阶段实施和验证。
4. 实际代码与计划明显不一致时停止硬套。
5. 记录计划偏差及原因。

## 完成后

计划完成后：

- 长期有效的架构结论进入 architecture 文档。
- 长期有效的工程原则进入 development-guidelines。
- 数据源特殊规则进入 datasource 文档。
- 临时文件名、方法名和阶段过程继续留在 plan 中，不复制到长期文档。

这样长期文档不会因为一次实施细节不断膨胀。

## 最近实施记录

- [执行边界修复（2026-10-05）](execution-boundary-implementation.md)：执行身份、回执丢失、unknown 冻结、共享结果接纳与网格值语义；记录受控通过及最终实连／安装环境的 NOT_RUN 边界。

- [统一事实接纳与解释（2026-10-03）](fact-adoption-implementation.md)：文档 reducer、完整执行身份、普通 SQL 快照、兼容口与回执收敛，含受控与隔离实连边界。

- [Kafka 单条消息发布（2026-10-03）](kafka-produce-implementation.md)：SIT 发布入口、结果未知处理与本轮验收边界。
- [Kafka 排障与修复（2026-10-04）](kafka-repair-implementation.md)：有界检索、二进制与批量发布、墓碑、测试 Topic 和消费组位点调整。
- [剩余闭环与适配层收敛（2026-10-03）](remaining-closure-implementation.md)：源码变更、接口约定、回归与真实故障验收矩阵。

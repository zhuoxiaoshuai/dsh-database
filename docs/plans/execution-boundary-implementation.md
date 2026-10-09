# 执行边界与重复协调收敛实施记录

日期：2026-10-05。主 agent + 3 个执行 agent；按 Host、传输、SQL/网格及共享结果独占文件实施，交叉复核由原负责人修复。保留原工作树及 Kafka 修改；未提交、发布或安装插件。未升级存储版本、增加执行终态、文档存储或队列。

## 问题闭环

| 问题 | 源码修复与受控证据 |
|---|---|
| HTTP 回执丢失可再次发送写入 | bridge 明确 before-fetch/fetch/response 和可信回执；断包、截断、无效成功、发送后取消、旧 explain HTTP 错误为 unknown。真实本地 HTTP 收完 INSERT 后断开，第二次调用零发送。 |
| 失败后换库重试 | SQL 重试/继续验证原快照和失效版本，换库、重连、切回原库均不能恢复；新执行建立新批次。浏览器换库后发送计数保持一。 |
| 预览等待中目标失效仍提交 | 两页共用提交协调，预览返回后复核；失效拒绝旧预览、execute 为零；已派发结果保留。 |
| Redis/Kafka 远端修改文档仍显示旧结果 | 文档 hook 不再保存 reply；统一结果总线对照到达时文档，文档变化立即移除当前结果，历史事实保留。 |

集成交叉复核追加修复：同文档旧恢复覆盖新结果、非法结果载荷、旧批量展开丢失写入回执标记、旧 shared-query-explain 传输分类遗漏、新增主键按已有行权限误判、直接 EXPLAIN 类型遗漏。

## 删除或收敛的重复实现

1. SQL 执行内核不再依赖 SharedQuery/lastRun 历史投影；兼容投影只在边界生成。
2. 删除文档 hook 的结果存储和 SQL 编辑器 onDisplay 写入；四源共用当前结果协调入口。
3. 两处网格确认、保存、失败和 unknown 冻结共用 `useGridSave`；列映射和读取保留来源差异。
4. 实时结果必填身份由原快照生成，完成时不拼接当前文档；兼容记录字段仍可缺失。
5. SQL entry、分析和 Worker 证明收进 SQL 适配，删除 afterAnalysis 回调。
6. 删除生产导出的 applySharedQueryPatch/takeSharedQueryControl/returnSharedQueryControl，旧测试改为实际文档服务。

## 验收边界

最终已通过：Host/Client 类型检查、全量测试 **768/768**、工作台时序、SQL 工作台（MySQL/Oracle 两套）、两处 unknown 网格、两处新增值语义、事实接纳及同文档恢复竞态、Redis/Kafka 远端文档结果清除、构建与发布包闭包（65 文件，671419 字节）。本地 HTTP 故障服务消费写请求后断包，unknown 原写入再次调用被阻断，发送计数为 1。

原复现脚本已改为修复回归；原负向脚本保留为 `artifacts/review-followup/*.baseline.mjs`。这些是受控证据，不是数据库提交证据。

源码、类型检查、受控回归、构建与发布包闭包分别记录；真实数据库、安装版 Desktop 和真实模型通过前，不能表述为所有环境已验收。

最终机器可读汇总：[acceptance.json](../../artifacts/execution-boundary/acceptance.json)。全量测试日志：[unit-tests.log](../../artifacts/execution-boundary/unit-tests.log)。

- 工作台时序、普通 SQL 工作台、unknown 网格、四源当前结果、网格默认值/NULL/空字符串使用真实客户端模块与受控 bridge，不能替代实连。
- MySQL/Oracle 新故障探针使用独占临时容器、实际 Host/Worker、实际浏览器 bridge。独立数据库连接确认提交后切断 HTTP 回包或返回截断 JSON，再验证 unknown、实际变化与零重发。既有 Worker TCP 故障测试保留。
- 本轮首次 MySQL 初始化失败：Docker Linux Engine 管道不存在。启动已安装 Docker Desktop 后读取状态仍不可用。MySQL、Oracle、Redis/Kafka 实连保持 NOT_RUN，原因是隔离容器运行时不可用，不能用 fixture 成功替代。
- Oracle 19c/SID、安装版 Desktop、真实模型及未覆盖认证组合保持 NOT_RUN。本轮未安装源码包，也未确认安装版包含本轮修改。

# Kafka 命令生成器与多命令查询

日期：2026-10-16。

## 使用方式

Kafka「查询」页左侧工具栏新增「生成命令」。选择中文操作、填写参数并查看预览，生成后换行追加到编辑器；不自动执行，一次撤销可撤回本次追加。覆盖现有 14 个命令、16 种操作形式。详细用法见 [Kafka 使用说明](datasource/kafka.md#表单生成命令与多命令查询)。

有选区时执行选区，无选区时执行全文。顶层换行和分号分隔命令，多行 JSON、引号转义和字符串内部的分隔符保持完整。全部语法预校验后，对写操作汇总确认一次，再依次执行；每条对应结果页签。失败、取消、结果未知均停止后续派发，已成功操作不会回滚。

## 实现边界

- 共享工作区增加可选 `ManualQuery` 组件，保留共享导航和查询草稿；Kafka 提供人工多命令行为，AI Query、经验库及其他来源维持原有执行语义。
- `src/shared/kafka-command.mjs` 是浏览器和 Host 共用的解析、格式化、参数校验入口。Host 旧路径继续导出兼容接口，并将共享字节转换为 KafkaJS 使用的 Buffer。构建时内联共享依赖，保持 Worker 包内导入闭合。
- Kafka 批次仅在客户端安排执行顺序，继续逐条调用现有 `executeText`；每条由现有 Host 生命周期创建唯一记录、校验权限并返回回执。没有新增批量执行 HTTP 接口或第二套执行记录。
- 结果步骤保留执行原文、范围、状态、执行 ID 和结果。运行后的编辑不改变本次快照；连接代次或对话切换销毁旧查询控制器，取消队列并忽略旧回执。
- 结果未知的批量发布可在错误响应中携带有界 `sourceResult`，保留已确认消息的回执。客户端仅采纳可信错误响应中的该字段；不将 HTTP 成功等同于业务成功，不自动重试写入。
- 查询文档上限 524288 字符，一次最多 50 条；单条命令、消息大小与 HTTP 请求继续遵循原有界限。Offset 使用字符串。写操作维持 SIT 限制。

## 表单与候选

仅挂载所选操作的表单；可选字段关闭时不生成隐藏参数。Key 可区分未提供和空文本；文本与 Base64 独立选择；Headers 用可增删行表达，同名自动合并；批量消息和分区位点分别使用卡片与行。

Topic 和消费组在打开字段时读取候选，支持搜索、防抖、分页、重试和手填。分区仅在相应输入启用后读取。请求取消与结果隔离按连接及当前字段处理，不预扫描隐藏操作；表单草稿仅存在于当前工作区内存，重连后清空。

「读取当前位点」只将可验证的提交位置或明确的未提交状态填入旧位置；不可读、缺失及未知位置均报错，不生成伪造的 `null`。日期时间显示浏览器时区并转换为毫秒。

## 验证入口与证据

本轮最终结果：类型检查、构建、991/991 项串行完整测试、10 组新界面受控验收、7 组原有 Kafka 界面回归、隔离真实 Broker 新旧链路及认证验收、80 文件包内闭包检查均通过。

默认 `npm run check` 的四并发测试曾触发既有 Oracle 实验解析器 5 秒启动超时；该测试单独及串行完整测试均通过，未修改其超时限制。串行回归还发现两处原有 Kafka 测试引用了现有源码已替换的标题变量和水位函数，本轮已更新测试以检查当前标题及空分区/精确大整数指标，未改动相关页面实现。完整门禁应区分默认并发日志与串行通过结果。

| 验证 | 命令 / 证据 |
|---|---|
| 类型与完整项目门禁 | `npm run check`；日志 `artifacts/kafka-command-builder/check.log` |
| 串行完整测试 | `node --experimental-strip-types --test --test-concurrency=1 test/*.test.mjs`；日志 `artifacts/kafka-command-builder/full-suite-serial.log` |
| 新界面受控验收 | `npm run test:kafka-builder-ui`；`artifacts/kafka-command-builder/ui/report.json` |
| 原有 Kafka 界面回归 | `npm run test:kafka-readonly-ui`；`artifacts/kafka-readonly-ui/report.json` |
| 新链路真实 Broker | `npm run test:kafka-builder-broker`；`artifacts/kafka-command-builder/broker-report.json` |
| 既有真实 Kafka / 认证回归 | `npm run test:kafka`；`artifacts/kafka-command-builder/real-broker.log` |
| 包内闭包 | `npm run test:package-closure`；`artifacts/kafka-command-builder/package-closure.log` |

受控 UI 验收覆盖 16 种操作表单、浅深色、420 / 768 / 1200px、追加与撤销、字段错误与焦点、候选分页/手填/失败重试、半条选区拒绝、多结果页签及相同 Offset 的重发草稿隔离、一次写确认、停止未知写入、重连后的迟到结果隔离。

新链路真实 Broker 验证了表单生成、Host/Worker 顺序执行、消息原文回读、独立执行 ID、每条唯一历史，以及消费组位点变更与回读。验收使用自动创建并清理的隔离 Broker。

真实已安装 DSH Desktop/Web、业务集群和实际模型调用：`NOT_RUN`。

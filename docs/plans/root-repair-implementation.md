# 根因修复实施记录

日期：2026-10-02。保留实施前已有 SQL／Redis／Kafka 改动；不提交、不发布、不安装。

## 2026-10-09 三项功能修复

本节记录本次新增问题，保留已有工作树修改，不新增框架、存储版本或执行队列，不安装、提交、发布或重建环境。

- 公共编辑器对外部 value 同步添加事务标记及 `addToHistory=false`；SQL、Redis、Kafka 仅将真实用户文本事务报告为编辑，保留光标和选区通知。远程发布不产生额外保存或误接管，真实键入、补全、格式化和撤销保持原流程。
- `runSharedQuery` 在发布前确定 verify/result。验证执行保持权限、控制权、记录和实际 SQL，但不修改权威文档的文本、目标、修订或控制者，不替换已有结果；显式 result 正常发布和展示，完整文档与实际执行文本继续分开。
- MySQL 连接创建时安装持续的 error/end 处理，主动关闭不报告异常，同次失效只通知一次。Catalog 失效清除坏连接并发布 degraded；查询池淘汰空闲坏连接，借出连接由原请求完成收尾，释放配额并唤醒等待者。SQL Worker 仅对 MySQL 每 30 秒空闲探测 Catalog，复用探测期限与串行通路，忙时跳过、不重叠，关闭清理定时器。Host 沿用既有 revive 次数和退避，查询成功不再错误取消仍处于 degraded 的 Catalog 恢复；不增加 Worker 自动重建，不重放未知写入。
- MySQL 保留字段类型/字符集并沿用驱动字符集解码，启用 jsonStrings 保留 JSON 原始数字。严格 UTF-8 文本可查看；非法字节、NUL 或非文本控制字符显示十六进制，BIT 显示位值，GEOMETRY 显示结构化文本。现有结果预算保留，SHOW/EXPLAIN 的转换结果同样受 1 MiB 限制。
- 新 SQL 结果携带 binaryColumns（无二进制时为空数组），贯穿批次、执行投影、事件、HTTP 与恢复预览。网格和详情按索引只读，Host 维护校验拒绝二进制文本写回；旧结果保留占位符兼容，新普通文本 `[BLOB 4 bytes]` 可以编辑。详情编辑框复用已有原始 token 格式化，避免 JSON 大整数被解析后写回成另一个数；复制与导出使用转换后的原文。Oracle 标量保持兼容，RAW 标记只读，本轮没有增加 LOB 读取。

验证：typecheck、全量测试 **796/796**、build、包闭包检查通过（65 个发布文件，相对运行导入完整），`git diff --check` 无空白错误。新增/扩展测试覆盖远程事务与撤销、verify 不发布、连接级重复通知、主动关闭、池配额及等待者、忙时探测、原生字段转换、JSON 大整数、BIT/GEOMETRY、非法字节、空字节、大小限制、批次预览和二进制维护拒绝。既有恢复耗尽及写入 unknown/不重放回归继续通过。

受控 MySQL 协议服务器使用真实 mysql2 套接字、生产 SQL Worker 和 ConnectionService：查询池空闲断线不降低登录健康，Catalog 空闲断线后自动恢复，逻辑连接代次不变，恢复后查询成功。这是生产通信链的受控测试，**不是实库验收**。短周期探测测试没有等待真实 30 秒。

浏览器：`artifacts/execution-boundary/browser-report.json` 已将四源关键链路的 `<pre>` 替身换成真实 SQL/Redis/Kafka CodeMirror，正式注册工具经 Service、受控 Worker、文档事件和公共 hook 到达结果渲染器；初始挂载与 AI 发布零用户编辑回调、控制者保持 AI，真实键入仍接管，SQL verify 不改文档/结果。**2026-10-08 的该报告只覆盖 hooks/渲染器，不能作为真实编辑器同步已通过的证据。** `artifacts/ui/grid-values/report.json` 验证中文/十六进制详情、二进制只读、占位文本可编辑及 JSON 大整数编辑原文；SQL 工作台回归见 `artifacts/ui/sql-workspace/run-Apmd7l/report.json`，补全键盘/输入法浏览器回归通过，均无 pageerror。

本轮真实 MySQL 会话级空闲超时、锁定连接故障注入、真实字段返回：**NOT_RUN**，没有提供复用现有授权实例所需的 DSH_TEST 凭据。没有修改全局超时、读取容器密码、下载镜像或新建容器。Oracle/Redis/Kafka 实连、已安装 Desktop、真实模型调用：**NOT_RUN**；历史实连和本次受控验收均不代替这些场景。

## 2026-10-08 功能修复续验

本节描述当前工作树；下方 2026-10-02 的实连结果仅为历史证据，不代表本次代码已实连验收。本轮只修改插件，保留原有改动，不安装、不提交、不发布。

- 接通 ConnectionService 缺失的文档、目录、Redis 读取及存储状态接口；SharedQuery 适配权威文档，执行摘要从记录派生。删除被替代的手写共编执行与 Redis 记录流程，复用现有授权、队列和 runOperation，普通查询不额外创建记录。
- 异步准备和授权必须完成才派发，可信 lane 传到 Worker。进度不结束请求；结构化错误与批次逐项回执经过 Worker、Host、HTTP 保留。HTTP 不猜未知写入为未执行，派发后回执缺失保持 unknown，不自动重试。
- 写入在授权、取得连接、准备、校验及提交前检查取消，取消期间取得的连接立即清理。MySQL 会话初始化与目标校验有驱动期限，写入会话同时设置行锁及 MDL 等待期限，复用已有错误分类；未用 Oracle DDL 参数处理 DML。
- 文档执行快照保留完整文档和实际选区，identity 贯穿记录、事件、直接回包及恢复。四源正式注册工具经 Service、受控 Worker、真实 HTTP／事件和公共 hook 到达原生结果渲染器。
- 结果 bus 只保留一份已接受结果；编辑、保存、接管后派生只读旧快照，标明原目标与实际执行文本。换目标／连接／代次立即隐藏，迟到结果仍严格拒绝。新 executionId 展开结果，同一次重复通知不抢用户收起状态；保存或控制错误不替换已有结果，保存失败可就近重试。
- 控制操作排在现有保存队列中；按钮显示处理中，以完整 Host 回执确认，缺失回执明确失败。归还期间再次输入保留用户控制并说明原因，成功后清除旧错误。
- SQL 补全同步使用已就绪元数据，冷缓存到齐恢复请求，Escape 后不重开；移除加载伪候选。支持 Unicode、方言引号、词中左右替换、表列注释检索及必要的比较／LIKE／SET／VALUES 槽位，插入真实名称。不可交互的 pending 不吞方向键／Enter，保护输入法。
- SQL、AI Query、经验库共用结构面板关闭回调；关闭保留选表，可重新打开，面板允许收缩。

当前验证：typecheck、全量测试 **782/782**、build、包闭包检查通过（65 个发布文件，相对运行导入完整）。补全浏览器验收通过中文、词中替换、冷热缓存、Escape、方向键／Enter、输入法等场景；四源工具到渲染器链路见 `artifacts/execution-boundary/browser-report.json`。MySQL／Oracle 工作台验收通过缺失控制回执与恢复、保存重试、三个结构面板关闭／重开和 420／768／1200px 深浅色，报告 `artifacts/ui/sql-workspace/run-BmqDjK/report.json`。公共 hook 竞态验收通过接管迟到、归还期间编辑、目标切换、重连及卸载零派发。以上均为受控 Worker／桥接和真实浏览器验证，不替代实连。

本轮真实 MySQL／Oracle／Redis／Kafka：**NOT_RUN**。只读核对确认 Docker 可用；现有实连脚本需要新建测试容器，本轮禁止重建环境，当前未提供复用测试实例所需的 DSH_TEST 凭据。没有读取现有容器凭据、下载镜像或重建环境。已安装 Desktop、真实模型链路及真实锁等待／提交窗口故障注入：**NOT_RUN**。

## 事实归属

| 事实 | 权威归属 | 兼容形式 |
|---|---|---|
| 共编文本、目标、修订、控制权 | ExecutionDocument | SharedQuery 只读投影与旧 action 薄适配 |
| 本次发起者 | 可信 Host 入口 | HTTP 不能指定 AI 身份或额度 |
| 执行内容与归属 | 单次不可变执行快照 | 完整 documentText 与 executedSql 分别记录 |
| 结果与部分提交 | ExecutionStore 与逐项回执 | 当前结果须匹配 connection、generation、revision、schema |
| 排队额度 | 现有 ConnectionService 调度 | 人工 manual，AI ai，保留人工槽 |

## 已实施

1. EXPLAIN 非 SELECT 明确拒绝；两方言解析诊断失败闭合拒绝；特殊 SHOW／DML 分支核对系统对象与锁定读；Oracle 统计维护绑定检查目标，字符串正确编码并保留大小写。
2. 写入错误携带效果确定性与阶段；丢失提交回执为 unknown。整批 SQL 在任何执行前完成静态授权；Worker、HTTP、AI 输出及历史保存逐项回执。普通 SQL 客户端提交整批，按回执展示。网格使用同一协调方法：成功项即时移出，未知项禁止重提，撤销旧草稿后刷新。
3. SQL 共编复用公共文档保存／控制队列；上下文与文本原子更新；缺失或过期修订拒绝。保存冲突保留最后本地草稿，刷新权威修订后显式重试。执行选区保留完整文档。迟到成功和失败不进入替换后的页面。
4. 工作区 v1 文件先备份再原子升级 v2；保留查询草稿、页签、历史。文档写盘失败不污染缓存。活动执行不被容量裁剪，磁盘预算可压缩活动记录为最小追踪信息，内存快照不变。启动恢复派发记录为 unknown、未派发为 cancelled，并持久化恢复原因。异步写盘保留最新待写快照，按 1、5、30 秒重试，公开 storageDegraded。
5. 移除旧 SQL 保存队列、重复控制事件、独立执行计划生命周期、无行为 authorizationLocation、无人调用的 SQL 授权回退、重复生产派生注册及密码测试实现。Redis／Kafka 渲染增加穷尽类型检查。

## 权限边界

- 人工普通 SQL 和人工接管共编 SQL：SIT／UAT／PVT 均按账号权限执行 DML，自动提交。
- AI SQL DML：仅 SIT。所有入口均禁止解析失败、EXPLAIN DML、系统对象与未校验语法绕过。
- 网格维护及 DDL：保留 SIT 与人工确认要求；Redis 环境规则与 Kafka 只读规则保留。
- 普通 SQL 页签和对象浏览保留自身显示目标；共编执行只取文档 context。连接默认库仅用于初始化。

## 存储与删除

工作区文件为 v2，只写权威文档。旧 v1 保留 `.v1.bak`，损坏原文保留 `.corrupt.bak`。缓存采用 200 会话 LRU，磁盘文件不设终身 200 个限制。删除对话时回收缓存并将布局和备份移入 `removed-conversation-workbenches`，保留可恢复文件。

直接删除文件曾被自动审批拒绝：未充分证明释放入口仅来自删除会话。后续已核对 `api-session/removed`，采用可逆归档。

## 验证记录

- 类型检查：通过。
- 根因回归：22/22 通过（文档原子性、写盘失败与异步重试、选区快照、六组权限、AI 压力下人工保留槽、v1 迁移、205 会话、活动记录预算、启动恢复、凭据过滤、批量回执、未知重试、迟到结果、Oracle 编码）。
- 浏览器工作台竞态：通过；包含接管响应迟到、交还期间输入、保存顺序、重连、目标保存失败与重试。
- 全量测试：705/705 通过，日志 `docs/plans/root-repair-test.log`。类型检查、最终构建及发布包闭包通过；包清单 65 文件，相对运行导入全部包含。
- SQL 工作台浏览器验收：MySQL／Oracle 均通过；统一文档协议、批量失败／重试／继续、停止、格式化顺序、显式保存重试、目标更新、执行接管期间输入、迟到结果、经验切换、唯一轮询，以及 420／768／1200px 深浅色；报告 `artifacts/ui/sql-workspace/run-btNUYA/report.json`。四源公共挂载验收通过，页面无 pageerror。上述为受控桥接，不替代真实数据库。
- 隔离真实 MySQL 8.4.11：通过。Oracle Free 23.26.2：通过。两方言均以生产 ConnectionService／Worker 验证 SIT／UAT／PVT 人工普通与共编写入、AI 限制、EXPLAIN DML 拒绝、整批预检、成功后数据库拒绝的部分提交回执和单生命周期；另含真实驱动、独立会话回读与连接表单。证据 `artifacts/mysql-acceptance.json`、`artifacts/oracle-acceptance.json`。
- 隔离真实 Redis 7.4：普通与 TLS 验收通过，含目标、结构化读取、五类型、ACL、人工／AI 环境规则与连接变更。隔离真实 Kafka：普通、TLS、自定义 CA、PLAIN、SCRAM 256／512、错误密码、组／Topic ACL 拒绝、保护存储和重连验收通过；PEEK 不提交 offset，业务组 offset 不变。所有本轮临时容器已清理，原有容器保持运行。
- Oracle 19c／SID：NOT_RUN；Oracle Free 的通过不作为 19c 验收。当前缺少已授权测试凭据。
- 已安装 Desktop／真实模型：NOT_RUN；不以 fixture 或历史验收替代。

## 验收缺口（保持未验收）

| 场景 | 本轮证据 | 仍未完成 |
|---|---|---|
| SQL 提交回执丢失、提交时断网／取消／超时 | 结构化效果分类及 unknown 回执受控回归通过 | 真实 SQL 提交窗口故障注入 NOT_RUN |
| 文档乱序、失败、交还输入、目标／代次切换、迟到成功／失败 | 公共 hook 和正式 SQL 客户端浏览器／服务回归通过 | 已安装 Desktop 同组场景 NOT_RUN |
| 历史预算、写盘失败／最新快照重试、启动恢复、超过 200 会话 | 文件系统与重建 ExecutionStore 回归通过 | 真实进程强杀、磁盘持续故障及长时间运行 NOT_RUN |
| Oracle 统计目标绑定与特殊名称编码 | 授权／DDL／字面值回归通过 | Oracle 19c 特殊名称实连 NOT_RUN |
| 四源工具与生命周期 | 正式 Host／Worker 隔离实连或模块回归通过 | 真实模型工具调用及安装环境 callId 衔接 NOT_RUN |

不能把上述未完成项认定为通过。代码修复与隔离验收已交付，完整安装环境验收尚未关闭。

## 相关入口

- `src/shared/execution-document.ts`：文档原子更新。
- `src/client/workspace/source/use-execution-document.ts`：保存、控制、格式化、执行的共同顺序。
- `src/host/connection-service.ts`：可信派发、连接代次、额度、旧接口适配。
- `src/shared/sql-batch.ts` 与 `src/client/execute-dml.ts`：回执投影与保存协调。
- `src/host/execution-store.ts`：终态、历史、预算、恢复、写盘重试。
- `test/root-repair.test.mjs`：根因与故障回归。

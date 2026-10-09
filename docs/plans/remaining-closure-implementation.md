# dsh-database 剩余闭环与适配层收敛实施记录

日期：2026-10-03。实施依据为本轮用户计划；保留既有工作树修改，未提交、发布或安装插件。没有升级工作区存储版本，没有增加文档存储、执行终态、核验记录或队列。

## 1. 已完成的源码修复

| 批次 | 变更及事实归属 | 主要文件 |
|---|---|---|
| 文档收敛 | SQL 绑定层持有唯一文档 hook；历史与草稿恢复立即编辑文本／目标并经同一保存队列；失败保留最后输入；SharedQuery 只做展示投影；总线不再修改或补水文档 | src/client/sql/workspace-bindings.tsx、workspace/source/use-execution-document.ts、ai-collab-pane.tsx、ai-query-bus.ts |
| 导入与接口 | Kafka 导入 schema 支持 brokers/tls/saslMechanism；拒绝非空密码、私钥与 CA 正文；按来源输出，不登录。SQL 关闭页签缓存按 bridge／会话／连接隔离；公共上下文删除 SQL 缓存；注册工厂移入测试辅助；prepareText 删除 queue 占位 | src/host/ai-tools.ts、connection-service.ts、src/client/workspace-sources.tsx、test/helpers/source-registries.ts、各源 execution 模块 |
| 回执与核验 | 普通 SQL、共编、历史共用逐项状态和有界预览；失败响应保留 executionId 和部分回执；未知历史禁止整批套用。原目标核验仅导航，旧代次需显式选择当前连接。两处网格未知项冻结，弃稿后的新读取失败继续冻结 | src/shared/sql-receipts.ts、src/client/sql/sql-receipts.tsx、unknown-grid-notice.tsx、data-sources/sql-history.tsx、ai-executions.tsx、object-workspace.tsx、sql-workspace-tab.tsx、execute-dml.ts |
| 存储恢复 | 快照／等待回包可选报告历史和工作区降级；共享订阅显示状态。手动历史重试合并并发，使用原写链和最新快照，返回实际落盘结果；重启恢复及活动记录沿用 ExecutionStore | src/shared/workbench.ts、database-actions.ts、src/host/connection-api.ts、execution-store.ts、src/client/workspace/source/storage-notice.tsx |

人工各入口的权限、可信 actor 决定的额度、Redis 人工共编执行按钮与 SQL 专属经验分析继续保留。项目客户端已无 shared-query-* 文档修改或补水调用；Host 的响应兼容和 SQL 协调方法仍在。

### 真实故障暴露的遗漏

独立数据库连接已确认第二条写入提交后，切断或延迟回包，再取消／超时，曾导致 Host 提前结束请求而丢失已提交的第一条回执。现通过 Worker 原进度通道保留当前逐项事实，Host 在中断错误中附带已提交前缀；已经结束的 unknown 记录允许补充回执，终态保持 unknown。第三条没有执行，第一条没有重放。

### 接口约定

- hook 的 edit(text, context) 支持原子编辑，unsaved 为只读状态；执行与交还等待保存。历史目标明确时取记录目标，缺失时沿用当前文档目标。
- 可选 storage.executionHistory 包含 degraded/retrying；storage.workspace 包含 degraded。缺失字段不表示存储正常，数据库终态与保存状态独立。
- execution-persistence-retry 只接收 action，不接受记录、路径或执行身份。成功 saved=true；实际失败 saved=false/503。重新启用 1／5／30 秒重试，文档保存由原文档入口重试。
- Kafka 导入枚举包括 kafka；认证为 none/plain/scram-sha-256/scram-sha-512。created/skipped 外框兼容，Kafka created 包含 brokers、tls、saslMechanism、username、environment。
- steps 缺失时保持旧单结果显示，不推造提交事实。成功步骤按成功序号取 batch 预览；失败／未知／未执行不借用成功结果。

## 2. 验证与验收矩阵

| 验证组 | 本轮结果 | 证据与范围 |
|---|---|---|
| 类型检查 | PASS | npm run typecheck，Host 与客户端 |
| 全量回归 | PASS，715/715 | artifacts/remaining-closure-tests.log |
| 构建及发布包运行闭包 | PASS | npm run build、npm run test:package-closure；包检查不是发布或安装 |
| SQL 文档／历史／结果 | PASS，受控浏览器 | npm run test:sql-workspace；正式公共挂载与 MySQL／Oracle 客户端，保存排队／失败／继续输入、缺失历史目标、格式化、旧代次导航、部分回执、存储重试、单一订阅、关闭重开与切换连接 |
| 文档竞态及公共工作台 | PASS，受控浏览器 | test:workspace-races、test:workspace-ui、test:source-module；受控 bridge/Worker，不能替代模型或生产验收 |
| 两处网格未知核验 | PASS，受控浏览器 | artifacts/ui/grid-unknown/report.json；首项提交、第二项未知，刷新失败冻结、成功恢复，无写入重放 |
| Kafka 导入与权限额度 | PASS，受控回归 | 工具 schema、四种认证、无效/缺失 brokers、用户名、去重、混合来源、数量限制及凭据拒绝；未触发登录／Worker；actor 与人工保留槽回归 |
| MySQL 提交回执故障 | PASS，隔离实连 | artifacts/mysql-acceptance.json；独占一次性 MySQL 8.4.11，真实 Host／Worker／TCP 代理，独立连接确认提交，再断回包／取消／超时；逐项 succeeded/unknown/not-run、无重放、提交前取消 |
| Oracle 提交回执故障 | PASS，隔离实连 | artifacts/oracle-acceptance.json；独占 Oracle Free 23.26.2 Thin/Service；与 MySQL 相同三种故障，不代表 Oracle 19c 或 SID |
| 进程崩溃与存储故障 | PASS，真实临时存储 | artifacts/storage-fault-acceptance.json；活动记录落盘后终止本轮子进程，恢复 unknown/cancelled；真实持续写盘失败、1/5/30 秒重试耗尽、并发合并、失败可见、恢复后最新快照 |
| Oracle 19c／SID | NOT_RUN | 本轮无已授权的独占 19c／SID 故障夹具及凭据；Free/Service 通过不替代此项 |
| 已安装 Desktop | NOT_RUN | 已安装 web/desktop 均为 0.1.0-alpha.12.15，但 Host bundle SHA256 与本轮构建不同；未安装本轮修改 |
| 真实模型工具调用 | NOT_RUN | 本轮未调用模型；工具注册/schema 回归不能代替真实模型 |
| Redis／Kafka 新一轮隔离实连故障 | NOT_RUN | 本轮新增实连故障脚本集中 SQL；四源受控回归已运行，既有环境验收不升级为本轮结果 |

隔离容器由本轮脚本创建并回收，数据库验收报告 cleanup=PASS。故障脚本只访问本轮临时存储与自有子进程，不访问用户工作区存储。存储故障脚本曾遇 Windows fs.watch 原生崩溃，改为仅记录真实写盘尝试的观察方式后重跑通过，失败运行残留临时目录已清理。网格夹具初次目录索引格式不符，修正为正式 CatalogResult 结构后两处回归通过；没有将夹具失败当作产品通过。

## 3. 新增验收入口

- npm run test:grid-unknown：两处正式网格组件的受控 UI 核验。
- npm run test:storage-faults：自有子进程和临时目录的崩溃／持久化恢复。
- 现有 test:mysql、test:oracle 内接入 scripts/sql-receipt-fault-probe.mjs：仅从独占容器验收夹具调用；脚本不提供任意目标 CLI。
- 真实数据库脚本确认提交后才故障注入；没有自动生成通用核验 SQL，也没有通过修改 unknown 来制造成功。

## 4. 未关闭的环境验收

源码修复、受控回归和上述隔离实连已完成。Oracle 19c／SID、已安装 Desktop、真实模型仍是 NOT_RUN；最终安装环境验收状态不因构建、fixture 或包闭包通过而改变。后续在对应环境就绪后运行其专属验收并补充证据，不自动提交、发布或安装。

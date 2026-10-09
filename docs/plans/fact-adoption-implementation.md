# 统一事实接纳与解释：实施记录

日期：2026-10-03。范围：本轮 R1–R10；保留既有工作树及 Kafka 发布修改，没有提交、发布或安装。没有升级存储版本、新增队列、执行记录体系或通用状态框架。

## 根因与收敛结果

原问题不是文档存储数量，而是读取、保存、控制回执、实时结果和恢复结果分别决定是否接受同一事实。单条路径上的修订检查不足以保证交叉时序。普通 SQL 维护能力也未绑定显示结果的原始目标。

现在文档接纳集中在 `useExecutionDocument` 内部 reducer，结果接纳集中在 `matchesResultOwner`，批量事实集中在 `sqlReceiptSteps`。入口负责参数与响应适配。数据库算法及来源权限继续留在原模块。

| 编号 | 实施 | 证据 |
|---|---|---|
| R1 旧读取覆盖新保存 | 已确认文档与草稿分开；读取捕获编辑版本、代次；拒绝低修订和失效回复 | 浏览器：旧 GET 晚到、两个读取乱序 |
| R2 恢复结果归属旧文档 | 恢复按完整当前身份去重，回复到达后重新检查当前文档 | 浏览器：挂起 latest 后换文本、目标、修订 |
| R3 重连丢失败草稿 | 同连接重连保留草稿、重新读取，显式重试 | 浏览器：保存失败、重连、明确重试成功 |
| R4 普通 SQL 换目标仍可维护 | 查询、结果、能力绑定运行快照；目标/代次变化作废能力，保留只读原结果、冻结草稿 | 浏览器：迟到查询、迟到能力、切回原库仍不能保存 |
| R5 旧更新忽略 generation | 在线新旧修改、控制、执行均校验当前 generation/revision | 两方言 Host/API 回归 |
| R6 执行拒绝遮盖保存错误 | 保存与操作错误分开；旧读取异常也不能写回新作用域 | 浏览器：保存失败后 run 保留错误及未保存草稿 |
| R7 旧执行绕过人工接管 | 新旧 SQL action 经同一私有文档执行协调和 controller/actor 校验 | 两方言 Host/API：AI 控制下人工执行均拒绝，未创建执行记录 |
| R8 选区结果恢复不一致 | 完整 documentText 判断归属；executedSql 独立保存及显示 | 同一选区的实时/恢复结果纯函数回归 |
| R9 预览裁剪丢提交事实 | steps 归一化一次，stepIndex 关联预览；无预览保留 affectedRows；模型输出复用 | 9 个成功项后 unknown/not-run，裁剪后第 9 项影响行数保留 |
| R10 嵌套锁定读绕过 | MySQL 禁止规则放入递归 AST；Oracle 原递归规则保留 | 两方言顶层/派生表/子查询/CTE 回归及隔离实连 |

## 删除与保留

- 删除旧 hook 分散覆盖文档、独立未保存布尔状态及结果包含字符串判断。
- 删除生产内仅被旧测试调用的 `applyQueryChanged`、`hydrateSharedQuery` 和 `sqlBelongsToEditor`。相应旧协议测试由真实 hook 时序回归替代。
- `runSqlBatch` 不再第二次解释错误回执；普通、共编、历史和模型复用归一化结果。
- `shared-query-*` 保留外部格式；SQL 执行只转入统一文档协调。离线编辑仍须修订，离线不能执行。
- HTTP 身份固定人工；可信工具提供 AI 身份；额度按 actor。Redis UAT 共编按钮是人工执行，保持可用。
- SQL、Redis、Kafka 原有算法、权限、事务与网格语义保留。Redis/Kafka 完整执行文本供即时及内存归属，持久历史继续过滤来源载荷，未扩大持久业务文本范围。

## 验收矩阵

| 层次 | 结果 | 边界与证据 |
|---|---|---|
| 类型检查 | PASS | `artifacts/fact-adoption/typecheck.log` |
| 全量回归 | PASS | `artifacts/fact-adoption/full-tests.log`：727/727；删除 6 个仅测试废弃协议的用例，增加模型回执用例 |
| 构建 | PASS | Host ESM、DSH 客户端工厂与隔离预览；`artifacts/fact-adoption/build.log` |
| 发布包运行闭包 | PASS | `artifacts/fact-adoption/package-closure.log`；本地 dry-run，不发布 |
| 新增生产组件时序 | PASS | `artifacts/fact-adoption/browser-report.json`：11 项；受控 bridge，无数据库 |
| 原工作台时序与 SQL 工作台 | PASS | `scripts/workspace-race-ui-acceptance.mjs`、`scripts/sql-workspace-ui-acceptance.mjs`：保存、格式化、控制、历史、选区、部分回执、共享订阅 |
| 两处网格未知核验 | PASS | `scripts/grid-unknown-ui-acceptance.mjs`：成功项移出、unknown 冻结、失败刷新保持冻结、可信新读取恢复、无重放 |
| 隔离 MySQL | PASS | `artifacts/mysql-acceptance.json`：MySQL 8.4.11，真实 Host/Worker、独立连接核验、环境权限、全批静态拒绝及提交回执故障 |
| 隔离 Oracle Free | PASS | `artifacts/oracle-acceptance.json`：23.26.2 Thin，相同真实故障链；不替代 Oracle 19c |
| 隔离 Redis/Kafka | PASS | `artifacts/fact-adoption/source-live.json`：新建独占容器，真实命令、文档与结果链；Kafka 有界 PEEK 不提交消费位移 |
| Oracle 19c/SID | NOT_RUN | 本轮没有配置并运行独占 19c/SID 验收；现有容器未用于故障注入 |
| Redis/Kafka TLS 与完整 SASL 组合 | NOT_RUN | 本轮隔离实连采用普通连接；不宣称所有认证组合已验收 |
| 已安装 Desktop | NOT_RUN | 没有安装本轮构建，也未验证安装版本与当前源码一致 |
| 真实模型工具调用 | NOT_RUN | 未运行真实模型；工具 schema/Host 受控回归不能替代模型验收 |

SQL 故障脚本只使用本轮临时容器及 TCP 代理：独立数据库连接确认提交后再切断回执、取消或超时，验证 unknown、已提交前缀和不重放；提交前取消另测无派发。容器按独占标签核验并清理，不对用户现有数据库做故障注入。

## 复核命令

```powershell
npm run typecheck
npm test
npm run test:fact-adoption
npm run test:workspace-races
npm run test:sql-workspace
npm run test:grid-unknown
npm run build
npm run test:package-closure
```

隔离实连需要本机 Docker 和相应镜像。`test:mysql`、`test:oracle`、`test:fact-sources` 会创建并清理自己拥有的临时资源。环境缺失不得以受控 fixture 替代实连通过。全部环境验收未关闭前，交付表述仅限源码、受控回归和上述隔离实连范围。

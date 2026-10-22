# 公共框架优化与 Nacos P0 实施记录

日期：2026-10-10。源码版本：0.1.0-alpha.12.32。起点为当前工作区及已有未提交 Nacos 连接代码，没有替换用户原有连接工作。

## 实际交付

Nacos 在原插件内接入连接树与 standard pages；配置列表、编辑、历史、Diff、监听者、服务与按集群分页实例均为真实业务接口。提供八个读取/发现工具与三个变更工具。人工在所有环境预览确认后写入；AI 仅 SIT 可写，采用非敏感局部替换。没有 SQL 方言、虚假 command 文档、Nacos 经验库、Gateway、数据库、调度器、提案存储或新增编排框架。

调用链：UI/AI → ConnectionService/NacosService → 原 Worker 通信 → ConfigurationService/NamingService → NacosHttpClient。ConnectionService 保留连接/generation 所有权；operation-runtime/ExecutionStore 保留操作生命周期与记录。Nacos 只保存目标、动作、MD5/变更摘要及安全结果，不保存正文。完整详情通过 v1 show=all 一次取得正文及 MD5 基线；写入与删除使用 v2，避免把分开读取的内容/MD5 当成同一快照。

| 计划阶段 | 最终实现与验证 |
| --- | --- |
| A 能力契约 | execution/Explorer/Knowledge/AI/history 按需声明；声明不完整拒绝；无文本文档来源不声明 documentKind；五源注册与缺失能力检查通过 |
| B 公共 UI/请求 | SQL 树与目录导航分离；latest 请求范围；共享列表、确认/弹窗、导航保护、编辑扩展；SQL/Redis/Kafka 与竞态 UI 回归通过 |
| C Nacos 读取 | 连接协议/路径升级、内存认证、分页、资源页与读取工具；真实 2.4.3 的配置/历史/监听者/服务/实例通过 |
| D 人工/AI 写入 | 签名预览、CAS、删除前版本核对、SIT 与敏感字段保护、unknown 不重放；真实双账号权限、跨环境人工写与 AI 拒绝通过 |
| E 冗余/打包 | Worker 匹配/取消/超时清理、生产 family registry、知识分发、可信工具身份抽取；中英文文档与包闭包验证通过 |

阶段表描述最终集成代码，不能据此宣称五个中间版本分别通过门禁。本轮没有重建 A–E 五个可独立构建的历史提交，交付为集成源码快照；这是相对原计划的提交粒度偏差。

## 公共复用与删除的旧路径

| 公共能力 | 实际消费者与边界 |
| --- | --- |
| createRequestScope.latest / usePagedList identity | Kafka 详情/分页、Redis Key 读取、经验搜索、Nacos 资源请求；源仍解释分页协议与草稿版本 |
| ResourceList | SearchTree 的原 Redis/Kafka 列表及 Nacos 列表/详情；只收敛状态与控件外围，不解释资源行 |
| DialogFrame / ConfirmWriteDialog | 连接确认、既有写确认与 Nacos 差异确认；业务目标/权限提示仍由源提供 |
| useNavigationGuard / navigation.beforeClose | Redis 脏 Key、Nacos 配置草稿、连接/会话离开与程序关闭；SQL 已自动保存文本不新增虚假 dirty |
| useEditorHost / textEditorExtensions | Redis、Kafka、Nacos；原 Redis/Kafka 字符限制不变，SQL 方言与补全独立 |
| workerExchange | ConnectionService 的业务 dispatch、RPC、首次握手；SQL 进度、事务/缓存、Redis 取消与 Kafka 回执分类保留 |
| provider-registry | 生产 SQL/Redis 分层注册与其测试；删除旧合并 registry 及包内容 |
| knowledge-dispatch / ai-tool-context | Redis/Kafka 知识分发及 SQL/Redis/Kafka/Nacos 工具身份；没有另一套执行/编排路径 |

旧 Nacos probe 与仅测试消费的 URL/探测计划包装已删除，测试直接验证生产 NacosHttpClient 和真实 Worker。

HTTPS 使用 Node 原生传输显式合并默认与系统证书信任库，不改变进程全局 TLS 设置；认证、超时、取消、响应上限与错误转换仍由同一个 NacosHttpClient 处理。没有增加私有 CA 配置或降低证书校验。

SQL schema/cache/focus/pending 导航控制移入 client/sql；每连接导航状态共享，旧 generation 缓存在新资源请求的 passive effect 前失效。修复了迁移过程中出现的新请求被旧缓存清理取消的问题。旧 UI 夹具同步生产 SQL context 与标准执行身份，不放宽生产契约。

真实 API 暴露并修复的差异：CAS 冲突是 HTTP 500/code 20005；不存在的 show=all 可能返回空成功体；blur 搜索必须补匹配模式，普通 app 搜索现在能匹配 app.yaml。GET 403 只对明确 token expired 重试一次，写入不重试。

## 验证证据

| 层级 | 结果 | 证据/范围 |
| --- | --- | --- |
| 类型、单元、构建 | PASS，823/823 | artifacts/nacos-check.log；npm run check；包含权限/签名/过期/敏感保护/UTF-8 上限/HTTP 错误/Worker 清理/预派发无写回执 |
| Nacos 受控 UI | PASS | artifacts/nacos-ui.log，artifacts/ui/nacos/result.json；树/页面 Namespace 与功能双向导航、脏关闭/连接取消、预览取消、确认发布、Namespace 历史 Diff、监听者不重复读取、自定义集群、generation/卸载晚到回复 |
| SQL 受控 UI | PASS | artifacts/nacos-sql-ui.log；MySQL/Oracle 原页面、导航、保存/执行边界、历史与经验 |
| Redis / Kafka / 公共来源 | PASS | artifacts/nacos-redis-ui.log、nacos-kafka-ui.log、nacos-source-ui.log；真实模块与受控桥接/Worker |
| 工作区竞态/执行边界/网格 | PASS | artifacts/nacos-races.log、nacos-boundary.log；现有脚本的完整结果 |
| 包闭包 | PASS | artifacts/nacos-package.log；test:package-closure；Host ESM、client factory、Nacos Worker 相对导入与依赖闭包 |
| 真实 Nacos | PASS | artifacts/nacos-live.log、artifacts/nacos-live/run-*/result.json；固定 2.4.3，一次性 Namespace/资源，真实 ConnectionService/Worker 与专用 r/rw 两账号 |
| 安装后的 DSH Web | PASS | artifacts/nacos-host.log、artifacts/host/latest.json；已安装 Harness 0.2.0-rc.2 ASAR Node runtime，隔离 profile 安装本轮 tgz，真实 Loader/HTTP/UI 和本轮 Nacos fixture |

真实 Nacos 覆盖：认证、人工新增、完整读取/模型脱敏、远端只读账号拒绝写、SIT AI 局部更新保留密码、casMd5 冲突、旧基线拒绝、普通 Data ID 包含搜索、历史详情、监听者 GET 采样、服务/实例分页、AI 服务详情含一个集群实例、跨连接/Namespace/Group 同名资源隔离、自定义路径（透明 HTTP 转发）、UAT/PVT 人工发布与 AI 写拒绝、确认删除、记录不含正文。

真实回执故障使用本轮 HTTP 转发器：Nacos 实际消费写入后丢弃回执，记录保持 unknown；新读取看到变更但不追认原写成功，原请求未再次派发。恢复测试使用新的读取基线和新预览，是另一条明确操作。

安装后验证覆盖表单测试/连接、配置新增/修改的预览确认、历史、监听者、HTTP 伪造 actor 与过期 generation 拒绝、读取和删除。该验证使用安装目录的真实 Host/Loader 与浏览器，不能等同于用户日常 Desktop profile 或模型自主调用。

## NOT_RUN 与剩余限制

- 正向 HTTPS 系统受信证书与认证关闭的真实 Nacos：NOT_RUN。HTTP/匿名握手、取消、401/403、令牌刷新、重定向、超限等有受控测试；不能替代这两项真实环境证据。
- 活跃 Nacos 监听客户端、真实令牌到期过程、大规模资源持续压力：NOT_RUN。采样接口读取成功不证明配置已生效。
- 真实模型调用与 callId 关联、用户 Desktop profile 重启：NOT_RUN。没有修改日常 profile。
- 本轮重新实连 SQL/Redis/Kafka 业务服务器：NOT_RUN；现有单元与受控 UI 回归通过。
- 预览不能无副作用地证明远端 WRITE 权限，明确在执行时由 Nacos 校验。新增/删除仍有远端并发窗口，不声称原子条件操作。
- 敏感检测不能识别任意未知业务秘密。未知格式、语法歧义、YAML 引用/标签、重复字段、Properties 转义/续行与加密编辑保守拒绝 AI。人工发布 JSON、YAML、Properties 时同样做语法校验；Text 与删除不校验正文。这与 AI 的敏感内容限制是两件事。
- 预览复用拦截依赖既有 ExecutionStore 的记录保留范围，无第二套持久状态。
- 不实现 P1/P2。没有发布远端 release 或替换用户日常安装。

## 重跑

npm run check
npm run test:nacos-ui
npm run test:sql-workspace
npm run test:workspace-ui
npm run test:source-module
npm run test:workspace-races
npm run test:kafka-tree
npm run test:execution-boundary
npm run test:package-closure

真实脚本必须指向专用、可写的 Nacos 2.4.3 fixture，不能指向生产实例。NACOS_TEST_PORT 指定本机端口；测试固定使用 fixture 管理账号 nacos/nacos，创建随机 Namespace 与 dsh-reader/dsh-writer 专用账号。所有凭据仅为本轮测试值。test:host 同时设置 DSH_DESKTOP_APP、DSH_TEST_BROWSER=msedge、DSH_TEST_NACOS=1。Windows 测试 TEMP/TMP 指向工作区 artifacts/nacos-design-review-temp，避免沙箱临时目录权限干扰。

测试容器 dsh-nacos-p0-243-20261010（label dsh.test=nacos-p0，127.0.0.1:9997→8848）只归本轮测试所有，镜像 digest 为 sha256:00774155ca5816f81d8bdc9e3a73d2f41f40542c3bc47bbce7791d1cec9d3fae。交付收尾清理该容器；重跑须重新准备专用 fixture。证据保留在被 Git 忽略的 artifacts，验收脚本与本记录进入源码。


## 2026-10-12：六类配置校验与发布对比补充

本节记录本轮源码及独立验收，前文 2026-10-10 的安装记录不代表本轮新代码已安装。

- 统一 `nacos-config-types` 的类型、YML 别名、远端类型优先和未知类型提示；编辑器、历史、Diff、Host 和 AI 参数共用。六类为 YAML、JSON、Properties、XML、HTML、Text，不增加 TOML/INI 专用支持。
- 复用 yaml/jsonc-parser，新增 fast-xml-parser 校验、Lezer XML 原文定位、parse5 HTML 解析和 CodeMirror XML/HTML 高亮。正文始终作为源码显示，不读取外部实体、不执行 HTML 脚本、不自动格式化。
- YAML 每个文档必须为键值对象；JSON 严格语法和重复键；Properties 按 Java Unicode 转义规则校验并处理文末续行；XML 检查根、标签、属性、实体及命名空间；HTML 按 HTML 文档/片段解析。Text 不做格式检查，未知类型明确未校验。
- 发布对比使用统一只读组件：错误原文范围与行标红、行尾安全原因、最多 100 个问题可点击定位。无效草稿仅生成本地 Diff，不调用远端预览，也不能提交。返回修改保留目标/格式/正文并恢复焦点。
- 打开对比即可用上下键循环定位，同时定位两侧；上下按钮使用相同逻辑。断开或换代撤销旧预览，保留脏草稿。删除不校验正文。
- XML/HTML AI 修改沿用原 Host 入口、SIT 权限、预览签名、CAS、unknown/no-replay。原文范围识别直接/间接敏感字段、实体编码值、CDATA、注释及凭据模式；HTML 脚本/样式/事件/模板等不透明内容保护。DTD、自定义实体和无法可靠定位的自动修复结构拒绝 AI 正文/修改。非敏感唯一局部替换后复验并比较敏感原文；Text 保留保守边界。
- Host/Worker 的 Nacos provider 在既有边界打包共享格式模块，修正源目录与 lib 目录相对层级差异；没有额外 HTTP 路由、状态层或重复写入流程。

| 验证层级 | 结果 | 本轮证据 |
| --- | --- | --- |
| 类型、单元、构建 | PASS | `artifacts/nacos-six-formats-check.log`：880/880，Host ESM 与浏览器工厂构建通过 |
| Nacos 受控 UI | PASS | `artifacts/nacos-six-formats-ui.log`、`artifacts/ui/nacos/result.json`：六类有效/无效预览、定位/返回焦点、首次上下键、纯新增/删除/文末变更/无差异、断开/换代、旧有搜索与页签行为；无 pageerror |
| 主题受控 UI | PASS | `artifacts/nacos-six-formats-theme.log`：三类来源 420/768/1200 浅/深色，Nacos 编辑身份/undo/草稿及自定义 Diff 调色板；Nacos 补充截图覆盖 560px 窄窗口 |
| 安装包闭包 | PASS | `artifacts/nacos-six-formats-package.log`：72 个文件，所有相对导入可达 |
| 真实 Nacos 2.4.3 | PASS | `artifacts/nacos-six-formats-live.log`、`artifacts/nacos-live/run-*/result.json`：25 项；六类人工创建/读取/历史/删除，四类人工更新与 XML/HTML SIT AI 更新，两账号权限、脱敏、CAS、UAT/PVT 拒绝、回执丢失 unknown/no-replay |
| 本轮实际 DSH 安装 / 真实模型自主调用 | NOT_RUN | 本轮没有替换用户安装；受控 UI 与真实 Host/Worker→Nacos 调用分别记录，不能替代安装后及模型端验收 |

截图：`artifacts/ui/nacos/invalid-preview.png`、`invalid-preview-dark.png`、`invalid-preview-narrow.png`、`xml-preview.png`、`html-preview.png`。

复跑说明：最初受限网络下的既有失败不能直接归因于产品；允许本机通信后完成完整检查。曾有一次并发全量运行中既有 HTTP 回执测试失败，独立与最终全量均通过；一次 UI 导航等待超时重跑通过，未据此声称已定位环境根因。安装包实际检查曾揭示共享模块相对路径问题，已修复并重新验证。

真实测试只操作本轮专用 `dsh-nacos-243-formats-test` 容器（label `dsh.acceptance=nacos-six-formats`，固定镜像 `nacos/nacos-server:v2.4.3`，随机 loopback 入口），没有修改日常 8848 的 Nacos 2.5.1。脚本已删除随机 Namespace/服务，交付前清理专用容器。HTTPS、认证关闭、活跃监听客户端、长期压力及本轮 SQL/Redis/Kafka 真实服务器回归仍为 NOT_RUN，沿用前述边界。

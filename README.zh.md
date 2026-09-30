# DSH Database

[![MIT](https://img.shields.io/badge/license-MIT-0B7285?style=flat-square)](LICENSE)
[![DSH](https://img.shields.io/badge/DSH-Web-5B4CF0?style=flat-square)](cordis.patch.yml)
[![stars](https://img.shields.io/github/stars/zhuoxiaoshuai/dsh-database?style=flat-square)](https://github.com/zhuoxiaoshuai/dsh-database)

**DeepSeek Harness 的 MySQL、Oracle、Redis、Kafka 工作台：人和模型共用连接、文档、执行、结果和记录。**

🚀 一个「数据库」页签 ｜ 四种源 ｜ 同一条执行路

[为什么存在](#为什么存在) ｜ [怎么比](#和其他做法比) ｜ [亮点](#亮点) ｜ [实际效果](#实际效果) ｜ [快速开始](#快速开始三步完成) ｜ [数据源](#数据源) ｜ [工作原理](#工作原理) ｜ [限制](#配置与限制)

🌐 [English](README.md) ｜ **中文**

当前版本 **0.1.0-alpha.12.15**。隔离 profile 的证据不能当成生产声明。

> 如果这个插件有用，点个 Star 方便其他 DSH 用户找到。

> [!IMPORTANT]
> **SIT 会把查询单元格原值送给模型。** UAT / PVT 拒绝 AI 写入。密码不会回到浏览器快照。每条已保存连接都等于把该账号交给 Host 进程。详见 [SECURITY.md](SECURITY.md)。

## 为什么存在

DeepSeek Harness 已经在会话旁边推理。常见摸库方式却把这条路打断：

- **把 SQL 贴进对话。** 模型看见（或编造）连接串，打不开目录，取消不干净，还会覆盖你正在改的文本。
- **旁边开着 Navicat。** 模型是瞎的。你截网格图。没有共用历史。
- **做成四个小插件。** 每个都抄一套 AI Query 和历史。Redis 被假扮成 SQL。Kafka peek 悄悄进了业务消费组。

这个插件在会话里放**一个「数据库」页签**。人和模型共用同一条连接、同一份文档、同一次执行记录、同一份结果。Redis 还是 Redis。Kafka peek 用一次性 `dsh-peek-*` 组、`autoCommit: false`，不提交 offset。

社区里 star 高的插件（Vision Toolkit、Vision Router）卖的是**边界**：谁是大脑、像素留在哪、什么数据离开本机。数据库插件做同样的事：**Driver 和秘密留在 Host，文档留在工作台，原生语义留在各源模块。**

## 和其他做法比

| | 贴进对话 | 外部 IDE | 这个插件 |
| --- | --- | --- | --- |
| 模型能否跑你看见的内容 | 只有贴出去才行 | 不能 | **AI Query** 就是那份文档 |
| 人能否接管 | 和下一个 token 打架 | 无 | 一打字 `controller: user`，AI 不能覆盖 |
| Redis / Kafka | 假装是 SQL | 另买工具 | SCAN 游标 / 有界 peek |
| 秘密 | 经常进上下文 | 本地文件 | 只在 Host；Windows DPAPI；快照里剥掉 |
| 环境 | 无 | 无 | SIT 可写 / UAT·PVT 只读 / DDL 人工闸 |
| 取消 / 超时 / 未知 | 看聊天状态 | 看工具 | 执行状态是一等对象 |

**一句话：** 不是 SQL 聊天机器人，也不是第二套 Navicat。是会话旁的工作台，模型是同一条路上的同事。

## 亮点

- **按你本来的方式打开表。** 左目录，右页签（总览 / 查询 / **AI Query** / 经验 / 历史）。四种源，一套外框。
- **模型跑的是你的文档，不是影子副本。** 点历史即打开当时那份文本。其他连接上的活动只出提示条，不抢当前连接。
- **输入即接管。** `ExecutionDocument` 有 `text`、`context`、`revision`、`controller`。人一改，`controller` 变成 `user`。交还之前 AI 发布会被拒绝。运行还核对 revision，过期页签打不出去。
- **浏览器不加载 Driver。** mysql2、oracledb、redis、kafkajs 只在 Host Worker 里。客户端走带认证的插件 HTTP。
- **环境是闸，不是徽章。** SIT 跟数据库账号（AI 可 DML / `redis_execute`）。UAT / PVT：类生产连接只读，AI 禁写。
- **分页跟源走，单元格说实话。** SQL 用 `LIMIT` / `OFFSET FETCH`。Redis 用 SCAN（空页会发生，界面会说）。Kafka peek 有界。BIGINT 和精确小数是字符串。BLOB 是 `[BLOB n bytes]`，不把二进制倒进对话。
- **秘密留在 Host。** 「记住密码」默认关。Windows 用当前用户 DPAPI，密钥走 stdin 不走命令行。加密记住密码只在 Windows。自定义 CA 同样剥离。

本项目两层：

1. **抽出的工作台** — Workspace、AI Query、接管、执行、History、Knowledge、外框。一次。
2. **数据源模块** — 协议、对象、授权、结果形状。现在四个；新源应抄 Kafka（`standard` + `standard-text`），不要克隆 MySQL。

```sh
npm pack
dsh plugin --profile web add ./dsh-database-0.1.0-alpha.12.15.tgz
```

**目录**

- [为什么存在](#为什么存在)
- [和其他做法比](#和其他做法比)
- [亮点](#亮点)
- [适合谁用](#适合谁用)
- [实际效果](#实际效果)
- [快速开始：三步完成](#快速开始三步完成)
- [数据源](#数据源)
- [工作原理](#工作原理)
- [配置与限制](#配置与限制)
- [常见问题](#常见问题)
- [还想知道的](#还想知道的)
- [开发与社区](#开发与社区)

## 适合谁用

1. 已经泡在 DeepSeek Harness 里，希望 MySQL / Oracle / Redis / Kafka **就在会话旁边**，而不是模型看不见的另一个窗口。
2. 希望模型和人跑**同一份** SQL、Redis 命令或 Kafka peek：能打开、改、接管，而不是再做一套 Agent 控制台。
3. 在意 peek 不进业务消费组、Redis `MULTI` 不粘在 Key 浏览上、以及 `9007199254740993` 不会变成 `9007199254740992`。

## 实际效果

### 四个源，一棵树

<p align="center">
  <img src="docs/screenshots/workbench.png" alt="同一棵连接树里的 MySQL、Oracle、Redis、Kafka" width="100%" />
</p>

*左：MySQL、Oracle、Redis、Kafka 连接。右：Kafka Topics。查询页签、AI Query、经验库是同一套外框。*

### Kafka Topic 元数据

<p align="center">
  <img src="docs/screenshots/kafka-topic.png" alt="Kafka Topic 分区、副本因子、水位" width="100%" />
</p>

*分区、副本因子、Leader、水位。Peek 用临时消费者，不加入业务消费组、不提交 offset。*

### Redis Key 和值

<p align="center">
  <img src="docs/screenshots/redis-keys.png" alt="Redis Key 浏览、TTL 与 JSON 值" width="100%" />
</p>

*SCAN 树、类型、TTL、JSON 值。命令台是另一个页签、另一条连接，所以 `SELECT` / `AUTH` / `MULTI` 不会留在浏览连接上。*

### MySQL 结果网格

<p align="center">
  <img src="docs/screenshots/mysql-results.png" alt="MySQL 结果网格，BIGINT 按字符串" width="100%" />
</p>

*BIGINT 和精确小数按字符串展示。单元格不当 HTML 执行。*

### Oracle 目录

<p align="center">
  <img src="docs/screenshots/oracle-catalog.png" alt="Oracle Schema 目录" width="100%" />
</p>

*Schema 树（大小写不敏感）。和 MySQL 同一套 SQL 工作台；Service Name / SID、分页、类型跟 Oracle。*

截图是当前工作台。连接名和样例行是一次性夹具，不是业务集群。

## 快速开始：三步完成

### 1. 安装

需要已能运行的 DSH（`dsh web`），Node.js ≥ 24。

```sh
npm pack
dsh plugin --profile web add ./dsh-database-0.1.0-alpha.12.15.tgz
```

装到 npm 之后：

```sh
dsh plugin --profile web add dsh-database
```

使用 **DSH Desktop 桌面版**？桌面版自带 `dsh`，但有意不写入系统 PATH。请从托盘打开 **DSH 终端**：

```sh
dsh plugin --profile desktop add ./dsh-database-0.1.0-alpha.12.15.tgz
```

然后重启 Desktop。`npm run install:desktop` 会把 tarball 装进 profile（设置 `DSH_DESKTOP_APP` 为安装根目录，不链源码）。

安装由包内 `cordis.patch.yml` 挂载。不要再往 profile patch 手写同一行。卸载：`dsh plugin --profile web remove dsh-database`。

### 2. 重启并打开页签

重启正在运行的 Web Profile。在会话里打开「**数据库**」页签，添加连接，先 **测试** 再 **连接**。编辑失败会保留原来的活动会话。

### 3. 跑一条人能接管的操作

- MySQL / Oracle：打开一张表或跑 SQL。历史按对话隔离。
- Redis：选一个 DB，浏览 Key，或在命令台跑一条命令。
- Kafka：打开 Topic，再对一个分区做有界 peek。

模型和人用同一份文档。人一打字就接管。

## 数据源

各源复用上面的工作台。表是地图，下面各章只写真实差异。

| 源 | 最适合问的问题 | 主要结果 |
| --- | --- | --- |
| MySQL | 这个库 / 表里有什么？跑这条 SQL。 | 目录、`SHOW CREATE`、结果网格 |
| Oracle | 一样，对着 Service / SID 的 Schema | Schema 树、`OFFSET FETCH` 网格 |
| Redis | 这个 Key 是什么？跑这条命令。 | SCAN 树、类型、TTL、值 |
| Kafka | 这个 Topic 上有什么？ | 分区、水位、有界 peek |

### MySQL

关系型 SQL。对象：**数据库 → 表 → 列**。标识符用反引号。分页：`LIMIT … OFFSET …`。系统库（`mysql`、`information_schema`、`performance_schema`、`sys`）保持可见。默认类型：`VARCHAR(255)` / `BIGINT`。

- **连接：** host / port / 用户 / 密码，默认 3306。Driver `mysql2` 在 Host Worker。
- **目录：** 树、搜索、对象页。字段、索引、约束，以及账号有权读取的 `SHOW CREATE`。读不到给原因，不当作零。
- **查询：** SQL 编辑器，格式化，取消（不断开共享登录）。SELECT 走库端筛选 / 排序 / 分页。默认 100 行，最多 500 行、1 MiB，单请求 30 秒。
- **写入：** 参数化增改删，预览后一次确认，主键定位并核对原记录。冲突回滚并保留草稿。DDL 最多 20 步，审批 5 分钟一次消费；破坏性操作在同一窗口填写目标名。首错停止，不承诺 DDL 整体回滚。InnoDB 锁等待在一次性 8.4 容器上验过。
- **AI：** `database_execute_sql`，SIT 最多 8 条（每条 100 行，可含 DML），首错停止。

### Oracle

和 MySQL 同一套 SQL 工作台，方言不同。对象：**Schema**（大小写不敏感）。有用户名时默认落到该 Schema。标识符用 `"`。分页：`OFFSET … ROWS FETCH FIRST … ROWS ONLY`。`EXPLAIN PLAN FOR`。支持 q-quote，不支持 `#` 注释。

- **连接：** Service Name 或 SID，端口 1521，Thin 模式。SID 未验收。Driver `oracledb`。
- **目录 / 查询 / 写入：** 与 MySQL 走同一条平台路径。列注释是独立字典。默认类型：`VARCHAR2(255)` / `NUMBER(19)`。
- **限制：** 视图、同义词只看元数据。含 LOB 的查询不支持。19c、SID、时间字段维护未验收。Free 23 Thin 不替代 19c。

### Redis

不是 SQL。对象：**DB → Key**，加上类型和 TTL。一页是 **SCAN 游标**（可能空页和重复；界面去重并提示尚未扫完）。需要 Redis 7.2+。

- **连接：** 单机、一台哨兵或一个集群种子。可选 ACL、TLS、自定义 CA。哨兵用一个地址问主库；用户名密码同时用于哨兵和 Redis。集群把主机当种子，DB 固定 0。
- **两条连接是故意的：** 每次一条 Redis CLI 引号命令，跑完即关。不经 Shell。
- **Key：** String / Hash / List / Set / ZSet / TTL，大集合分页，设/删 TTL，删除，编辑基础值。二进制显示 Base64。
- **Host：** `DSH_REDIS_COMMAND_BLACKLIST`（默认空）。AI 的 `redis_execute` 仅 SIT；UAT/PVT 只留 status / keys / 读值。
- **未验收：** Cluster / Sentinel 对着业务集群。

### Kafka

只读观察。对象：**Topic / 分区 / 已有消费组**。Peek 是对**一个**分区的有界读取。不加入业务消费组，不提交 offset。

- **连接：** 无认证、TLS + 自定义 CA、SASL PLAIN、SCRAM-SHA-256 / 512。PLAIN/SCRAM 可不启用 TLS；启用 TLS 时必须验证书（不提供跳过验证）。Kerberos、OAuth、客户端证书不在范围内。
- **工作：** 列出 Topic、查看分区、有界 peek。结果是消息和元数据，不是 SQL 网格。
- **不做：** 发消息、建删 Topic、改配置、移动消费位置。
- **接入形态：** 客户端 `standard` + Host `standard-text`。新源应抄这条，不要抄 MySQL。

## 工作原理

这是一套**抽出的数据源平台**，不是四个迷你 IDE。加一种源不是再复制一套产品。拿掉一种源，平台仍然成立。

### 一次运行怎么走完

```mermaid
flowchart LR
  UI["工作台 / AI Query"] --> Doc["文档 text + context + revision + controller"]
  Doc --> Auth["Host 授权：会话、generation、SIT/UAT/PVT、actor"]
  Auth --> Worker["Worker 白名单：mysql2 / oracledb / redis / kafkajs"]
  Worker --> Proj["源结果投影"]
  Proj --> Chrome["公共结果外框 + 执行记录"]
  Chrome --> Hist["对话历史"]
```

1. 「数据库」页签挂在 DSH 右侧栏。连接在工作区文件；查询页签和 AI 文档按对话隔离，两个会话不会共用一份脏编辑器。
2. 浏览器不加载 Driver。走带认证的 `/plugins/database/...`。没凭证就是 401。
3. Host `ConnectionService` 绑死当前会话、连接 `generation`（重连会作废进行中的请求）、环境。actor 只有 `user` / `ai`，浏览器不能伪造可信 AI 身份。
4. 源模块把文本变成 **worker action + input**（`prepareText` 或 SQL 适配）。Runtime 再对白名单。Kafka 只允许它解析出来的读操作，不会去发消息。
5. Worker 带取消和截止时间。Peek 创建 `dsh-peek-{uuid}`，`autoCommit: false`，seek 到 offset，然后 stop/disconnect。Redis 命令台每次独立连接、一条 CLI 引号命令、立刻关掉——`SELECT` / `MULTI` 不会留在 SCAN 上。
6. 会撑破 JS 安全整数的值在 **Driver** 就变成字符串：MySQL `supportBigNumbers` + `bigNumberStrings`；Oracle NUMBER／时间 `fetchTypeHandler` → STRING。然后 `formatFetchedValue` 把 BLOB 写成 `[BLOB n bytes]`，不把二进制倒进对话。所以 `9007199254740993` 还是这串数字。
7. 一次执行一条记录：身份、状态、事件。成功 / 失败 / 取消 / 空 / 部分 / **未知**（写入超时后库端可能已经生效——界面写未知，不假装已回滚）。

### 人和模型共用的那份文档

标准源（Redis、Kafka）用 `ExecutionDocument`：`{ text, context, revision, controller }`。

- 只有 `controller === 'ai'` 时模型才能写这份文档。人一打字变成 `user`（`user-edit`）。交还前 AI 再发布会被拒绝：「用户已接管 AI Query」。
- 交还是显式的（`return-ai`）。运行要求 `controller === 'user'` 且 revision 对得上，漏了远程改动的页签打不出去。
- `context` 也是文档的一部分（Redis DB；Kafka 目前没有额外目标）。换 DB 会加 revision、**保留**控制权，并取消旧请求作用域。

SQL 仍走 `SharedQuery`，但在同一个 AI Query 页签上（兼容路径：同一套接管和历史）。产品承诺一样：**一份文档、一次运行、一条记录。**

`SourceWorkspace` 是公共外框：总览 / 查询 / AI Query / 经验。源只提供 Editor、Result、`runText` 和树绑定，不再包第二套工作台。

### 抽出什么、原生留下什么

```mermaid
flowchart TB
  subgraph dsh [DeepSeek Harness]
    Tab[数据库页签]
  end
  subgraph platform [只实现一次]
    Conn[连接外壳 / 秘密 / SIT UAT PVT]
    WS[工作区 / 文档 / 页签]
    EX[执行身份 / 取消 / 记录]
    AI[AI Query / 接管 / 修订]
    KN[经验发布]
    UI[公共树 / Toolbar / 结果外框]
  end
  subgraph modules [数据源模块]
    MySQL
    Oracle
    Redis
    Kafka
  end
  subgraph host [Host Worker]
    W[Driver 不进浏览器]
  end
  Tab --> Conn
  Conn --> WS
  WS --> modules
  AI --> WS
  UI --> WS
  modules --> EX
  EX --> W
  EX --> KN
```

| 只实现一次 | 留给各源 |
| --- | --- |
| 页签、添加/测试/连接、DPAPI、对话隔离 | host/port vs Service/SID vs SASL vs Redis 模式 |
| 页签外框、Loading/Error/Empty、结果框 | 树：库 / Schema / DB / Topic |
| 执行身份、取消、历史 | `LIMIT`、SCAN 游标、peek offset |
| AI Query、接管、修订 | 命令语言、授权、AI 参数 → 原生文本 |
| `knowledge.json` 发布（人工确认） | 指纹 / 分析按源 |

**不要求**每个源都有 `database`、每棵树都是 Schema/Table、每个结果都是二维表。

| 源 | 客户端 | Host 执行 | 为什么 |
| --- | --- | --- | --- |
| MySQL | `legacy-sql` | `legacy-adapter` | 目录、批量、InnoDB DML/DDL 网格、事务——仍走 SQL 兼容路径 |
| Oracle | `legacy-sql` | `legacy-adapter` | 同一条路；方言管标识符、`OFFSET FETCH`、注释 |
| Redis | `standard` | `legacy-adapter` | 标准页签；命令隔离和 SCAN 仍走 Redis 适配 |
| Kafka | `standard` | `standard-text` | `normalizeContext` / `prepareText` / `authorize` → Worker 白名单。**新源抄这条。** |

经验保存不执行。试运行走同一条授权。旧 `sql-templates.json` 仍会读入 `knowledge.json` 一次。

一直守着的：同一业务状态一个权威来源；AI 和人是同一条流水线；失败要可见；不为了代码整齐去统一 Kafka offset 和 Redis SCAN；加一种源原则上不改 MySQL。

更细的说明：[docs/README.md](docs/README.md)、[架构](docs/data-source-architecture.md)、[接入指南](docs/data-source-onboarding.md)。

## 配置与限制

### 环境

| 环境 | 人工 | AI |
| --- | --- | --- |
| SIT | 跟账号权限 | 单元格原值；允许 DML；允许 Redis `redis_execute` |
| UAT / PVT | 类生产连接只读 | 禁写；拒绝 Redis execute |
| DDL | 人工确认 | 不自动跑 |

未识别或 `staging` 会 fail-safe 成 **UAT**（AI 和类生产连接只读）。详见 [SECURITY.md](SECURITY.md)。

### 不宣称的

- 视图、同义词只看元数据。含 LOB 的 Oracle 查询不支持。
- Oracle 19c、SID、时间字段维护未验收。
- Redis Cluster / Sentinel、真实业务集群未验收。
- Kafka 不发消息、不改 offset，不支持 Kerberos / OAuth / 客户端证书。
- 现用 Desktop GUI 与真实模型 callId 关联仍为未跑。

| 环境 | 说明 |
| --- | --- |
| Node.js | ≥ 24；隔离加载用 Desktop 内置 Node |
| Harness | 已验证 `0.1.2-rc.1`、`0.1.7-rc.2`、`0.2.0-rc.2` |
| MySQL | 8.4.x 临时容器；8.0.32 仅只读核对 |
| Oracle | Free 23 Thin 模式，不替代 19c/SID |
| Redis | 8.10.2 一次性容器 |
| 驱动 | mysql2 3.24.4、oracledb 7.0.1、redis 6.2.1、kafkajs 2.2.4 |

## 常见问题

| 问题 | 处理方式 |
| --- | --- |
| `/plugins/database/connections` 冲突 | 不要同时安装仍内嵌数据库工作台的旧 remote-exec。本插件与 `dsh-remote-exec` 可以并存 |
| Desktop 提示找不到 `dsh` | 从托盘打开 **DSH 终端**；桌面版不把 `dsh` 写入 PATH |
| add 之后看不到插件 | 重启 Web Profile 并刷新。确认没有手写重复的 `cordis.patch.yml` |
| Oracle 查询碰到 LOB 列失败 | 当前版本不支持；视图/同义词只看元数据 |
| 命令台里 `SELECT` 了，Key 树没变 | 预期行为：命令台用完即关连接；在树里选 DB |
| Kafka peek 会不会带动业务消费组 | 不会。Peek 用临时 `dsh-peek-*` 组、`autoCommit: false`，然后断开 |

## 还想知道的

**模型会看到密码吗？**

不会。密码和自定义 CA 从连接快照、日志、查询历史和给模型的输出里剥掉。记住密码（Windows 当前用户 DPAPI）也不会回到浏览器。

**模型会看到行数据吗？**

**SIT 会**——单元格原值送给模型。这正是让模型看结果的意义。类生产连接用 **UAT / PVT**：AI 禁写，也拒绝 Redis execute。

**这能替代 Navicat 吗？**

不能。这是 DSH **里面**的工作台：目录、查询、AI Query、历史就在会话旁。重型 DBA 工作仍该用专用客户端。这里的受控 DML/DDL 是参数化、预览、确认闸，不是第二套通用 SQL IDE。

**能加 PostgreSQL / Mongo / ES 吗？**

平台是按这个建的：抄 Kafka 的 `standard` + `standard-text`（描述、Worker、授权、explorer、经验）。不要克隆 MySQL。本包今天没有 PostgreSQL/Mongo/ES 实现。

**Kafka peek 断开很慢？**

Worker 会带超时地 stop/disconnect 临时消费者。清理失败就回收 Worker（`recycleWorker`），避免死连接上漏一个组。

## 开发与社区

```sh
npm ci --legacy-peer-deps
npm run check
```

实库脚本会创建带唯一标签的临时 Docker 容器并删除。不要对着业务库跑。

```sh
npm run test:mysql
npm run test:oracle
DSH_TEST_REDIS=1 npm run test:host
DSH_TEST_DATABASES=1 npm run test:host
```

隔离宿主：`DSH_DESKTOP_APP=... npm run test:host`。`DSH_TEST_ALLOW_VERSION` 仅用于诊断。

- Bug 和使用问题：[GitHub Issues](https://github.com/zhuoxiaoshuai/dsh-database/issues)
- 安全漏洞按 [SECURITY.md](SECURITY.md) 私下报告
- 仓库创建满一天后，向 [awesome-dsh-plugin](https://github.com/awesome-dsh-plugin/awesome-dsh-plugin) 提交 `data/plugins/zhuoxiaoshuai__dsh-database.yml`（Topics 已含 `dsh-plugin`）

```yaml
url: https://github.com/zhuoxiaoshuai/dsh-database
name: zhuoxiaoshuai/dsh-database
category: dev
description:
  en: MySQL, Oracle, Redis, and Kafka workbench for DeepSeek Harness, with a shared execution path for humans and the model.
  zh: DeepSeek Harness 的 MySQL、Oracle、Redis、Kafka 工作台，人和模型共用同一套连接、执行和记录。
```

## 许可证

[MIT](LICENSE)

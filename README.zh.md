# DSH Database

[![MIT](https://img.shields.io/badge/license-MIT-0B7285?style=flat-square)](LICENSE)
[![DSH](https://img.shields.io/badge/DSH-Web-5B4CF0?style=flat-square)](cordis.patch.yml)
[![stars](https://img.shields.io/github/stars/zhuoxiaoshuai/dsh-database?style=flat-square)](https://github.com/zhuoxiaoshuai/dsh-database)

这是 DeepSeek Harness 的插件，不是 `dsh web` 自带的功能。装进 web profile 并重启后，会话右侧会多一个「数据库」页签，用来连接 MySQL、Oracle、Redis 和 Kafka。卸掉插件，`dsh web` 还是原来的样子。

![工作台](docs/screenshots/workbench.png)

截图里的库名、表名是测试数据。

[English](README.md)

## 安装

```sh
npm pack
dsh plugin --profile web add ./dsh-database-0.1.0-alpha.12.15.tgz
```

装完后重启 `dsh web`。需要 Node.js 24 或以上。目前没有发到 npm，只能用上面打出来的 tgz。

卸载：

```sh
dsh plugin --profile web remove dsh-database
```

不要把 `cordis.patch.yml` 再抄进 profile。

桌面版的 PATH 里没有 `dsh`。从托盘打开 **DSH 终端**，把命令里的 `--profile web` 改成 `--profile desktop`。插件是同一份，只是 profile 不同。

## 环境

保存连接时要选 SIT、UAT 或 PVT。填 `dev` / `test` 会当成 SIT，`staging` 当成 UAT，`prod` 当成 PVT。其他写法一律按 UAT 处理。

在 SIT 下，查询结果会原样发给模型。网格改数、DDL 和 `redis_execute` 都可以走，最终仍受库账号权限限制。

在 UAT 和 PVT 下，模型不能写，网格也不能改。SQL 编辑器仍然会自动提交（`lane: manual`）。如果不能接受写入，请用只读账号。

密码只存在 Host 进程里。「记住密码」目前只有 Windows 能用（当前用户 DPAPI，密钥走 stdin），默认关闭。

细节见 [SECURITY.md](SECURITY.md)。

## MySQL

![MySQL 结果](docs/screenshots/mysql-results.png)

驱动是 mysql2，默认端口 3306。对象树按库 → 表 → 列展开。标识符用反引号，分页用 `LIMIT` / `OFFSET`。`mysql`、`information_schema`、`performance_schema`、`sys` 会留在树上。

```sql
SELECT 9007199254740993 AS id;
```

账号有权限时，目录里能看到字段、索引、约束和 `SHOW CREATE`。没有权限时会写出原因，而不是空白失败。

查询的筛选、排序和分页在库端完成。默认返回 100 行，上限是 500 行或 1 MiB，超时 30 秒。取消查询不会断开这次登录。

网格改数走参数化语句：先预览，确认一次，并按主键核对原记录。发生冲突会回滚，草稿还留着。

DDL 最多 20 步，审批有效期 5 分钟。破坏性操作要在窗口里填写表名。某一步失败就停，不会把整段 DDL 当成一次事务回滚。InnoDB 锁等待在一次性 8.4 容器上碰到过。

SIT 下，`database_execute_sql` 最多执行 8 条语句，每条最多 100 行，可以带 DML。第一条出错后，后面的不再跑。

BIGINT 在驱动里就会以字符串返回。BLOB 显示为 `[BLOB n bytes]`。

## Oracle

![Oracle 目录](docs/screenshots/oracle-catalog.png)

SQL 页面和 MySQL 相同。对象按 Schema 组织，大小写不敏感。如果存在与用户名同名的 Schema，默认进入那个 Schema。标识符用双引号；分页用 `OFFSET … ROWS FETCH FIRST … ROWS ONLY`；执行计划用 `EXPLAIN PLAN FOR`。q-quote 可以使用，`#` 注释不行。

驱动是 oracledb Thin，默认端口 1521，连接方式是 Service Name。SID 没有试过。NUMBER 和时间类型按 STRING 取出。视图和同义词只能看元数据。查询如果带 LOB 列会失败。19c、SID 和时间字段维护都没有试过。Free 23 Thin 不能当成 19c 来用。

## Redis

![Redis Key](docs/screenshots/redis-keys.png)

需要 Redis 7.2 或以上。对象树按 DB → Key 展开。SCAN 分页可能出现空页或重复，游标还没结束时界面会标明。

```text
PING
```

支持单机、一台哨兵，或一个集群种子节点。ACL、TLS、自定义 CA 都是可选的。哨兵只填一个地址，用户名和密码在哨兵与 Redis 之间共用。集群模式下，主机字段是种子节点，DB 只能是 0。

Key 浏览和命令台用的不是同一条连接。命令台执行一条 CLI 写法的命令后就会关闭。在命令台里执行 `SELECT` 或 `MULTI`，不会改左边的树。

`redis_execute` 只在 SIT 可用。`DSH_REDIS_COMMAND_BLACKLIST` 默认是空的，实际限制仍看 Redis ACL。Cluster / Sentinel 对着业务集群没有试过。

## Kafka

![Kafka Topic](docs/screenshots/kafka-topic.png)

Kafka 只提供只读能力：列出 Topic、查看分区、peek 一个分区。

```text
PEEK "orders" PARTITION 0 FROM LATEST LIMIT 20
```

把 `"orders"` 换成你实际有的 Topic 名。

认证支持：无认证、TLS+CA、PLAIN、SCRAM-SHA-256 / 512。PLAIN 和 SCRAM 可以不开 TLS；一旦开了 TLS，就会校验证书。不支持 Kerberos、OAuth 和客户端证书。不能发消息、建删 Topic、改配置，也不能挪消费位移。

Peek 使用临时消费组 `dsh-peek-{uuid}`，并且 `autoCommit: false`。这些组不会出现在 GROUPS 列表里。如果 stop 或 disconnect 超时，会丢掉当前 Worker 再开一个新的。

在 AI Query 里输入后，编辑器由你接管；交还之前，模型不能覆盖这份文本。

## 工具

只有给 `database_status` 传了 topic，才会加载工具说明。

| 工具 | 说明 |
| --- | --- |
| `database_status` | 当前已登录的 SQL / Redis 连接，以及 `generation` |
| `database_catalog` | `schemas` / `tables` / `table`。不要用 SQL 去查 `information_schema` |
| `database_execute_sql` | `action=read` 读取当前 AI Query 文本；带上 `sql` 则执行（仅 SIT）。UAT / PVT 只读 |
| `database_templates` | 保存和搜索文本，不会执行 |
| `database_read_collab` | 当前打开的查询页签 |
| `database_import_connections` | 登记主机，不接收密码 |
| `redis_status` `redis_keys` `redis_value` | SCAN、类型、TTL、值 |
| `redis_execute` | 仅 SIT，一次一条命令 |
| `kafka_status` `kafka_topics` `kafka_describe` | Topic、分区、水位 |
| `kafka_peek` | peek 一个分区。如果你已经接管编辑器，会拒绝 |

## 实现

页签挂在 DSH 右侧栏。驱动（`mysql2`、`oracledb`、`redis`、`kafkajs`）只在 Host Worker 里加载。浏览器请求 `/plugins/database/...`，需要带会话 cookie；没有 cookie 会返回 401。

连接写在工作区文件里。编辑器按对话分开。重连会更换 `generation`，正在进行的请求会作废。

Redis 和 Kafka 使用 `ExecutionDocument`（`text`、`context`、`revision`、`controller`）。MySQL 和 Oracle 仍使用 `SharedQuery`，接管规则相同。人一开始打字，`controller` 就会变成 `user`。真正执行时要求 `controller === 'user'`，并且 revision 对得上。actor 只能是 `user` 或 `ai`，页面不能伪造 `ai`。

写入超时会报「未知」：库里可能已经有这条数据了。peek 和查询的超时时间是 30 秒。

MySQL / Oracle 仍走 `legacy-sql` / `legacy-adapter`。Redis 的页面是 `standard`，Host 仍是 `legacy-adapter`。Kafka 是 `standard` + `standard-text`。

更多说明：[文档](docs/README.md)、[架构](docs/data-source-architecture.md)、[加源](docs/data-source-onboarding.md)。加新数据源请抄 Kafka，不要抄 MySQL。

## 限制

- 没有 PostgreSQL、ClickHouse、MongoDB、Elasticsearch，也没有图表
- Oracle 不能查询带 LOB 的列；19c 和 SID 没有试过
- Redis Cluster / Sentinel 没有对着业务集群试过
- Kafka 不能发消息，也不支持 Kerberos、OAuth、客户端证书
- Desktop 图形界面和真实模型 `callId` 没有跑过

## 出了问题

| 现象 | 怎么办 |
| --- | --- |
| `/plugins/database/connections` 冲突 | 旧版 remote-exec 还带着这套页面。现在的 `dsh-remote-exec` 可以一起装 |
| 桌面版找不到 `dsh` 命令 | 从托盘打开 DSH 终端 |
| 插件装了，界面里没有 | 重启对应 profile，刷新页面，不要手写重复的 patch 行 |
| Oracle 查询碰到 LOB 列 | 目前不支持 |
| 命令台里执行了 `SELECT`，左边的树没变 | 在树里选择 DB |
| peek 会不会加入业务消费组 | 不会 |

## 开发

```sh
npm ci --legacy-peer-deps
npm run check
npm run test:mysql
npm run test:oracle
DSH_TEST_REDIS=1 npm run test:host
DSH_TEST_DATABASES=1 npm run test:host
```

这些脚本会启动带标签的 Docker 容器，跑完后删掉。如果要隔离宿主，设置 `DSH_DESKTOP_APP=... npm run test:host`。

问题请提到 [Issues](https://github.com/zhuoxiaoshuai/dsh-database/issues)。安全相关见 [SECURITY.md](SECURITY.md)。

要出现在 [awesome-dsh-plugin](https://github.com/awesome-dsh-plugin/awesome-dsh-plugin) 里，提交 `data/plugins/zhuoxiaoshuai__dsh-database.yml`（仓库 topic 已经有 `dsh-plugin`）：

```yaml
url: https://github.com/zhuoxiaoshuai/dsh-database
name: zhuoxiaoshuai/dsh-database
category: dev
description:
  en: MySQL, Oracle, Redis and Kafka inside DeepSeek Harness.
  zh: DeepSeek Harness 插件，用来连接 MySQL、Oracle、Redis 和 Kafka。
```

## 测过的环境

在 Harness `0.1.2-rc.1`、`0.1.7-rc.2`、`0.2.0-rc.2` 上试过。

驱动版本：mysql2 3.24.4、oracledb 7.0.1、redis 6.2.1、kafkajs 2.2.4。MySQL 用一次性 8.4 容器，另外在 8.0.32 上做过只读核对。Oracle 用的是 Free 23 Thin。Redis 用的是一次性 8.10.2 容器。

## 许可证

[MIT](LICENSE)

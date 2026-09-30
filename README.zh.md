# DSH Database

[![MIT](https://img.shields.io/badge/license-MIT-0B7285?style=flat-square)](LICENSE)
[![DSH](https://img.shields.io/badge/DSH-Web-5B4CF0?style=flat-square)](cordis.patch.yml)
[![stars](https://img.shields.io/github/stars/zhuoxiaoshuai/dsh-database?style=flat-square)](https://github.com/zhuoxiaoshuai/dsh-database)

装在 DeepSeek Harness 里的数据库页。会话里打开「数据库」，连 MySQL、Oracle、Redis、Kafka。

[English](README.md)

## 安装

```sh
npm pack
dsh plugin --profile web add ./dsh-database-0.1.0-alpha.12.15.tgz
```

重启 `dsh web`。Node.js ≥ 24。现在还没发 npm。

卸载：`dsh plugin --profile web remove dsh-database`。别把 `cordis.patch.yml` 再抄进 profile。

桌面版没有 PATH。托盘打开 **DSH 终端**，加 `--profile desktop`。

## 环境

存连接时选 SIT / UAT / PVT。`dev`、`test` 会变成 SIT，`staging` 变成 UAT，`prod` 变成 PVT，乱填也是 UAT。

SIT：查出来的格子原样给模型。网格改数、DDL、`redis_execute` 都能走，还是看库账号有没有权限。

UAT、PVT：模型不能写，网格也不能改。SQL 编辑器照样提交（`lane: manual`）。不想让人改库，用只读账号。

密码只在 Host。「记住密码」只有 Windows 能用（当前用户 DPAPI，密钥走 stdin），默认关。

[SECURITY.md](SECURITY.md)

## 截图

![工作台](docs/screenshots/workbench.png)

![Kafka Topic](docs/screenshots/kafka-topic.png)

![Redis Key](docs/screenshots/redis-keys.png)

![MySQL 结果](docs/screenshots/mysql-results.png)

![Oracle 目录](docs/screenshots/oracle-catalog.png)

图里的名字是测试数据。

## MySQL

mysql2，3306。树是库 → 表 → 列。标识符用反引号，分页用 `LIMIT` / `OFFSET`。`mysql`、`information_schema`、`performance_schema`、`sys` 还在树上。

```sql
SELECT 9007199254740993 AS id;
```

账号有权就能看到字段、索引、约束和 `SHOW CREATE`。没权限会写出原因。

查询在库端做筛选、排序、分页。默认 100 行，最多 500 行或 1 MiB，超时 30 秒。取消查询不会断掉这次登录。

网格改数走参数化：先预览，确认一次，按主键对原记录。冲突就回滚，草稿还在。

DDL 最多 20 步，审批 5 分钟有效。破坏性操作要在窗口里填表名。错了就停，不会整段回滚。InnoDB 锁等待在一次性 8.4 容器上碰到过。

SIT 下 `database_execute_sql` 最多 8 条，每条 100 行，可以带 DML，第一条出错后面就不跑。

BIGINT 驱动直接给字符串。BLOB 显示成 `[BLOB n bytes]`。

## Oracle

SQL 页面跟 MySQL 一样。对象是 Schema，大小写无所谓。有跟用户名同名的 Schema 就默认进那个。标识符加 `"`，分页用 `OFFSET … ROWS FETCH FIRST … ROWS ONLY`，执行计划用 `EXPLAIN PLAN FOR`。q-quote 可以，`#` 注释不行。

oracledb Thin，1521，Service Name。SID 没试过。NUMBER 和时间按 STRING 取。视图、同义词只能看元数据。查询带 LOB 列会失败。19c、SID、时间字段维护都没试。Free 23 Thin 不能当 19c 用。

## Redis

要 7.2 以上。树是 DB → Key。SCAN 分页会空、会重复，没扫完界面会说。

```text
PING
```

单机、一台哨兵、或一个集群种子。ACL、TLS、自定义 CA 可选。哨兵填一个地址，用户名密码哨兵和 Redis 共用。集群把主机当种子，DB 只能 0。

Key 浏览和命令台不是一条连接。命令台跑一条 CLI 写法的命令就关。在命令台里 `SELECT` / `MULTI` 不会改左边的树。

`redis_execute` 只在 SIT。`DSH_REDIS_COMMAND_BLACKLIST` 默认是空的，还是看 Redis ACL。Cluster / Sentinel 对着业务集群没试过。

## Kafka

只读：列 Topic、看分区、peek 一个分区。

```text
PEEK "orders" PARTITION 0 FROM LATEST LIMIT 20
```

Topic 名换成你有的。

认证：无、TLS+CA、PLAIN、SCRAM-SHA-256/512。PLAIN/SCRAM 可以不开 TLS。开了 TLS 一定验证书。没有 Kerberos、OAuth、客户端证书。不能发消息、建删 Topic、改配置、挪 offset。

Peek 用临时组 `dsh-peek-{uuid}`，`autoCommit: false`。GROUPS 列表里看不到这些组。stop / disconnect 超时会把 Worker 丢掉重开。

AI Query 里一打字就接管，交还之前模型盖不掉。

## 工具

给 `database_status` 传了 topic 才会加载说明。

| 工具 | 说明 |
| --- | --- |
| `database_status` | 已登录的 SQL/Redis 连接和 `generation` |
| `database_catalog` | `schemas` / `tables` / `table`。别用 SQL 查 `information_schema` |
| `database_execute_sql` | `action=read` 读当前 AI Query；带 `sql` 就执行（SIT）。UAT/PVT 只读 |
| `database_templates` | 存、搜文本，不执行 |
| `database_read_collab` | 打开的查询页签 |
| `database_import_connections` | 登记主机，不收密码 |
| `redis_status` `redis_keys` `redis_value` | SCAN、类型、TTL、值 |
| `redis_execute` | 仅 SIT，一条命令 |
| `kafka_status` `kafka_topics` `kafka_describe` | Topic、分区、水位 |
| `kafka_peek` | 一个分区。你已经接管编辑器就拒绝 |

## 实现

页签在 DSH 右侧。驱动只在 Host Worker 里加载。浏览器请求 `/plugins/database/...`，没登录是 401。

连接写在工作区文件。编辑器按对话分开。重连会换 `generation`，跑着的请求作废。

Redis、Kafka 用 `ExecutionDocument`（`text`、`context`、`revision`、`controller`）。MySQL、Oracle 还是 `SharedQuery`，接管规则一样。人一打字 `controller` 变成 `user`。运行要求 `controller === 'user'` 且 revision 对得上。actor 只有 `user` / `ai`，页面伪造不了 `ai`。

写入超时报未知——库里可能已经有了。peek 和查询超时 30 秒。

MySQL/Oracle 还走 `legacy-sql` / `legacy-adapter`。Redis 页面是 `standard`，Host 仍是 `legacy-adapter`。Kafka 是 `standard` + `standard-text`。

[文档](docs/README.md) · [架构](docs/data-source-architecture.md) · [加源](docs/data-source-onboarding.md)

加新源抄 Kafka，别抄 MySQL。

## 没做的

- 没有 PostgreSQL、ClickHouse、MongoDB、ES、图表
- Oracle 不能查 LOB，19c 和 SID 没试
- Redis Cluster / Sentinel 没对着业务集群试过
- Kafka 不能发消息，没有 Kerberos、OAuth、客户端证书
- Desktop 界面和真实模型 `callId` 没跑过

## 出问题

| 现象 | 怎么办 |
| --- | --- |
| `/plugins/database/connections` 冲突 | 旧 remote-exec 还带着这套页面。现在的 `dsh-remote-exec` 可以一起装 |
| Desktop 没有 `dsh` | 托盘 → DSH 终端 |
| add 了看不见 | 重启 profile，刷新，别手写重复 patch |
| Oracle 查询碰到 LOB 列 | 不支持 |
| 命令台 `SELECT` 了树没变 | 在树里选 DB |
| peek 会不会进业务组 | 不会 |

## 开发

```sh
npm ci --legacy-peer-deps
npm run check
npm run test:mysql
npm run test:oracle
DSH_TEST_REDIS=1 npm run test:host
DSH_TEST_DATABASES=1 npm run test:host
```

这些脚本会起带标签的 Docker，跑完删掉。隔离宿主：`DSH_DESKTOP_APP=... npm run test:host`。

问题：[Issues](https://github.com/zhuoxiaoshuai/dsh-database/issues)。漏洞：[SECURITY.md](SECURITY.md)。

往 [awesome-dsh-plugin](https://github.com/awesome-dsh-plugin/awesome-dsh-plugin) 交 `data/plugins/zhuoxiaoshuai__dsh-database.yml`（topic 已经有 `dsh-plugin`）：

```yaml
url: https://github.com/zhuoxiaoshuai/dsh-database
name: zhuoxiaoshuai/dsh-database
category: dev
description:
  en: MySQL, Oracle, Redis and Kafka inside DeepSeek Harness.
  zh: DeepSeek Harness 里连 MySQL、Oracle、Redis、Kafka。
```

## 测过什么

Harness：`0.1.2-rc.1`、`0.1.7-rc.2`、`0.2.0-rc.2`。

驱动：mysql2 3.24.4、oracledb 7.0.1、redis 6.2.1、kafkajs 2.2.4。MySQL 用一次性 8.4，另加 8.0.32 只读核对。Oracle 是 Free 23 Thin。Redis 是一次性 8.10.2。

## 许可证

[MIT](LICENSE)

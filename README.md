# dsh-database

MySQL, Oracle, Redis, and Kafka workbench for [DeepSeek Harness](https://github.com/deepseek-ai/deepseek-harness), with a shared execution path for humans and the model.

DeepSeek Harness 的 MySQL、Oracle、Redis、Kafka 工作台，人和模型共用同一套连接、执行和记录。

仓库：[zhuoxiaoshuai/dsh-database](https://github.com/zhuoxiaoshuai/dsh-database)。当前版本 **0.1.0-alpha.12.15**。

## 安装

需要已能运行的 DSH（`dsh web`），Node.js ≥ 24。

```sh
npm pack
dsh plugin --profile web add ./dsh-database-0.1.0-alpha.12.15.tgz
```

装到 npm 之后可以改成：

```sh
dsh plugin --profile web add dsh-database
```

安装由包内 `cordis.patch.yml` 挂载。不要再往 profile 的 patch 里手写同一行，否则会重复加载。

卸载：

```sh
dsh plugin --profile web remove dsh-database
```

不要同时安装旧的「内嵌数据库的 remote-exec」：二者都会占用 `/plugins/database/connections`。本插件与 `dsh-remote-exec` 可以并存。

## 能做什么

在右侧栏「数据库」页签里管理连接，按对话隔离查询工作台。

- **MySQL / Oracle**：目录与表结构、SELECT、受控 DML/DDL、SQL 经验库。生产/预发布连接只读。
- **Redis 7.2+**：单机、一台哨兵或一个集群种子；命令台与 Key 浏览。每次命令用独立连接，结束即关。
- **Kafka**：列出 Topic、查看分区、有界 peek。不提交消费位置，不发消息。

勾选「记住密码」时，Windows 用当前账户 DPAPI 加密后写入 `$DSH_HOME/database/`。未勾选则密码不落盘。查询页签、草稿和历史按对话保存在 `conversation-workbenches/`。

## AI

正式入口是工作台 **AI Query**。人和 AI 走同一套执行与记录。

- SIT：模型可以看到单元格原值，并可以直接执行 INSERT/UPDATE/DELETE（首错停止；一次最多 8 条 SQL，每条最多 100 行）。
- UAT / PVT：AI 不能写。Redis 的 `redis_execute` 会被拒绝。
- DDL 仍须人工确认。

点执行历史即打开详情。其他连接上的 AI 活动只出提示条，不会自动切换连接。

## 限制（请按这个理解能力边界）

- 视图、同义词可看元数据；含 LOB 的 Oracle 查询尚未支持。
- Oracle 19c、SID、时间字段维护未验收。
- Redis Cluster / Sentinel、真实业务集群未验收。
- Kafka 不支持发消息、改 offset、Kerberos / OAuth / 客户端证书。
- 查询默认每页 100 行，最多 500 行、1 MiB，单请求 30 秒。取消只终止本次会话，共享登录仍可用。
- 大整数和精确小数按字符串展示。

已在隔离 profile 上验证过的组合见下表。现用 Desktop GUI 与真实模型工具关联仍为未跑。

| 环境 | 说明 |
| --- | --- |
| Node.js | 包声明 ≥ 24；隔离加载使用 Desktop 内置 Node |
| Harness | 已验证 `0.1.2-rc.1`、`0.1.7-rc.2`、`0.2.0-rc.2` |
| MySQL | 8.4.x 临时容器；8.0.32 仅只读核对 |
| Oracle | Free 23 Thin 模式，不替代 19c/SID |
| Redis | 8.10.2 一次性容器 |
| 驱动 | mysql2 3.24.4、oracledb 7.0.1、redis 6.2.1、kafkajs 2.2.4 |

## 开发

```sh
npm ci --legacy-peer-deps
npm run check
```

实库验收会创建带唯一标签的临时 Docker 容器，结束后删除。不要对业务库跑这些脚本。

```sh
npm run test:mysql
npm run test:oracle
DSH_TEST_REDIS=1 npm run test:host
DSH_TEST_DATABASES=1 npm run test:host
```

安装到本机 Desktop 前设置 `DSH_DESKTOP_APP` 为安装根目录（含 `DeepSeek Harness.exe` 或 `app.asar.unpacked`），再执行 `npm run install:desktop`。脚本只把 `npm pack` 的 tgz 交给 profile 的 pnpm，不链源码。

隔离宿主验收：`DSH_DESKTOP_APP=... npm run test:host`。可用 `DSH_TEST_BROWSER` 指定浏览器；`DSH_TEST_ALLOW_VERSION` 仅用于诊断，正式通过不要设置。OpenSSL 不在 PATH 时，Redis TLS fixture 可设 `DSH_OPENSSL`。

架构与接入说明见 [docs/README.md](docs/README.md)。

## 目录收录

仓库创建满一天后，向 [awesome-dsh-plugin](https://github.com/awesome-dsh-plugin/awesome-dsh-plugin) 提交 `data/plugins/zhuoxiaoshuai__dsh-database.yml`：

```yaml
url: https://github.com/zhuoxiaoshuai/dsh-database
name: zhuoxiaoshuai/dsh-database
category: dev
description:
  en: MySQL, Oracle, Redis, and Kafka workbench for DeepSeek Harness, with a shared execution path for humans and the model.
  zh: DeepSeek Harness 的 MySQL、Oracle、Redis、Kafka 工作台，人和模型共用同一套连接、执行和记录。
```

GitHub Topics 请加上 `dsh-plugin`。

## License

MIT

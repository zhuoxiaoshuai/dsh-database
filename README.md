# DSH Database

[![MIT](https://img.shields.io/badge/license-MIT-0B7285?style=flat-square)](LICENSE)
[![DSH](https://img.shields.io/badge/DSH-Web-5B4CF0?style=flat-square)](cordis.patch.yml)
![written entirely with AI](https://img.shields.io/badge/written-entirely%20with%20AI-555?style=flat-square)
[![stars](https://img.shields.io/github/stars/zhuoxiaoshuai/dsh-database?style=flat-square)](https://github.com/zhuoxiaoshuai/dsh-database)

A DeepSeek Harness plugin, not part of `dsh web` itself. After you add it to the web profile and restart, a **Database** tab appears in the conversation’s right sidebar. It talks to MySQL, Oracle, Redis, and Kafka. Remove the plugin and `dsh web` is unchanged.

This repository was written entirely with AI.

![Workbench](docs/screenshots/workbench.png)

Names in the screenshots are test data.

[中文](README.zh.md)

## Install

```sh
npm pack
dsh plugin --profile web add ./dsh-database-0.1.0-alpha.12.15.tgz
```

Restart `dsh web` afterwards. Node.js 24 or newer is required. There is no npm package yet, so use the tgz from `npm pack`.

To uninstall:

```sh
dsh plugin --profile web remove dsh-database
```

Do not copy `cordis.patch.yml` into the profile by hand.

On Desktop, `dsh` is not on PATH. Open **DSH Terminal** from the tray and use `--profile desktop` instead of `--profile web`. It is the same plugin on a different profile.

## Environments

When you save a connection, pick SIT, UAT, or PVT. `dev` and `test` become SIT, `staging` becomes UAT, and `prod` becomes PVT. Any other value is treated as UAT.

On SIT, query cells are sent to the model as returned. Grid DML/DDL and `redis_execute` are allowed; the database or Redis account still has the last word.

On UAT and PVT, the model cannot write and the grid cannot edit. The SQL editor still auto-commits (`lane: manual`). If writes are not acceptable, use a read-only database user.

Passwords stay in the Host process. “Remember password” exists only on Windows (DPAPI, current user, secret on stdin) and is off by default.

See [SECURITY.md](SECURITY.md).

## MySQL

![MySQL results](docs/screenshots/mysql-results.png)

The driver is mysql2, default port 3306. The tree is database → table → column. Identifiers use backticks; paging uses `LIMIT` / `OFFSET`. `mysql`, `information_schema`, `performance_schema`, and `sys` stay in the tree.

```sql
SELECT 9007199254740993 AS id;
```

When the account can read them, the catalog shows columns, indexes, constraints, and `SHOW CREATE`. Otherwise it explains why, instead of failing silently.

Filter, sort, and paging run on the server. The default is 100 rows; the cap is 500 rows or 1 MiB; the timeout is 30 seconds. Cancelling a query does not drop the login.

Grid edits use parameterized statements: preview, confirm once, and match the original primary-key row. A conflict rolls back and keeps the draft.

DDL allows at most 20 steps. Approval lasts 5 minutes. Destructive steps ask you to type the table name. The run stops on the first error; there is no all-or-nothing DDL rollback. InnoDB lock wait showed up on a disposable 8.4 container.

On SIT, `database_execute_sql` runs up to 8 statements, 100 rows each, including DML. The first error stops the rest.

BIGINT is returned as a string from the driver (`supportBigNumbers` + `bigNumberStrings`). BLOB cells show as `[BLOB n bytes]`.

## Oracle

![Oracle catalog](docs/screenshots/oracle-catalog.png)

The SQL page is the same as MySQL. Objects are schemas; names are case-insensitive. If a schema named after the username exists, that is the default. Identifiers are quoted; paging uses `OFFSET … ROWS FETCH FIRST … ROWS ONLY`; plans use `EXPLAIN PLAN FOR`. q-quote works; `#` comments do not.

The driver is oracledb Thin, default port 1521, Service Name. SID has not been tried. NUMBER and timestamps are fetched as STRING. Views and synonyms expose metadata only. A query that includes a LOB column fails. 19c, SID, and temporal-column maintenance have not been tried. Free 23 Thin is not a stand-in for 19c.

## Redis

![Redis keys](docs/screenshots/redis-keys.png)

Redis 7.2 or newer is required. The tree is DB → keys. SCAN paging can return empty pages or duplicates; the UI says when the cursor is unfinished.

```text
PING
```

Standalone, one sentinel, or one cluster seed are supported. ACL, TLS, and a custom CA are optional. Sentinel takes a single address; the same user and password are used for sentinel and Redis. In cluster mode the host is a seed and DB must be 0.

The key browser and the command console use different connections. The console runs one CLI-quoted command and then closes. `SELECT` or `MULTI` in the console does not change the tree.

`redis_execute` is available on SIT only. `DSH_REDIS_COMMAND_BLACKLIST` is empty unless you set it; Redis ACL still applies. Cluster and Sentinel have not been tried against a production cluster.

## Kafka

![Kafka topic](docs/screenshots/kafka-topic.png)

Kafka is read-only: list topics, describe partitions, and peek one partition.

```text
PEEK "orders" PARTITION 0 FROM LATEST LIMIT 20
```

Replace `"orders"` with a topic you actually have.

Authentication: none, TLS+CA, PLAIN, or SCRAM-SHA-256/512. PLAIN and SCRAM can skip TLS. When TLS is on, certificates are always verified. Kerberos, OAuth, and client certificates are not supported. There is no produce, topic admin, or offset move.

Peek uses a temporary group `dsh-peek-{uuid}` with `autoCommit: false`. Those groups stay hidden in GROUPS. If stop or disconnect times out, the worker is dropped and a new one is started.

Typing in AI Query takes over that editor until you give it back.

## Tools

Tool guides load only when you pass a topic to `database_status`.

| Tool | Notes |
| --- | --- |
| `database_status` | Live SQL/Redis connections and `generation` |
| `database_catalog` | `schemas` / `tables` / `table`. Do not query `information_schema` |
| `database_execute_sql` | `action=read` returns the current AI Query text. With `sql`, it runs (SIT only). Read-only on UAT/PVT |
| `database_templates` | Save and search text. Does not execute |
| `database_read_collab` | Open query tabs |
| `database_import_connections` | Register hosts. No password |
| `redis_status` `redis_keys` `redis_value` | SCAN, type, TTL, value |
| `redis_execute` | SIT only, one command |
| `kafka_status` `kafka_topics` `kafka_describe` | Topics, partitions, watermarks |
| `kafka_peek` | Peek one partition. Refused if you already took over the editor |

## Implementation

The tab lives in DSH’s right sidebar. Drivers (`mysql2`, `oracledb`, `redis`, `kafkajs`) load only in Host workers. The browser calls `/plugins/database/...` with a session cookie; without a cookie the response is 401.

Connections are stored in the workspace file. Editors are per conversation. Reconnect changes `generation` and cancels in-flight work.

Redis and Kafka use `ExecutionDocument` (`text`, `context`, `revision`, `controller`). MySQL and Oracle still use `SharedQuery`, with the same takeover rules. The first keystroke sets `controller` to `user`. A run requires `controller === 'user'` and a matching `revision`. Actor is `user` or `ai`; the page cannot forge `ai`.

A timed-out write is reported as unknown: the row may already be in the database. Peek and query timeout is 30 seconds.

MySQL and Oracle still go through `legacy-sql` / `legacy-adapter`. The Redis UI is `standard`; the Host path is still `legacy-adapter`. Kafka is `standard` + `standard-text`.

More in [docs](docs/README.md), [architecture](docs/data-source-architecture.md), and [adding a source](docs/data-source-onboarding.md). To add a source, copy Kafka, not MySQL.

## Limits

- No PostgreSQL, ClickHouse, MongoDB, Elasticsearch, or charts
- Oracle cannot query LOB columns; 19c and SID have not been tried
- Redis Cluster / Sentinel have not been tried against a production cluster
- Kafka cannot produce; Kerberos, OAuth, and client certificates are unsupported
- The Desktop GUI and a real model `callId` have not been run

## Troubleshooting

| Problem | What to do |
| --- | --- |
| `/plugins/database/connections` clash | An old remote-exec still ships this UI. Current `dsh-remote-exec` can be installed together |
| `dsh` missing on Desktop | Open DSH Terminal from the tray |
| Plugin installed but not visible | Restart the profile, refresh, and avoid duplicate patch rows |
| Oracle query hits a LOB column | Not supported |
| Console `SELECT` does not change the tree | Pick the DB in the tree |
| Does peek join a business consumer group | No |

## Development

```sh
npm ci --legacy-peer-deps
npm run check
npm run test:mysql
npm run test:oracle
DSH_TEST_REDIS=1 npm run test:host
DSH_TEST_DATABASES=1 npm run test:host
```

These scripts start labelled Docker containers and delete them afterwards. For an isolated host: `DSH_DESKTOP_APP=... npm run test:host`.

Issues: [github.com/zhuoxiaoshuai/dsh-database/issues](https://github.com/zhuoxiaoshuai/dsh-database/issues). Security: [SECURITY.md](SECURITY.md).

To list on [awesome-dsh-plugin](https://github.com/awesome-dsh-plugin/awesome-dsh-plugin), add `data/plugins/zhuoxiaoshuai__dsh-database.yml` (the `dsh-plugin` topic is already set):

```yaml
url: https://github.com/zhuoxiaoshuai/dsh-database
name: zhuoxiaoshuai/dsh-database
category: dev
tarball: https://github.com/zhuoxiaoshuai/dsh-database/releases/download/v0.1.0-alpha.12.15/dsh-database.tgz
description:
  en: MySQL, Oracle, Redis and Kafka inside DeepSeek Harness. Written entirely with AI.
  zh: DeepSeek Harness 插件，用来连接 MySQL、Oracle、Redis 和 Kafka。全程由 AI 编写。
```

## Status

Tried on Harness `0.1.2-rc.1`, `0.1.7-rc.2`, and `0.2.0-rc.2`.

Drivers: mysql2 3.24.4, oracledb 7.0.1, redis 6.2.1, kafkajs 2.2.4. MySQL was a disposable 8.4 container, plus a read-only check on 8.0.32. Oracle was Free 23 Thin. Redis was a disposable 8.10.2 container.

## License

[MIT](LICENSE)

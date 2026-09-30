# DSH Database

[![MIT](https://img.shields.io/badge/license-MIT-0B7285?style=flat-square)](LICENSE)
[![DSH](https://img.shields.io/badge/DSH-Web-5B4CF0?style=flat-square)](cordis.patch.yml)
[![stars](https://img.shields.io/github/stars/zhuoxiaoshuai/dsh-database?style=flat-square)](https://github.com/zhuoxiaoshuai/dsh-database)

MySQL, Oracle, Redis and Kafka inside DeepSeek Harness. Open **Database** in a conversation, add a connection.

[中文](README.zh.md)

## Install

```sh
npm pack
dsh plugin --profile web add ./dsh-database-0.1.0-alpha.12.15.tgz
```

Restart `dsh web`. Node.js ≥ 24. There is no npm package yet.

Uninstall: `dsh plugin --profile web remove dsh-database`. Do not paste `cordis.patch.yml` into the profile by hand.

On Desktop, `dsh` is not on PATH. Tray → **DSH Terminal**, then `--profile desktop`.

## Environments

Each connection is tagged SIT, UAT or PVT. `dev`/`test` map to SIT, `staging` to UAT, `prod` to PVT. Anything else becomes UAT.

SIT sends result cells to the model as returned. Grid DML/DDL and `redis_execute` are allowed, still limited by the account on the other end.

UAT and PVT: the model cannot write, and the grid cannot edit. The SQL editor still auto-commits (`lane: manual`). To block writes, use a read-only database user.

Passwords stay in the Host process. “Remember password” only exists on Windows (DPAPI, current user, secret on stdin). Off by default.

[SECURITY.md](SECURITY.md)

## Screenshots

![Workbench](docs/screenshots/workbench.png)

![Kafka topic](docs/screenshots/kafka-topic.png)

![Redis keys](docs/screenshots/redis-keys.png)

![MySQL results](docs/screenshots/mysql-results.png)

![Oracle catalog](docs/screenshots/oracle-catalog.png)

Names in the shots are test data.

## MySQL

mysql2, port 3306. Tree is database → table → column. Identifiers use backticks; paging is `LIMIT` / `OFFSET`. `mysql`, `information_schema`, `performance_schema` and `sys` stay in the tree.

```sql
SELECT 9007199254740993 AS id;
```

Catalog shows columns, indexes, constraints, and `SHOW CREATE` when the account can read them. Otherwise it says why.

Queries filter / sort / page on the server. Default 100 rows, cap 500 rows or 1 MiB, 30 s timeout. Cancelling a query does not drop the login.

Grid edits are parameterized: preview, confirm once, match the original PK row. A conflict rolls back and keeps the draft.

DDL: at most 20 steps, approval lasts 5 minutes, destructive steps ask you to type the table name. Stops on the first error. No all-or-nothing DDL rollback. InnoDB lock wait showed up on a disposable 8.4 container.

On SIT, `database_execute_sql` runs up to 8 statements, 100 rows each, DML allowed. First error stops the rest.

BIGINT comes back as a string (`supportBigNumbers` + `bigNumberStrings`). BLOB cells show as `[BLOB n bytes]`.

## Oracle

Same SQL page as MySQL. Objects are schemas (case does not matter). If a schema named after the username exists, that is the default. Quoted identifiers, `OFFSET … ROWS FETCH FIRST … ROWS ONLY`, `EXPLAIN PLAN FOR`. q-quote works; `#` comments do not.

oracledb Thin, 1521, Service Name. SID has not been tried. NUMBER and timestamps are fetched as STRING. Views and synonyms: metadata only. A query that includes a LOB column fails. 19c, SID, and temporal-column maintenance have not been tried. Free 23 Thin is not a stand-in for 19c.

## Redis

Needs 7.2+. Tree is DB → keys. SCAN can return empty pages or duplicates; the UI says when the cursor is unfinished.

```text
PING
```

Standalone, one sentinel, or one cluster seed. ACL, TLS, custom CA are optional. Sentinel takes one address; the same user/password is used for sentinel and Redis. Cluster: the host is a seed, DB is 0.

The key browser and the command console are different connections. The console runs one CLI-quoted command and closes. `SELECT` / `MULTI` in the console do not change the tree.

`redis_execute` is SIT only. `DSH_REDIS_COMMAND_BLACKLIST` is empty unless you set it; Redis ACL still applies. Cluster / Sentinel against a real cluster has not been tried.

## Kafka

Read-only: list topics, describe partitions, peek one partition.

```text
PEEK "orders" PARTITION 0 FROM LATEST LIMIT 20
```

Change `"orders"` to a topic you have.

Auth: none, TLS+CA, PLAIN, SCRAM-SHA-256/512. PLAIN/SCRAM can skip TLS. TLS always verifies certificates. No Kerberos, OAuth, or client certs. No produce, no topic admin, no offset moves.

Peek uses a temporary group `dsh-peek-{uuid}` with `autoCommit: false`. Those groups stay hidden in GROUPS. If stop/disconnect times out, the worker is dropped and a new one is started.

Typing in AI Query takes over that editor until you give it back.

## Tools

Guides load only when you pass a topic to `database_status`.

| Tool | Notes |
| --- | --- |
| `database_status` | Live SQL/Redis connections and `generation` |
| `database_catalog` | `schemas` / `tables` / `table`. Do not query `information_schema` |
| `database_execute_sql` | `action=read` returns the current AI Query text. With `sql`, runs it (SIT). Read-only on UAT/PVT |
| `database_templates` | Save / search text. Does not run anything |
| `database_read_collab` | Open query tabs |
| `database_import_connections` | Register hosts. No password |
| `redis_status` `redis_keys` `redis_value` | SCAN, type, TTL, value |
| `redis_execute` | SIT, one command |
| `kafka_status` `kafka_topics` `kafka_describe` | Topics, partitions, watermarks |
| `kafka_peek` | One partition. Refused if you already took over the editor |

## How it runs

The tab sits in DSH’s right sidebar. Drivers load only in Host workers (`mysql2`, `oracledb`, `redis`, `kafkajs`). The browser talks to `/plugins/database/...` with a session cookie; no cookie → 401.

Connections live in the workspace file. Editors are per conversation. Reconnect bumps `generation` and cancels in-flight work.

Redis and Kafka use `ExecutionDocument` (`text`, `context`, `revision`, `controller`). MySQL and Oracle still use `SharedQuery`, with the same takeover rules. First keystroke sets `controller` to `user`. Run requires `controller === 'user'` and a matching `revision`. Actor is `user` or `ai`; the page cannot forge `ai`.

A timed-out write is reported as unknown — the row may already be in the database. Peek and query timeout is 30 s.

MySQL/Oracle still go through `legacy-sql` / `legacy-adapter`. Redis UI is `standard`, Host is still `legacy-adapter`. Kafka is `standard` + `standard-text`.

[docs](docs/README.md) · [architecture](docs/data-source-architecture.md) · [add a source](docs/data-source-onboarding.md)

To add a source, copy Kafka. Do not copy MySQL.

## Limits

- No PostgreSQL, ClickHouse, MongoDB, Elasticsearch, or charts
- Oracle: no LOB queries, 19c, or SID
- Redis Cluster / Sentinel not tried against a production cluster
- Kafka: no produce, Kerberos, OAuth, or client certs
- Desktop GUI and a real model `callId` have not been run

## Troubleshooting

| Problem | What to do |
| --- | --- |
| `/plugins/database/connections` clash | Old remote-exec still shipping this UI. Current `dsh-remote-exec` is fine |
| `dsh` missing on Desktop | Tray → DSH Terminal |
| Plugin not showing | Restart the profile, refresh, no duplicate patch row |
| Oracle query hits a LOB column | Not supported |
| Console `SELECT`, tree unchanged | Pick the DB in the tree |
| Peek vs a consumer group | Peek does not join it |

## Development

```sh
npm ci --legacy-peer-deps
npm run check
npm run test:mysql
npm run test:oracle
DSH_TEST_REDIS=1 npm run test:host
DSH_TEST_DATABASES=1 npm run test:host
```

Those scripts start labelled Docker containers and delete them afterwards. Isolated host: `DSH_DESKTOP_APP=... npm run test:host`.

Issues: [github.com/zhuoxiaoshuai/dsh-database/issues](https://github.com/zhuoxiaoshuai/dsh-database/issues). Security: [SECURITY.md](SECURITY.md).

To list on [awesome-dsh-plugin](https://github.com/awesome-dsh-plugin/awesome-dsh-plugin), add `data/plugins/zhuoxiaoshuai__dsh-database.yml` (`dsh-plugin` topic is already set):

```yaml
url: https://github.com/zhuoxiaoshuai/dsh-database
name: zhuoxiaoshuai/dsh-database
category: dev
description:
  en: MySQL, Oracle, Redis and Kafka inside DeepSeek Harness.
  zh: DeepSeek Harness 里连 MySQL、Oracle、Redis、Kafka。
```

## Status

Tried on Harness `0.1.2-rc.1`, `0.1.7-rc.2`, `0.2.0-rc.2`.

Drivers in tree: mysql2 3.24.4, oracledb 7.0.1, redis 6.2.1, kafkajs 2.2.4. MySQL: disposable 8.4, plus a read-only check on 8.0.32. Oracle: Free 23 Thin. Redis: disposable 8.10.2.

## License

[MIT](LICENSE)

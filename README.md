# DSH Database

[![MIT](https://img.shields.io/badge/license-MIT-0B7285?style=flat-square)](LICENSE)
[![DSH](https://img.shields.io/badge/DSH-Web-5B4CF0?style=flat-square)](cordis.patch.yml)
![written entirely with AI](https://img.shields.io/badge/written-entirely%20with%20AI-555?style=flat-square)
[![stars](https://img.shields.io/github/stars/zhuoxiaoshuai/dsh-database?style=flat-square)](https://github.com/zhuoxiaoshuai/dsh-database)

Connect to MySQL, Oracle, Redis and Kafka from the right sidebar of a DeepSeek Harness conversation. Browse objects, run queries, and share a query editor with AI. SQL grid maintenance and a knowledge library support database work; bounded Kafka reads and SIT repair actions support diagnosis.

This repository was written entirely with AI.

[中文](README.zh.md) · [Install](#install) · [First use](#first-use) · [Permissions](#ai-collaboration-and-permissions) · [Development](#development) · [Docs](docs/README.md)

![Workbench](docs/screenshots/workbench.png)

Names in the screenshots are test data.

## Features

| Source | Common tasks |
| --- | --- |
| MySQL / Oracle | Database/schema, table, column and structure browsing; query/object tabs, SQL batches, execution plans, grid maintenance and SQL knowledge analysis |
| Redis | DB/key browsing, types, TTL, values and a single-command console |
| Kafka | Topics/groups, partitions, watermarks, lag, message previews, bounded search and SIT publish/repair actions |

All sources share query, AI Query, history and knowledge entry points. Editors and results retain source-specific semantics.

## Install

```sh
dsh plugin --profile web add https://github.com/zhuoxiaoshuai/dsh-database/releases/download/v0.1.0-alpha.12.15/dsh-database.tgz
```

Restart `dsh web` afterwards. Node.js 24 or newer is required. The git repository does not ship `lib/`, so do not install from `github:`.

From a clone you can also pack it locally:

```sh
npm ci --legacy-peer-deps
npm pack
dsh plugin --profile web add ./dsh-database-0.1.0-alpha.12.18.tgz
```

To uninstall:

```sh
dsh plugin --profile web remove dsh-database
```

Do not copy `cordis.patch.yml` into the profile by hand.

On Desktop, `dsh` is not on PATH. Open **DSH Terminal** from the tray and run:

```sh
dsh plugin --profile desktop add https://github.com/zhuoxiaoshuai/dsh-database/releases/download/v0.1.0-alpha.12.15/dsh-database.tgz
```

It is the same plugin on a different profile. `--profile web` does not install into the desktop app.

The download URL above targets the `alpha.12.15` release package. The source currently declares `alpha.12.18`; use the filename printed by `npm pack`, which builds automatically. Check acceptance evidence separately for the release package and local source.

## First use

1. Install, restart the chosen profile, and open the **Database** tab in the conversation's right sidebar.
2. Click **＋** beside **我的连接**, select a source, and enter its address, credentials and database/Service Name/DB or brokers. Choose SIT, UAT or PVT.
3. Optionally click **测试连接** to check the settings, then **连接**. Testing alone does not add a saved connection.
4. Select a database/schema for SQL. Run `SELECT 1;` for MySQL, `SELECT 1 FROM DUAL;` for Oracle, `PING` for Redis, or `TOPICS` for Kafka in the query page.
5. For AI collaboration, open **AI Query** and describe the connection, target and task in the conversation, such as “Read the current SQL and explain what it does.” Check the target and permissions before execution.

## AI collaboration and permissions

Typing in AI Query or clicking **接管** takes control of the document. AI cannot overwrite the text while you control it. Finish editing and click **归还 AI** to let the model continue. The ordinary query page and AI Query are separate entry points.

| Operation | SIT | UAT / PVT |
| --- | --- | --- |
| Human SQL, ordinary or taken-over coedit | Reads and DML; auto-commit within account privileges | Reads and DML; auto-commit within account privileges |
| AI SQL | Reads and DML | Read-only |
| Grid edits / structured DDL | Human preview and confirmation | Disabled |
| Human Redis console | Subject to ACL and command validation | Subject to ACL and command validation |
| AI Redis | Structured reads and `redis_execute` | Structured reads; `redis_execute` disabled |
| Kafka reads | Allowed | Allowed |
| Kafka writes | Human confirmation or AI tools; broker permissions still apply | Disabled |

**UAT/PVT do not prevent human SQL or human Redis writes.** Use a read-only database account or Redis ACL to prohibit writes. AI SQL results on SIT return unredacted cells to the model; ordinary human queries do not automatically send their results to it.

Imported `dev`/`test` labels map to SIT, `staging` to UAT, `prod` to PVT, and unknown labels to UAT. Passwords stay in Host memory by default. On Windows, optional **记住密码** encrypts them using current-user DPAPI. See [SECURITY.md](SECURITY.md).

An interrupted write or a lost acknowledgement may be reported as **unknown**: the change may already exist. Check the actual target before deciding what to do next. Unknown writes are never automatically replayed. Reconnecting invalidates old requests and execution targets.

## MySQL

![MySQL results](docs/screenshots/mysql-results.png)

The driver is mysql2, default port 3306. The tree is database → table → column. Identifiers use backticks; paging uses `LIMIT` / `OFFSET`. `mysql`, `information_schema`, `performance_schema`, and `sys` stay in the tree.

```sql
SELECT 9007199254740993 AS id;
```

When the account can read them, the catalog shows columns, indexes, constraints, and `SHOW CREATE`. Otherwise it explains why, instead of failing silently.

Filter, sort, and paging run on the server. The default is 100 rows; the cap is 500 rows or 1 MiB. Cancelling a query does not drop the login.

Grid edits use parameterized statements: preview, confirm once, and match the original primary-key row. A conflict rolls back and keeps the draft.

DDL allows at most 20 steps. Approval lasts 5 minutes. Destructive steps ask you to type the table name. The run stops on the first error; there is no all-or-nothing DDL rollback.

`database_execute_sql` runs up to 8 statements, 100 rows each. It is read-only on UAT/PVT and permits DML on SIT. The batch is checked before dispatch, runs in order, and stops at the first error. Earlier commits are not rolled back when a later statement fails.

BIGINT is returned as a string. Binary cells show readable UTF-8 text or hexadecimal bytes (BIT uses binary digits); binary columns stay read-only in the grid.

## Oracle

![Oracle catalog](docs/screenshots/oracle-catalog.png)

The SQL page is the same as MySQL. Objects are organized by schema. Unquoted SQL identifiers are folded to uppercase; double-quoted identifiers preserve case. If a schema named after the username exists, that is the default. Identifiers are quoted; paging uses `OFFSET … ROWS FETCH FIRST … ROWS ONLY`; plans use `EXPLAIN PLAN FOR`. q-quote works; `#` comments do not.

The driver is oracledb Thin, default port 1521. The form supports Service Name and SID; live SID acceptance remains `NOT_RUN`. NUMBER and timestamps are fetched as STRING. Views and synonyms expose metadata only. A query that includes a LOB column fails.

## Redis

![Redis keys](docs/screenshots/redis-keys.png)

Redis 7.2 or newer is required. The tree is DB → keys. SCAN paging can return empty pages or duplicates; the UI says when the cursor is unfinished.

```text
PING
```

Standalone, one sentinel, or one cluster seed are supported. ACL, TLS, and a custom CA are optional. Sentinel takes a single address; the same user and password are used for sentinel and Redis. In cluster mode the host is a seed and DB must be 0.

The key browser and the command console use different connections. The console runs one CLI-quoted command and then closes. `SELECT` or `MULTI` in the console does not change the tree.

The human command console can execute commands on SIT, UAT and PVT. AI `redis_execute` is SIT-only; other environments use structured read tools. `DSH_REDIS_COMMAND_BLACKLIST` is empty unless you set it; Redis ACL still applies.

## Kafka

![Kafka topic](docs/screenshots/kafka-topic.png)

Search and page topics/groups, inspect partitions, lag and settings, locate offsets by time, and search bounded message ranges. PEEK uses a temporary group and does not commit business consumer offsets.

```text
TOPICS SEARCH "orders"
GROUP "billing" TOPIC "orders"
PEEK "orders" PARTITION 0 FROM LATEST LIMIT 20
```

Replace the topic and group with actual names. SIT permits single/limited batch publishing, replaying complete messages, compacted-topic tombstones, `dsh-test-` topic creation and offset changes for groups without running members. Existing messages cannot be modified in place.

Authentication supports none, TLS with CA, PLAIN and SCRAM-SHA-256/512. Kerberos, OAuth and client certificates are not supported. See the [Kafka guide](docs/datasource/kafka.en.md) for full commands, byte/result limits, confirmation and unknown outcomes.

## AI tools

`database_status` without a topic returns the live connections and the next call's `connectionId` and `generation`. A topic loads one usage section. A missing connection or a stale generation returns the current connection list. When that source has exactly one live connection, `connectionId` and `generation` can be omitted.

`kafka_scan` and `kafka_set_group_offsets` take `spec` as an object, `kafka_produce` takes `headers` as an object, and `kafka_produce_batch` takes `messages` as an array. `kafka_peek` `from` is `BEGINNING`, `LATEST`, or `OFFSET`.

<details>
<summary>Expand tool reference</summary>

| Tool | Notes |
| --- | --- |
| `database_status` | Live connections and the next call's arguments. A topic returns only that usage section |
| `database_catalog` | `schemas` / `tables` / `table`. Do not query `information_schema` |
| `database_execute_sql` | `action=read` returns the current AI Query text. With `sql`, it executes; read-only on UAT/PVT, writes allowed on SIT |
| `database_templates` | Save and search text. Does not execute |
| `database_read_collab` | Open query tabs |
| `database_import_connections` | Register hosts. No password |
| `redis_status` `redis_keys` `redis_value` | SCAN, type, TTL, value |
| `redis_execute` | SIT only, one command |
| `kafka_status` `kafka_topics` `kafka_describe` | Topics, partitions, watermarks |
| `kafka_peek` | Peek one partition. `from` is `BEGINNING`, `LATEST`, or `OFFSET`. Refused after editor takeover |
| `kafka_groups` `kafka_group` | Search/page groups; inspect state and members |
| `kafka_group_topics` `kafka_group_topic` | Page associated topics; inspect committed positions and Lag |
| `kafka_topic_config` `kafka_time_offsets` `kafka_scan` | Topic settings, time-based offsets, bounded cross-partition search. `kafka_scan` `spec` is an object |
| `kafka_produce` `kafka_produce_batch` `kafka_tombstone` | SIT single/batch publish and compacted-topic tombstone. `headers` is an object; `messages` is an array |
| `kafka_create_topic` `kafka_set_group_offsets` | SIT test topic creation and inactive-group offset adjustment |

</details>

## Troubleshooting

| Problem | What to do |
| --- | --- |
| Plugin installed but no tab | Restart the profile you installed into, then refresh; avoid duplicate manual `cordis.patch.yml` entries |
| `dsh` missing on Desktop | Open DSH Terminal from the tray |
| `/plugins/database/connections` clash | Check whether an older remote-exec still provides the database UI |
| AI cannot update or run current text | Check document control; finish saving and return control to AI. Refresh connection status after reconnecting |
| Oracle query includes a LOB | Select ordinary columns; on-demand LOB viewing is not connected yet |
| Redis console `SELECT` leaves the tree unchanged | Choose the DB in the tree; each console command uses a separate connection |
| Write result is unknown | Read the target to verify the change before resubmitting |
| Query times out | SQL driver query timeout is 25 seconds; Host query deadline is 32 seconds. Maintenance and source operations have separate limits; see [timeout configuration](src/host/request-timeouts.mjs) |

## Development

Use Node.js 24 or newer. Install dependencies and check from the repository directory:

```sh
npm ci --legacy-peer-deps
npm run check
npm run test:package-closure
```

`check` runs Host/client type checking, unit tests and builds. Package closure separately checks shipped runtime files. Run browser and live-source acceptance separately:

| Command | Requirements and scope |
| --- | --- |
| `npm run test:sql-workspace` | Microsoft Edge; controlled bridges for MySQL/Oracle client acceptance |
| `npm run test:workspace-races` | Microsoft Edge; coedit save/control/target races |
| `npm run test:execution-boundary` | Microsoft Edge; controlled execution-boundary and grid-value checks |
| `npm run test:mysql` / `test:oracle` | Docker Linux Engine; owned temporary databases with cleanup, not Oracle 19c/SID acceptance |
| `npm run test:redis` | Docker and OpenSSL; temporary plain/TLS Redis acceptance. Set `DSH_OPENSSL` if needed |
| `npm run test:kafka` | Docker and OpenSSL; isolated broker acceptance |
| `npm run test:host` | Harness installation directory (`DSH_DESKTOP_APP`) and Chrome (or a supported browser via `DSH_TEST_BROWSER`); installs and starts a Web host in a disposable profile |

Windows PowerShell example:

```powershell
$env:DSH_DESKTOP_APP = 'C:\path\to\DeepSeek Harness'
npm run test:host
# Optional live-source checks; database fixtures require Docker
$env:DSH_TEST_DATABASES = '1'
$env:DSH_TEST_REDIS = '1'
$env:DSH_TEST_KAFKA = '1'
npm run test:host
```

In a POSIX shell, use `DSH_DESKTOP_APP="/path/to/install" npm run test:host`. Reports are written under `artifacts/`. Controlled bridges, isolated live sources and installed-host acceptance are recorded separately. `test:host` does not establish live Desktop UI or model-call acceptance.

## Compatibility and acceptance records

Current drivers: mysql2 3.24.4, oracledb 7.0.1, redis 6.2.1 and kafkajs 2.2.4. Historical validation includes Harness `0.1.2-rc.1`, `0.1.7-rc.2` and `0.2.0-rc.2`, MySQL 8.4/8.0.32, Oracle Free 23/19c Service, Redis 8.10.2 and test Kafka instances. These records do not automatically cover later source changes or every authentication combination.

| Record | Coverage and limits |
| --- | --- |
| [Execution-boundary repair (2026-10-05)](docs/plans/execution-boundary-implementation.md) | Records passing type checks, 768 unit tests, controlled browser checks, build and package closure. Final four-source live reruns, Oracle 19c/SID, installed Desktop and real model calls remain `NOT_RUN` |
| [Kafka repair extension (2026-10-04–05)](docs/plans/kafka-repair-implementation.md) | Controlled regressions and stage-specific isolated broker runs; final-code live rerun and installed/model acceptance remain `NOT_RUN` |
| [Historical installation/source acceptance](docs/data-source-foundation-progress.md) | Consult for the versions, environments and scope tested at that time |

These are dated records. This README update did not rerun database, Desktop or model acceptance. Establish the validation status of current source using its build and actual reports.

## Documentation and feedback

- [Documentation index](docs/README.md), [architecture](docs/data-source-architecture.md), [source onboarding](docs/data-source-onboarding.md)
- [Kafka guide](docs/datasource/kafka.en.md), [implementation records](docs/plans/README.md)
- [Issues](https://github.com/zhuoxiaoshuai/dsh-database/issues), [security](SECURITY.md)

## License

[MIT](LICENSE)

# dsh-database

<div align="center">
  🌏 <a href="./README.md"><b>English</b></a> · <a href="./README.zh.md">中文</a>
</div>

<br />

[![license](https://img.shields.io/github/license/zhuoxiaoshuai/dsh-database?style=flat&label=license&color=blue)](LICENSE)
[![stars](https://img.shields.io/github/stars/zhuoxiaoshuai/dsh-database?style=flat&label=stars&color=blue)](https://github.com/zhuoxiaoshuai/dsh-database)
[![docs](https://img.shields.io/badge/docs-English%20%7C%20%E4%B8%AD%E6%96%87-0075cc?style=flat&labelColor=555555)](README.zh.md)

MySQL, Oracle, Redis, and Kafka workbench for [DeepSeek Harness](https://github.com/deepseek-ai/deepseek-harness), with a shared execution path for humans and the model.

Current version **0.1.0-alpha.12.15**.

## Install

Requires a working DSH (`dsh web`) and Node.js ≥ 24.

```sh
npm pack
dsh plugin --profile web add ./dsh-database-0.1.0-alpha.12.15.tgz
```

After the package is on npm:

```sh
dsh plugin --profile web add dsh-database
```

The bundled `cordis.patch.yml` mounts the plugin. Do not insert the same row into the profile patch by hand, or the loader will duplicate it.

Uninstall:

```sh
dsh plugin --profile web remove dsh-database
```

Do not install an older remote-exec build that still embeds the database workbench: both claim `/plugins/database/connections`. This plugin can sit beside `dsh-remote-exec`.

## What it does

The **Database** tab in the right sidebar manages connections. Query workbenches are isolated per conversation.

- **MySQL / Oracle**: catalog and table metadata, SELECT, controlled DML/DDL, SQL experience library. Production / pre-production connections stay read-only.
- **Redis 7.2+**: standalone, one sentinel, or one cluster seed; command console and key browser. Each command uses a fresh connection and closes it when finished.
- **Kafka**: list topics, inspect partitions, bounded peek. Does not commit consumer offsets or produce messages.

If **Remember password** is checked, Windows stores it with the current-user DPAPI under `$DSH_HOME/database/`. Unchecked passwords are never written to disk. Query tabs, drafts, and history live under `conversation-workbenches/` per conversation.

## AI

The supported entry is the workbench **AI Query** tab. Humans and the model share the same execution and records.

- SIT: the model sees unredacted cell values and may run INSERT/UPDATE/DELETE directly (stop on first error; at most 8 SQL statements per call, 100 rows each).
- UAT / PVT: AI writes are refused. Redis `redis_execute` is rejected.
- DDL still needs a human confirmation step.

Opening an execution history item shows its details. AI activity on another connection only shows a hint bar; it does not switch the current connection.

## Limits

- Views and synonyms can be browsed as metadata; Oracle queries with LOB columns are not supported yet.
- Oracle 19c, SID, and temporal-column maintenance are unverified.
- Redis Cluster / Sentinel and production clusters are unverified.
- Kafka does not produce messages, change offsets, or support Kerberos / OAuth / client-certificate auth.
- Queries default to 100 rows per page, capped at 500 rows and 1 MiB, with a 30-second request deadline. Cancel stops only that session; the shared login stays up.
- Large integers and exact decimals are displayed as strings.

Verified combinations are listed below. The live Desktop GUI and real model tool-call correlation remain unrun.

| Environment | Notes |
| --- | --- |
| Node.js | Package requires ≥ 24; isolated loads use Desktop's bundled Node |
| Harness | Verified on `0.1.2-rc.1`, `0.1.7-rc.2`, `0.2.0-rc.2` |
| MySQL | 8.4.x throwaway containers; 8.0.32 read-only check only |
| Oracle | Free 23 Thin mode; not a substitute for 19c / SID |
| Redis | 8.10.2 throwaway containers |
| Drivers | mysql2 3.24.4, oracledb 7.0.1, redis 6.2.1, kafkajs 2.2.4 |

## Development

```sh
npm ci --legacy-peer-deps
npm run check
```

Live-database acceptance creates uniquely labelled temporary Docker containers and deletes them afterwards. Do not run those scripts against business databases.

```sh
npm run test:mysql
npm run test:oracle
DSH_TEST_REDIS=1 npm run test:host
DSH_TEST_DATABASES=1 npm run test:host
```

To install into local Desktop, set `DSH_DESKTOP_APP` to the install root (`DeepSeek Harness.exe` or `app.asar.unpacked`), then `npm run install:desktop`. The script packs a tarball and hands it to the profile's pnpm; it does not link source.

Isolated host acceptance: `DSH_DESKTOP_APP=... npm run test:host`. `DSH_TEST_BROWSER` selects the browser. `DSH_TEST_ALLOW_VERSION` is diagnostic only; a real pass must unset it. If OpenSSL is not on PATH, Redis TLS fixtures accept `DSH_OPENSSL`.

Architecture notes: [docs/README.md](docs/README.md). Security notes: [SECURITY.md](SECURITY.md).

## Listing

After the repository is at least one day old, submit `data/plugins/zhuoxiaoshuai__dsh-database.yml` to [awesome-dsh-plugin](https://github.com/awesome-dsh-plugin/awesome-dsh-plugin):

```yaml
url: https://github.com/zhuoxiaoshuai/dsh-database
name: zhuoxiaoshuai/dsh-database
category: dev
description:
  en: MySQL, Oracle, Redis, and Kafka workbench for DeepSeek Harness, with a shared execution path for humans and the model.
  zh: DeepSeek Harness 的 MySQL、Oracle、Redis、Kafka 工作台，人和模型共用同一套连接、执行和记录。
```

The GitHub topic `dsh-plugin` is already set.

## License

MIT

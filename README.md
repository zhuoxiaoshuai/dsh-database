# DSH Database

[![MIT](https://img.shields.io/badge/license-MIT-0B7285?style=flat-square)](LICENSE)
[![DSH](https://img.shields.io/badge/DSH-Web-5B4CF0?style=flat-square)](cordis.patch.yml)
[![stars](https://img.shields.io/github/stars/zhuoxiaoshuai/dsh-database?style=flat-square)](https://github.com/zhuoxiaoshuai/dsh-database)

**A MySQL, Oracle, Redis, and Kafka workbench for DeepSeek Harness: humans and the model share connections, documents, execution, results, and history.**

🚀 One Database tab | Four sources | Same execution lane

[Why](#why-this-exists) | [Compare](#how-it-compares) | [Highlights](#highlights) | [See it in action](#see-it-in-action) | [Quick start](#quick-start-three-steps) | [Sources](#sources) | [How it works](#how-it-works) | [Limits](#configuration-and-limits)

🌐 **English** | [中文](README.zh.md)

Current version **0.1.0-alpha.12.15**. Isolation-profile evidence is not a production claim.

> If this plugin is useful, a star helps other DSH users find it.

> [!IMPORTANT]
> **SIT sends query cells to the model unredacted.** UAT / PVT refuse AI writes. Passwords never go back to the browser snapshot. Treat every saved connection as giving the Host process that account. See [SECURITY.md](SECURITY.md).

## Why this exists

DeepSeek Harness already reasons next to your session. The usual ways to touch a database still break that:

- **Paste SQL into the chat.** The model sees (or invents) connection strings, cannot open a catalog, cannot cancel a live statement cleanly, and overwrites the text you were editing.
- **Keep Navicat on the other screen.** The model is blind. You screenshot grids. Nobody shares history.
- **Ship four mini-plugins.** Each clones AI Query, history, and chrome. Redis gets faked as SQL. Kafka peek quietly joins a consumer group.

This plugin puts **one Database tab** in the conversation. Humans and the model share the same connection, the same document, the same execution record, and the same result. Redis stays Redis. Kafka peek uses a throwaway `dsh-peek-*` group with `autoCommit: false` and never commits offsets.

High-star DSH plugins (Vision Toolkit, Vision Router) sell a *boundary*: who is the brain, who holds the pixels, what leaves the machine. Database does the same for data sources: **the Host holds drivers and secrets; the workbench holds the document; the source module holds native semantics.**

## How it compares

| | Chat paste | External IDE | This plugin |
| --- | --- | --- | --- |
| Model can run what you see | Only if you paste it | No | **AI Query** is the same document |
| You can take over | Fight the next token | N/A | Typing sets `controller: user`; AI cannot overwrite |
| Redis / Kafka | Pretend they are SQL | Other products | SCAN cursor / bounded peek |
| Secrets | Often in context | Local files | Host-only; Windows DPAPI; stripped from snapshots |
| Environment | None | None | SIT write / UAT·PVT read-only / DDL human-gated |
| Cancel / timeout / unknown | Chat status | Tool-dependent | First-class execution states |

**One-line take:** not a SQL chatbot and not a second Navicat. It is the conversation-side workbench where the model is a coworker on the same lane.

## Highlights

- **Open a table the way you already work.** Catalog on the left, tabs on the right (overview / query / **AI Query** / knowledge / history). Four sources, one chrome.
- **The model runs your document, not a shadow copy.** History opens the text that ran. Activity on another connection is a hint bar, not a steal.
- **Typing is takeover.** `ExecutionDocument` has `text`, `context`, `revision`, and `controller`. If you edit, `controller` becomes `user`. AI publish is rejected until you hand it back. Run also checks revision so a stale tab cannot fire.
- **Drivers never enter the browser.** mysql2, oracledb, redis, and kafkajs load only in Host workers. The client talks authenticated plugin HTTP.
- **Environment is a gate, not a badge.** SIT follows the DB account (AI may DML / `redis_execute`). UAT / PVT: production-like connections read-only; AI writes refused.
- **Native pages, honest cells.** SQL uses `LIMIT` / `OFFSET FETCH`. Redis uses SCAN (empty pages happen; the UI says so). Kafka peek is bounded. BIGINT and exact decimals stay strings. BLOB is `[BLOB n bytes]`, not a dumped buffer.
- **Secrets stay on the Host.** Remember-password is off by default. On Windows it is current-user DPAPI over stdin, not argv. Custom CAs follow the same strip.

This project has two layers:

1. **Extracted workbench** — workspace, AI Query, takeover, execution, history, knowledge, chrome. Once.
2. **Source modules** — protocol, objects, authorize, result shape. Four today; new ones should copy Kafka (`standard` + `standard-text`), not clone MySQL.

```sh
npm pack
dsh plugin --profile web add ./dsh-database-0.1.0-alpha.12.15.tgz
```

**Contents**

- [Why this exists](#why-this-exists)
- [How it compares](#how-it-compares)
- [Highlights](#highlights)
- [Who it is for](#who-it-is-for)
- [See it in action](#see-it-in-action)
- [Quick start: three steps](#quick-start-three-steps)
- [Sources](#sources)
- [How it works](#how-it-works)
- [Configuration and limits](#configuration-and-limits)
- [Troubleshooting](#troubleshooting)
- [FAQ](#faq)
- [Development and community](#development-and-community)

## Who it is for

1. You already live in DeepSeek Harness and want MySQL / Oracle / Redis / Kafka **beside the conversation**, not in another window the model cannot see.
2. You want the model to run the **same** SQL, Redis command, or Kafka peek you can open, edit, and take over — not a parallel agent console.
3. You care that peek does not join the business consumer group, that Redis `MULTI` does not stick on the key browser, and that `9007199254740993` does not become `9007199254740992`.

## See it in action

### Four sources in one tree

<p align="center">
  <img src="docs/screenshots/workbench.png" alt="MySQL, Oracle, Redis, and Kafka in one connection tree" width="100%" />
</p>

*Left: MySQL, Oracle, Redis, and Kafka connections. Right: Kafka topics. Query tabs, AI Query, and knowledge stay the same chrome.*

### Kafka topic metadata

<p align="center">
  <img src="docs/screenshots/kafka-topic.png" alt="Kafka topic partitions, replica factor, watermarks" width="100%" />
</p>

*Partitions, replica factor, leader, and watermarks. Peek uses a temporary consumer and does not join the business group or commit offsets.*

### Redis keys and values

<p align="center">
  <img src="docs/screenshots/redis-keys.png" alt="Redis key browser with TTL and JSON value" width="100%" />
</p>

*SCAN tree, key type, TTL, JSON value. The command console is a separate tab and a separate connection, so `SELECT` / `AUTH` / `MULTI` do not leak onto the browser.*

### MySQL result grid

<p align="center">
  <img src="docs/screenshots/mysql-results.png" alt="MySQL result grid with BIGINT as string" width="100%" />
</p>

*BIGINT and exact decimals render as strings. Cells are not executed as HTML.*

### Oracle catalog

<p align="center">
  <img src="docs/screenshots/oracle-catalog.png" alt="Oracle schema catalog" width="100%" />
</p>

*Schema tree (case-insensitive). Same SQL workbench as MySQL; Service Name / SID, pagination, and types stay Oracle.*

Screenshots are the current workbench. Sample names and rows are disposable fixtures, not a business cluster.

## Quick start: three steps

### 1. Install

Requires working DSH (`dsh web`) and Node.js ≥ 24.

```sh
npm pack
dsh plugin --profile web add ./dsh-database-0.1.0-alpha.12.15.tgz
```

After npm publish:

```sh
dsh plugin --profile web add dsh-database
```

Using **DSH Desktop**? It bundles `dsh` and does not add it to PATH. Open **DSH Terminal** from the tray:

```sh
dsh plugin --profile desktop add ./dsh-database-0.1.0-alpha.12.15.tgz
```

Then restart Desktop. `npm run install:desktop` packs a tarball into the profile (set `DSH_DESKTOP_APP` to the install root; no source link).

The bundled `cordis.patch.yml` mounts the plugin. Do not paste the same row into the profile patch. Uninstall: `dsh plugin --profile web remove dsh-database`.

### 2. Restart and open the tab

Restart a running Web Profile. In a conversation, open the **Database** tab, add a connection, **Test**, then **Connect**. Failed edits keep the previous live session.

### 3. Run something you can take over

- MySQL / Oracle: open a table or run SQL. History is conversation-private.
- Redis: pick a DB, browse keys, or run one command in the console.
- Kafka: open a topic, then bounded peek of one partition.

The model uses the same document. Typing takes over immediately.

## Sources

Each source reuses the workbench above. The table is the map; the sections are the real differences.

| Source | Best question | Main result |
| --- | --- | --- |
| MySQL | What is in this database / table? Run this SQL. | Catalog, `SHOW CREATE`, result grid |
| Oracle | Same, on a Service / SID schema | Schema tree, `OFFSET FETCH` grid |
| Redis | What is this key? Run this command. | SCAN tree, type, TTL, value |
| Kafka | What is on this topic? | Partitions, watermarks, bounded peek |

### MySQL

Relational SQL. Objects: **database → table → column**. Identifiers use backticks. Pages: `LIMIT … OFFSET …`. System schemas (`mysql`, `information_schema`, `performance_schema`, `sys`) stay visible. Defaults: `VARCHAR(255)` / `BIGINT`.

- **Connect:** host / port / user / password, default 3306. Driver `mysql2` in the Host worker.
- **Catalog:** tree, search, object home. Columns, indexes, constraints, and `SHOW CREATE` when the account can read them. Missing access is a reason, not a zero.
- **Query:** SQL editor, format, cancel (does not drop the shared login). SELECT uses server-side filter / sort / page. Default 100 rows, cap 500 rows and 1 MiB, 30-second deadline.
- **Writes:** parameterized INSERT/UPDATE/DELETE, preview, one confirmation, primary-key locate and original-row check. Conflicts roll back and keep the draft. DDL up to 20 steps, 5-minute one-shot approval; type the destructive name in the same window. First error stops. No whole-DDL rollback promise. InnoDB lock-wait is verified on throwaway 8.4.
- **AI:** `database_execute_sql`, up to 8 statements on SIT (100 rows each, DML allowed), stop on first error.

### Oracle

Same SQL workbench as MySQL, different dialect. Objects: **Schema** (case-insensitive). Default schema is the username when it exists. Identifiers use `"`. Pages: `OFFSET … ROWS FETCH FIRST … ROWS ONLY`. `EXPLAIN PLAN FOR`. q-quotes yes, `#` comments no.

- **Connect:** Service Name or SID, port 1521, Thin mode. SID is unverified. Driver `oracledb`.
- **Catalog / query / writes:** same platform path as MySQL. Column comments are a separate dictionary. Defaults: `VARCHAR2(255)` / `NUMBER(19)`.
- **Limits:** views and synonyms, metadata only. Queries with LOB columns are unsupported. 19c, SID, and temporal-column maintenance are unverified. Free 23 Thin is not a substitute for 19c.

### Redis

Not SQL. Objects: **DB → Key**, plus type and TTL. A page is a **SCAN cursor** (empty pages and duplicates happen; the UI dedupes and says when the cursor is unfinished). Requires Redis 7.2+.

- **Connect:** standalone, one sentinel, or one cluster seed. Optional ACL, TLS, custom CA. Sentinel asks one address for the master; username/password apply to both. Cluster uses the host as a seed; DB is 0.
- **Two connections on purpose:** one Redis-CLI-quoted command per request, then close. Not a shell.
- **Keys:** String / Hash / List / Set / ZSet / TTL, paged large collections, set/remove TTL, delete, edit basic values. Binary as Base64.
- **Host:** `DSH_REDIS_COMMAND_BLACKLIST` (default empty). AI `redis_execute` is SIT-only; UAT/PVT keep status / keys / value-read.
- **Unverified:** Cluster / Sentinel against production clusters.

### Kafka

Read-only inspect. Objects: **topic / partition / existing consumer group**. Peek is a bounded read of **one** partition. It does not join the business group or commit offsets.

- **Connect:** none, TLS + custom CA, SASL PLAIN, SCRAM-SHA-256 / 512. PLAIN/SCRAM may skip TLS; when TLS is on, certificates are verified (no skip-verify). Kerberos, OAuth, and client certificates are out of scope.
- **Work:** list topics, describe partitions, bounded peek. Result is messages plus metadata, not a SQL grid.
- **Does not:** produce, create/delete topics, change configs, or move consumer offsets.
- **Plug-in:** client `standard` + host `standard-text`. New sources should copy this path, not MySQL.

## How it works

The plugin is one **extracted data-source platform**, not four mini-IDEs. Adding a source is not cloning the product. Removing a source should leave the platform standing.

### A run, end to end

```mermaid
flowchart LR
  UI["Workbench / AI Query"] --> Doc["Document text + context + revision + controller"]
  Doc --> Auth["Host authorize: session, generation, SIT/UAT/PVT, actor"]
  Auth --> Worker["Worker whitelist: mysql2 / oracledb / redis / kafkajs"]
  Worker --> Proj["Source result projection"]
  Proj --> Chrome["Shared result chrome + execution record"]
  Chrome --> Hist["Conversation history"]
```

1. The Database tab is a DSH right-sidebar slot. Connections live in the workspace file; query tabs and AI documents live per conversation, so two chats do not share a dirty editor.
2. The browser never loads a driver. It calls authenticated `/plugins/database/...`. Uncredentialed requests get 401.
3. Host `ConnectionService` binds the live session, connection `generation` (an edit that reconnects invalidates in-flight work), and environment. Actors are `user` or `ai` — the browser cannot mint a trusted AI identity.
4. The source module turns text into a **worker action + input** (`prepareText` / SQL adapter). Runtime checks the action against a whitelist. Kafka only allows the read actions it parsed; it will not produce.
5. The worker runs with cancel and deadline. Peek creates `dsh-peek-{uuid}`, `autoCommit: false`, seeks an offset, then stops and disconnects. Redis command console opens a connection, runs **one** CLI-quoted command, and closes it — `SELECT` / `MULTI` do not leak onto SCAN.
6. Numbers become strings in `formatFetchedValue` before they hit the grid, so `9007199254740993` stays that digit string. BLOB is a placeholder, not a binary dump into chat.
7. One execution record: identity, status, events. Success / failure / cancel / empty / partial / **unknown** (timeout after a write may have already hit the server — the UI says unknown, it does not pretend rollback).

### The document humans and the model share

Standard sources (Redis, Kafka) use `ExecutionDocument`: `{ text, context, revision, controller }`.

- AI may write the document only while `controller === 'ai'`. Your first keystroke sets `controller: user` (`user-edit`). Further AI publish is rejected: *用户已接管 AI Query*.
- Hand-back is explicit (`return-ai`). Run requires `controller === 'user'` and a matching `revision`, so a tab that missed a remote edit cannot fire.
- `context` is part of the document (Redis DB, Kafka has no extra target today). Switching DB bumps revision and **keeps** controller, then cancels the old request scope.

SQL still uses `SharedQuery` on the same AI Query tab (legacy path: same takeover rules, same history). The product promise is the same: **one document, one run, one record.**

`SourceWorkspace` is the shared chrome: overview / query / AI Query / knowledge. A source only supplies Editor, Result, `runText`, and tree bindings — it does not wrap a second workbench.

### What is extracted vs what stays native

```mermaid
flowchart TB
  subgraph dsh [DeepSeek Harness]
    Tab[Database tab]
  end
  subgraph platform [Extracted once]
    Conn[Connection shell / secrets / SIT UAT PVT]
    WS[Workspace / documents / tabs]
    EX[Execution identity / cancel / history]
    AI[AI Query / takeover / revision]
    KN[Knowledge publish]
    UI[Shared tree / toolbar / result chrome]
  end
  subgraph modules [Source modules]
    MySQL
    Oracle
    Redis
    Kafka
  end
  subgraph host [Host workers]
    W[Drivers never in the browser]
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

| Shared once | Left at the source |
| --- | --- |
| Tab, add/test/connect, DPAPI, conversation isolation | Host/port vs Service/SID vs SASL vs Redis mode |
| Tabs, loading/error/empty, result frame | Tree: database / schema / DB / topic |
| Execution identity, cancel, history | `LIMIT`, SCAN cursor, peek offset |
| AI Query, takeover, revision | Command language, authorize, AI args → native text |
| `knowledge.json` publish (human confirm) | Fingerprint / analysis per source |

We do **not** require every source to have `database`, every tree to be Schema/Table, or every result to be a 2-D grid.

| Source | Client | Host execution | Why |
| --- | --- | --- | --- |
| MySQL | `legacy-sql` | `legacy-adapter` | Catalog, batch, InnoDB DML/DDL grid, transactions — still the SQL compatibility path |
| Oracle | `legacy-sql` | `legacy-adapter` | Same path; dialect owns identifiers, `OFFSET FETCH`, comments |
| Redis | `standard` | `legacy-adapter` | Standard pages; command isolation + SCAN still go through the Redis adapter |
| Kafka | `standard` | `standard-text` | `normalizeContext` / `prepareText` / `authorize` → worker whitelist. **Copy this for a new source.** |

Knowledge save does not execute. A trial run uses the same authorize path. Old `sql-templates.json` still reads once into `knowledge.json`.

Rules we keep: one authority per piece of state; AI and humans are the same pipeline; fail visibly; do not unify Kafka offsets with Redis SCAN; adding a source should not rewrite MySQL.

Longer notes: [docs/README.md](docs/README.md), [architecture](docs/data-source-architecture.md), [onboarding a source](docs/data-source-onboarding.md).

## Configuration and limits

### Environment

| Environment | Human | AI |
| --- | --- | --- |
| SIT | Account permissions apply | Unredacted cells; DML allowed; Redis `redis_execute` allowed |
| UAT / PVT | Production-like connections read-only | Writes refused; Redis execute refused |
| DDL | Human confirmation | Not auto-run |

See [SECURITY.md](SECURITY.md).

### What we do not claim

- Views and synonyms: metadata only. Oracle queries with LOB columns are unsupported.
- Oracle 19c, SID, and temporal-column maintenance are unverified.
- Redis Cluster / Sentinel and production clusters are unverified.
- Kafka does not produce, change offsets, or support Kerberos / OAuth / client certificates.
- Live Desktop GUI and real model `callId` correlation remain unrun.

| Environment | Notes |
| --- | --- |
| Node.js | ≥ 24; isolated loads use Desktop's bundled Node |
| Harness | Verified `0.1.2-rc.1`, `0.1.7-rc.2`, `0.2.0-rc.2` |
| MySQL | 8.4.x throwaway containers; 8.0.32 read-only check |
| Oracle | Free 23 Thin mode; not a substitute for 19c / SID |
| Redis | 8.10.2 throwaway containers |
| Drivers | mysql2 3.24.4, oracledb 7.0.1, redis 6.2.1, kafkajs 2.2.4 |

## Troubleshooting

| Problem | What to do |
| --- | --- |
| `/plugins/database/connections` collides | Do not install an older remote-exec that still embeds the database workbench. This plugin can sit beside `dsh-remote-exec` |
| `dsh` is not recognized on Desktop | Open **DSH Terminal** from the tray; Desktop does not put `dsh` on PATH |
| Plugin does not appear after add | Restart the Web Profile and refresh. Confirm `cordis.patch.yml` was not duplicated by hand |
| Oracle query fails on LOB columns | Unsupported in the current version; metadata-only for views/synonyms |
| Redis `SELECT` in the console does not change the key tree | Expected: the console closes its connection; pick a DB in the tree |
| Kafka peek moves a business consumer | It does not. Peek uses a temporary `dsh-peek-*` group, `autoCommit: false`, then disconnects |

## FAQ

**Will the model see my passwords?**

No. Passwords and custom CAs are stripped from connection snapshots, logs, query history, and model-facing output. Remember-password (Windows DPAPI, current user) never round-trips to the browser.

**Will the model see row data?**

On **SIT**, yes — cells go unredacted. That is the point of asking the model about a result. Use **UAT / PVT** when the connection is production-like: AI writes are refused and Redis execute is refused.

**Is this a replacement for Navicat?**

No. It is the workbench *inside* DSH: catalog, query, AI Query, history next to the conversation. Heavy DBA work still belongs in a dedicated client. Controlled DML/DDL here is parameterized, previewed, and confirmation-gated — not a second general SQL IDE.

**Can I add PostgreSQL / Mongo / ES?**

The platform is built for that: copy Kafka's `standard` + `standard-text` module (descriptor, worker, authorize, explorer, knowledge). Do not clone MySQL. There is no PostgreSQL/Mongo/ES implementation in this package today.

**Why is Kafka peek slow to disconnect?**

The worker stops and disconnects the temporary consumer with a timeout. If cleanup fails, the worker is recycled (`recycleWorker`) instead of leaking a group on a dead connection.

## Development and community

```sh
npm ci --legacy-peer-deps
npm run check
```

Live-database scripts create uniquely labelled Docker containers and delete them. Do not point them at business databases.

```sh
npm run test:mysql
npm run test:oracle
DSH_TEST_REDIS=1 npm run test:host
DSH_TEST_DATABASES=1 npm run test:host
```

Isolated host: `DSH_DESKTOP_APP=... npm run test:host`. `DSH_TEST_ALLOW_VERSION` is diagnostic only.

- Bugs and usage questions: [GitHub Issues](https://github.com/zhuoxiaoshuai/dsh-database/issues)
- Vulnerabilities: privately via [SECURITY.md](SECURITY.md)
- After the repository is at least one day old, list it on [awesome-dsh-plugin](https://github.com/awesome-dsh-plugin/awesome-dsh-plugin) as `data/plugins/zhuoxiaoshuai__dsh-database.yml` (topic `dsh-plugin` is already set)

```yaml
url: https://github.com/zhuoxiaoshuai/dsh-database
name: zhuoxiaoshuai/dsh-database
category: dev
description:
  en: MySQL, Oracle, Redis, and Kafka workbench for DeepSeek Harness, with a shared execution path for humans and the model.
  zh: DeepSeek Harness 的 MySQL、Oracle、Redis、Kafka 工作台，人和模型共用同一套连接、执行和记录。
```

## License

[MIT](LICENSE)

# Security

Please report vulnerabilities privately. Do not open a public issue with credentials, connection strings, query results, or production hostnames.

## What this plugin can reach

Once installed, it talks to the databases and brokers you add: MySQL, Oracle, Redis, Kafka, and Nacos. Treat every saved connection as equivalent to giving the host process that account.

- Passwords are not stored unless you check **记住密码**. On Windows they are encrypted with the current user DPAPI. Unchecked passwords stay in memory for the session only.
- Passwords and custom CA material are omitted from connection snapshots. Saved connections do not store those secrets in plaintext.
- Driver and broker errors are returned as the server sent them, to the UI, HTTP, execution message, and model. They are not rewritten, truncated, or redacted. A server error can therefore contain whatever text the server included.
- Connection files live under `$DSH_HOME/database/`. Do not commit that directory.

## Environment policy

| Environment | Human | AI |
| --- | --- | --- |
| SIT | Read and write according to account privileges. Grid DML/DDL and Kafka writes require human preview/confirmation. | SQL may run INSERT/UPDATE/DELETE without a second confirmation. AI SQL results return cell values **unredacted**. Redis `redis_execute` and Kafka write tools are allowed. |
| UAT / PVT | Grid DML/DDL and Kafka writes blocked. Both ordinary human SQL and human-controlled coedit SQL auto-commit according to account privileges. Human Redis commands remain available subject to ACL and command validation. The trusted initiator chooses the manual lane; HTTP cannot claim an AI identity, lane or authorization proof. | SQL is read-only. Redis and Kafka tools are limited to their structured read operations. |

DDL requires human confirmation. Kafka PEEK does not commit business consumer offsets. Kafka writes are SIT-only after trusted Host checks: single or limited batch publishing, compacted-topic tombstones, explicit `dsh-test-` topic creation, and offset changes for groups without running members. The human UI confirms the target; AI tools may execute directly under document control and connection-generation checks. Broker ACL remains authoritative, and automatic topic creation is disabled. An interrupted write may have succeeded and is recorded as unknown rather than replayed. See the [Kafka guide](docs/datasource/kafka.en.md) for limits and constraints.

SQL parsing fails closed. EXPLAIN supports SELECT only. Batches are authorized before dispatch and return per-step receipts; committed and unknown writes are never automatically replayed. Coedit text, target, revision and controller are one ExecutionDocument. Missing or stale revisions require refresh. Lost write receipts are unknown, including after restart; historical results cannot replace a different generation or document target.

The database account and the environment tag are the write gates. This plugin is not a substitute for database access control.

## Unknown writes and persistence recovery

Per-step receipts show committed, failed, unknown and unexecuted items independently. Unknown SQL history can be viewed or copied but cannot be applied as a write retry. Verification opens the original target without executing the write; a changed generation requires explicitly choosing the current connection. Grid edits remain frozen until a new read succeeds after old drafts are discarded.

The optional storage status distinguishes execution-history persistence from workspace save failures. Retrying history persistence writes only the latest in-memory ledger, accepts no record content or path, and never accesses a database. Missing status fields do not confirm reliable persistence.

AI connection import registers settings only and never logs in. Kafka supports brokers, TLS and the existing SASL mechanisms; nonempty passwords, private keys and CA bodies are rejected. Credentials remain in the existing human connection/login flow.

## Nacos 2.4.3

Human configuration writes are available in all environments after preview and confirmation, subject to remote account permissions. AI configuration writes are SIT-only and use trusted session identity. Browser requests cannot select AI identity. The preview validates scope and baseline; Nacos enforces remote WRITE permission at execution. Signed previews bind actor/session/generation/target/version/change and expire after five minutes.

AI reads redact format-aware sensitive fields and credential patterns. AI updates apply unique exact edits outside protected ranges to the original text, preserving secrets; invalid, ambiguous or encrypted content is not editable by AI. Unknown formats return metadata. Detection is conservative but cannot discover arbitrary application-specific secrets. SQL cell redaction rules are not reused as configuration grammar rules.

Tokens live in Worker memory. Fixed API paths use saved HTTP/HTTPS endpoints and system trust; redirects are rejected. Endpoint registration follows existing connection authorization, not a new network allowlist. Operators must restrict host network access and who can register endpoints. Response bodies have a 2 MiB limit; request JSON has a 512 KiB limit. Nacos raw errors, configuration bodies and authentication details are not written to operation history or logs.

Updates use casMd5. Create/delete have an acknowledged remote concurrency window. Missing write receipts stay unknown and are never replayed. Existing execution records reject reused previews while retained; there is no separate persistent proposal store. See the [Nacos guide](docs/datasource/nacos.en.md).

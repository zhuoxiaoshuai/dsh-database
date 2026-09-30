# Security

Please report vulnerabilities privately. Do not open a public issue with credentials, connection strings, query results, or production hostnames.

## What this plugin can reach

Once installed, it talks to the databases and brokers you add: MySQL, Oracle, Redis, and Kafka. Treat every saved connection as equivalent to giving the host process that account.

- Passwords are not stored unless you check **记住密码**. On Windows they are encrypted with the current user DPAPI. Unchecked passwords stay in memory for the session only.
- Passwords and custom CA material are stripped from connection snapshots, logs, query history, and model-facing output.
- Connection files live under `$DSH_HOME/database/`. Do not commit that directory.

## Environment policy

| Environment | Human | AI |
| --- | --- | --- |
| SIT | Read and write according to the database account | SQL may run INSERT/UPDATE/DELETE without a second confirmation. Cell values are sent to the model **unredacted**. Redis `redis_execute` is allowed. |
| UAT / PVT | Production-like connections stay read-only in the workbench | AI writes are refused. Redis is limited to status, key scan, and value read tools. |

DDL still requires a human confirmation step. Kafka does not commit consumer offsets and does not send messages in the current version.

## What we do not claim

Oracle 19c / SID, Redis Cluster / Sentinel, and production clusters have not been verified in this tree. Do not treat the alpha as a production access-control product: the database account and your environment tag are the real gates.

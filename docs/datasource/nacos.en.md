# Nacos guide

## Scope and connection

The supported API baseline is Nacos 2.4.3. Nacos uses the existing connection tree, pages and operation history, with no fake SQL/command document or knowledge library.

Configure HTTP/HTTPS, host, port, context path (default `/nacos`), default Namespace ID, username and password. HTTPS uses system trust. Private CAs, mutual TLS, cluster discovery and other Nacos versions are outside this release. Legacy records receive `http` and `/nacos`; the former database field remains the default Namespace. The label `2.4.3 API` describes the implementation, not a detected server version.

Credentials use existing secure storage. Tokens stay in Worker memory. Namespace changes do not rebuild login. Requests use saved endpoints and fixed API paths; tools cannot provide arbitrary URLs, and redirects are rejected.

## Pages

Browse Namespaces and search configurations by Group/Data ID or services by Group/name. Configuration, history, service and instance lists use 50 items per page, at most 100. No background full scan occurs. Namespace and listener APIs do not offer equivalent pagination; responses are bounded and the UI displays at most 200 entries, with Namespace filtering.

Edit YAML, JSON, Properties or text without automatic formatting. Read history and compare versions with current content; rollback is not implemented. Listener data comes from GET sampling and may include client MD5 values. Empty listeners do not prove the configuration was ignored. Instance healthy/enabled/weight/metadata values are registry reports, not proof of application availability.

Each page keeps its own connection, Namespace, Group and resource target. Changing a list filter never changes an existing draft's publish target. Dirty drafts require confirmation before closing, leaving a connection or deleting a connection; disconnects preserve drafts. Refresh preserves dirty content and shows a comparison. Discard-and-read is explicit.

## Writes and receipts

Human create/update/delete works in SIT, UAT and PVT subject to the remote account. Preview the target and diff, then confirm. The stateless signed preview lasts five minutes and binds session, connection generation, actor, target, baseline and change digest. It contains no body or credentials and creates no proposal store.

Preview checks the target and baseline. Nacos checks remote WRITE permission at execution; a successful preview is not permission approval. Update uses `casMd5`. Create checks absence and delete re-reads the expected MD5, but these two operations still have a remote concurrency window without atomic conditional create/delete.

A sent write with a timeout, disconnection or lost receipt becomes `unknown`, with no automatic retry. Read the target again; matching content does not retroactively confirm the original request. An executed preview cannot be reused while its existing operation record is retained. A genuinely new operation requires a new preview.

## AI

Read tools: `nacos_status`, `nacos_namespaces`, `nacos_search_configs`, `nacos_get_config`, `nacos_config_history`, `nacos_config_listeners`, `nacos_search_services`, `nacos_service_detail`. Service detail includes one cluster's paged instances, defaulting to the first cluster; request other clusters explicitly.

Write tools: `nacos_preview_config_change`, `nacos_publish_config`, `nacos_delete_config`. AI writes are SIT-only. Show the redacted preview before executing the same change with its token; no additional UI approval is introduced. Trusted tool context supplies identity. Browser HTTP always uses the human identity. Apart from connection discovery, tools require connection and generation; resource operations require explicit Namespace ID (empty for public), and configurations require Group and Data ID.

AI updates use unique, nonoverlapping exact replacements in non-sensitive text. Host applies edits to the original, preserving secret bytes, comments and formatting. AI cannot change the format or write a redacted full document back. New configurations must not include detected credentials. JSON/YAML/Properties field ranges and credential patterns protect passwords, tokens, private keys and similar values. Invalid or ambiguous syntax, duplicate keys, YAML references/tags, Properties escaping/continuations and encrypted content fail closed for editing; unsupported content returns metadata only. Authorized deletion of an entire encrypted configuration remains available.

Detection cannot identify every application-specific secret. Use descriptive field names and minimally privileged remote accounts. Configuration bodies, credentials, tokens and raw remote error bodies are excluded from execution history and debug logs. Human configuration reads contain actual content.

## Limits and exclusions

Requests are limited to 512 KiB of serialized UTF-8 JSON; each remote response is limited to 2 MiB. Oversized content fails explicitly and is never truncated for publishing. Reads may refresh authentication and retry once on a definite expired token. Writes never replay. Concurrent callers share token refresh and may cancel independently.

No cross-environment comparison, rollback, content search, connection extraction, instance changes, gray releases, bulk import/export or troubleshooting orchestration is added. Existing Agent tools compose cross-plugin diagnosis.

References: [Open API](https://nacos.io/en/docs/v2/open-api/) and the [2.4.3 v2 configuration controller](https://github.com/alibaba/nacos/blob/2.4.3/config/src/main/java/com/alibaba/nacos/config/server/controller/v2/ConfigControllerV2.java). See [implementation evidence](../nacos-p0-implementation.md) for validation and NOT_RUN items.

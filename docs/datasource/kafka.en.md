# Kafka

Kafka can search topics and consumer groups, inspect lag and topic settings, locate offsets by time, and scan bounded ranges. SIT supports single and limited batch publishing, replaying complete messages, compacted-topic tombstones, test topic creation, and inactive consumer-group offset changes.

```text
TOPICS SEARCH "orders" CURSOR 100
TOPIC_GROUPS "orders"
GROUPS SEARCH "billing"
GROUP "billing" TOPICS
GROUP "billing" TOPIC "orders"
PEEK "orders" PARTITION 0 FROM LATEST LIMIT 20
PRODUCE {"topic":"orders","key":"case-1","value":"hello"}
TOPIC_CONFIG "orders"
TIME_OFFSETS {"topic":"orders","timestamp":1760000000000}
SCAN {"topic":"orders","partitions":[0,1],"timestamp":1760000000000,"key":"case-1"}
PRODUCE_BATCH {"topic":"orders","messages":[{"value":"first"},{"value":{"base64":"AAE="}}]}
TOMBSTONE {"topic":"orders","key":"case-1"}
CREATE_TOPIC {"topic":"dsh-test-example","partitions":1,"replicationFactor":1,"cleanupPolicy":"compact"}
SET_GROUP_OFFSETS {"groupId":"billing","topic":"orders","expected":{"0":"12"},"offsets":{"0":"10"}}
```

Replace `"orders"` with a topic you actually have.

## Command builder and multiple commands

The Query toolbar's **Generate command** button provides forms for all 14 commands (16 operation variants). Topic and group fields load searchable, paged candidates on demand and accept manual input. Messages, repeated headers and partition offsets use form rows instead of handwritten JSON; text and Base64 are supported. Time inputs show the browser time zone and convert to millisecond timestamps. Offset changes can fetch current positions; unreadable positions are never treated as uncommitted.

Generate appends a command on a new line without executing it. One undo removes that append. Forms are kept in memory for this workspace and cleared on connection generation changes.

Run executes the selection, or the entire editor when nothing is selected, in order. Top-level newlines and semicolons separate commands; multiline JSON and delimiters inside strings remain intact. The editor allows 512 KiB characters and each run at most 50 commands; existing per-command and HTTP request limits still apply. All commands are validated first and writes receive one combined confirmation before execution. Each command has a result tab; Messages shows progress, errors and execution IDs. Failure, cancellation or an unknown outcome stops subsequent commands without rolling back completed operations. Already dispatched writes may have taken effect: verify them before retrying. Results retain their executed text snapshot. AI Query and the knowledge library still execute one command at a time.

Authentication: none, TLS+CA, PLAIN, or SCRAM-SHA-256/512. PLAIN and SCRAM can skip TLS. When TLS is on, certificates are always verified. Kerberos, OAuth, and client certificates are not supported. All writes require SIT and broker permission. Topic creation is restricted to the `dsh-test-` prefix.

PRODUCE retains its text form and accepts explicit Base64 bytes for key, value, and headers. Each decoded message is limited to 64 KiB. A batch sends at most 10 messages to one topic, at most 256 KiB in total, and stops after a failure or unknown outcome. Human writes show a target and change confirmation; AI can execute directly under coedit ownership, generation, SIT, and Host validation. Lost acknowledgements, timeout, or cancellation leave the result unknown; inspect before deciding whether to resend. Execution summaries omit message content, but coedit drafts store commands, so do not put credentials or private content in them. Existing records cannot be edited in place. Tombstones apply only to compacted topics and compaction is asynchronous.

Peek uses a temporary group `dsh-peek-{uuid}` with `autoCommit: false`. Those groups stay hidden in GROUPS. If stop or disconnect times out, the worker is dropped and a new one is started.

Lists return at most 100 names per page. “下一页草稿” fills the next command without executing it; changing lists can contain duplicates or omissions. Chinese completion uses only names already read on this connection and generation, shared by query, AI and knowledge editors. Messages retain raw text and binary previews; complete JSON can be formatted, copied or exported from the current bounded result. Export never reads more messages. Every Kafka response is bounded to 1 MiB; incomplete reads and truncated details are labelled. If filtered/control records do not prove the captured range was traversed, PEEK remains incomplete at its deadline.

## Topic and consumer-group inspection

Topic details provide partitions, messages and associated groups. Associations distinguish current assignments from historical commits; selecting a group opens that Group / Topic's partition consumption directly. Return restores the source Topic without changing query drafts. Partition details include Consumer ID, Client ID and Host; group details provide Topic summaries and members with assignment counts.

The group list loads state and members for the current page. Load consumption summaries explicitly to obtain Topic counts, total Lag and known abnormal/uncommitted partition counts. Missing commits, offsets outside the retained range and unreadable metrics remain distinct. Unknown or invalid offsets never appear as zero Lag. Incomplete totals show an unknown total, a known subtotal and coverage. Offset differences are not exact message counts; zero Lag does not establish downstream completion.

`TOPIC_GROUPS` and `kafka_topic_groups` scan at most 100 candidate groups per page with four concurrent candidates and a 30-second deadline. An empty matching page can still have a next cursor. Only a complete scan without failures establishes that no associations were found. Permissions, assignment decoding, deadlines and truncation preserve incomplete status. Changing lists can cause duplicates or omissions. Opening the Topic list does not scan group associations.

Details include collection time and independent refresh. Successful complete inspections are cached per connection Worker for 15 seconds, at most 100 entries / 8 MiB; manual refresh bypasses the cache and reconnection discards it. Separate Admin reads are not an atomic Broker snapshot.

See the [Kafka read-only review](../kafka-readonly-review.md), [earlier single-message record](../plans/kafka-produce-implementation.md), and [Kafka repair implementation record](../plans/kafka-repair-implementation.md) for dated acceptance evidence; these records do not establish live acceptance of later source changes.

Use the implementation records for `NOT_RUN` items, including final-code live reruns, installed environments and real model calls.

[Back to README](../../README.md) · [中文](kafka.md)

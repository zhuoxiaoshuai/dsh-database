# Kafka

Kafka can search topics and consumer groups, inspect lag and topic settings, locate offsets by time, and scan bounded ranges. SIT supports single and limited batch publishing, replaying complete messages, compacted-topic tombstones, test topic creation, and inactive consumer-group offset changes.

```text
TOPICS SEARCH "orders" CURSOR 100
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

Authentication: none, TLS+CA, PLAIN, or SCRAM-SHA-256/512. PLAIN and SCRAM can skip TLS. When TLS is on, certificates are always verified. Kerberos, OAuth, and client certificates are not supported. All writes require SIT and broker permission. Topic creation is restricted to the `dsh-test-` prefix.

PRODUCE retains its text form and accepts explicit Base64 bytes for key, value, and headers. Each decoded message is limited to 64 KiB. A batch sends at most 10 messages to one topic, at most 256 KiB in total, and stops after a failure or unknown outcome. Human writes show a target and change confirmation; AI can execute directly under coedit ownership, generation, SIT, and Host validation. Lost acknowledgements, timeout, or cancellation leave the result unknown; inspect before deciding whether to resend. Execution summaries omit message content, but coedit drafts store commands, so do not put credentials or private content in them. Existing records cannot be edited in place. Tombstones apply only to compacted topics and compaction is asynchronous.

Peek uses a temporary group `dsh-peek-{uuid}` with `autoCommit: false`. Those groups stay hidden in GROUPS. If stop or disconnect times out, the worker is dropped and a new one is started.

Lists return at most 100 names per page. “下一页草稿” fills the next command without executing it; changing lists can contain duplicates or omissions. Chinese completion uses only names already read on this connection and generation, shared by query, AI and knowledge editors. Messages retain raw text and binary previews; complete JSON can be formatted, copied or exported from the current bounded result. Export never reads more messages. Every Kafka response is bounded to 1 MiB; incomplete reads and truncated details are labelled. If filtered/control records do not prove the captured range was traversed, PEEK remains incomplete at its deadline.

See the [Kafka read-only review](../kafka-readonly-review.md), [earlier single-message record](../plans/kafka-produce-implementation.md), and [Kafka repair implementation record](../plans/kafka-repair-implementation.md) for dated acceptance evidence; these records do not establish live acceptance of later source changes.

Use the implementation records for `NOT_RUN` items, including final-code live reruns, installed environments and real model calls.

[Back to README](../../README.md) · [中文](kafka.md)

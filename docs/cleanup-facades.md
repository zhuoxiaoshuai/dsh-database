# 保留的兼容门面与有意不合并的近似重复

D0–D3 的冗余清理删除了根/中间层 re-export 别名、重复注册表和重复规则实现。下面这些文件**有意保留**，不是漏删；新增“看似重复”的代码前先看本表。

## 保留的门面

| 文件 | 保留原因 | 复查 |
|---|---|---|
| `src/host/shared/connection-permission.mjs` | `lib/shared/connection-permission.mjs` 的源码路径镜像。`src/host/*.mjs` 以 `./shared/connection-permission.mjs` 引用，构建后该相对路径必须落在 `lib/shared/`，源码树因此需要同名文件。 | 2026-10 |
| `src/host/shared/limits.mjs` | 同上，对应 `lib/shared/limits.mjs`。 | 2026-10 |
| `src/shared/connection-permission.ts` | client/host 共用类型入口：`Environment` 类型 + 三个权限函数。 | 2026-10 |
| `src/shared/limits.ts` | 同上，跨层查询/结果限额的类型入口。 | 2026-10 |
| `src/shared/primary-keys.ts` | client → host 边界门面；client 不直接 import `src/host/*`，由它转出 `resolvePrimaryKeys`。 | 2026-10 |

`test/structure-gates.test.mjs` 会检查这 5 个文件存在、并且没有新的 re-export shim 出现在 `src/client/workspace`。

## 有意不合并的近似重复

| 位置 | 为什么不合并 |
|---|---|
| `src/host/query-policy.mjs` 与 `src/shared/workbench.ts` 的 `quoteIdentifier` | 前者做 Host 参数校验并走数据源 driver 引用标识符；后者只按方言能力加引号。职责不同。 |
| `splitStatements` 与 `enumerateStatements`（都在 `src/shared/sql-lex.ts`） | 语义不同：前者保留 Host 既有的 `--` / `#` / 反斜杠规则用于授权切分，后者是方言感知的编辑器定位器。`test/sql-statement-split.test.mjs` 显式钉住三处差异，合并前必须先决定是否接受语义变化。 |
| `query-sync.ts` 的 `ownsDocumentResult` 与 `use-execution-document.ts` 的 `resultOwner()` | 前者始终按 `context` 全量比较；后者对 mysql/oracle 只比较 `schema`。两侧语义不同，合并会改变其中一侧。 |
| `sanitizeSharedQuery` 与 `sanitizeExecutionDocument` 的修订号归一 | 前者接受字符串数字（`Number(raw.revision)`），后者只接受整数。属于两个持久化 schema 的历史差异。 |
| `ai-query-bus.ts` 的“执行中”判定 与 `ai-executions.tsx` 的 `isTerminalStatus` 判定 | 前者把 `awaiting_confirmation` 视为未完成，后者相反。是有意的产品差异。 |

## 新增门面的规则

1. 先确认它不是上面这些“有意不合并”之一。
2. 门面必须说明构建路径或边界原因，并登记在本表。
3. `test/structure-gates.test.mjs` 的 `RETAINED` 列表同步更新。

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

`test/structure-gates.test.mjs` 会检查这 5 个文件存在、`src/client` 与 `src/host` 没有新的整文件 re-export shim、也没有跨文件重复实现（豁免名单当前为空）。

## 有意不合并的近似重复

| 位置 | 为什么不合并 |
|---|---|
| `src/host/query-policy.mjs` 与 `src/shared/workbench.ts` 的 `quoteIdentifier` | 前者做 Host 参数校验并走数据源 driver 引用标识符；后者只按方言能力加引号。职责不同。 |
| `splitStatements` 与 `enumerateStatements`（都在 `src/shared/sql-lex.ts`） | 语义不同：前者保留 Host 既有的 `--` / `#` / 反斜杠规则用于授权切分，后者是方言感知的编辑器定位器。`test/sql-statement-split.test.mjs` 显式钉住三处差异，合并前必须先决定是否接受语义变化。 |
| `query-sync.ts` 的 `ownsDocumentResult` 与 `use-execution-document.ts` 的 `resultOwner()` | 前者始终按 `context` 全量比较；后者对 mysql/oracle 只比较 `schema`。两侧语义不同，合并会改变其中一侧。 |
| `sanitizeSharedQuery` 与 `sanitizeExecutionDocument` 的修订号归一与文本截断 | 修订号：前者接受字符串数字（`Number(raw.revision)`），后者只接受整数。文本上限也不同：前者在 `src/shared/workbench.ts` 按 `SQL_FIELD_MAX_LENGTH`（32768）截断 `sql`，后者在 `src/shared/execution-document.ts` 按 `textLimit` 截断 `text`（普通源 65536、kafka 512 KiB）。属于两个持久化 schema 的历史差异。 |
| `ai-query-bus.ts` 的“执行中”判定 与 `ai-executions.tsx` 的 `isTerminalStatus` 判定 | 前者把 `awaiting_confirmation` 视为未完成，后者相反。是有意的产品差异。 |

## 2026-10-23 收敛同步

本轮把下面几处近似重复收敛到单一实现；遇到同类需求先复用这些入口，不要再各写一份。

- `src/shared/execution-document.ts` 新增 `isDocumentRevision`／`assertDocumentRevision`，文档修订号的校验与比较统一走这两个函数（原先约 10 处直接比较、7 种文案）。各处文案按原样逐处传入，文案保持不变，未统一。
- `src/host/text-operation-runner.ts` 派发前的 context 复核改用 `sameStringMap`，不再用 `JSON.stringify` 逐键比较。`JSON.stringify` 对 key 顺序敏感，等价 context 会被误判为改过目标；这是行为修复，不是等价改写。
- `nativeDriverError`／`driverErrorFields` 从 mysql／oracle driver 收敛到 `src/host/connect-error.mjs`，两个 driver 复用同一实现；mysql／oracle maintenance 的 `wanted` 收敛为共享 `DML_PRIVILEGES`（`src/host/data-sources/maintenance-error.mjs`）。

## 尚未收敛的根因

以下重复有共同根因，已知但尚未收敛，不是漏删；动到这些位置时成对处理，合并前先决定取舍。行号为 2026-10-23 核对结果，以符号名／函数名为准。

1. SQL 授权切分与方言感知切分的语义差异：`src/shared/sql-lex.ts:117` 的 `splitStatements`（保留 Host 既有的 `--` / `#` / 反斜杠规则，用于授权切分）与 `src/shared/sql-lex.ts:78` 的 `enumerateStatements`（方言感知的编辑器定位器）。差异被 `test/sql-statement-split.test.mjs:27-42` 显式钉住三处（`--x` 无空格注释、双引号转义、`#` 注释），合并前必须先决定是否接受授权语义变化。**风险已核对为保守失败，不是授权绕过**：`src/host/query.mjs:241` 按同一个 `splitStatements` 切分后逐段授权、逐段执行，MySQL 连接显式 `multipleStatements: false`（`src/host/data-sources/mysql/connection.mjs:8`），因此切分不一致只会让语句被整段判 write 或直接报 SQL 错误，不会让未授权的语句被执行。真正要取舍的是语句计数（`MAX_AI_STATEMENTS`）、`--x`／`#`／反斜杠三类文本的正确性与 UX，以及两套词法器的维护成本。
2. `SharedQuery` 与 `ExecutionDocument` 双模型。4 处转换：`src/host/connection-service.ts:316`（`getSharedQuery` 由文档重建旧模型）、`src/host/connection-service.ts:547`（`#layout` 把旧模型迁移为 `aiDocument`）、`src/host/execution-document-service.ts:23`（`read` 由 `sharedQuery` 建文档）、`src/host/saved-connections.ts:176`（`publicConnection` 把文档投影回 `sharedQuery`）。4 处遗留读取：`src/host/ai-tools.ts:90`、`src/host/workbench-editors.ts:20`、`src/client/schema/refresh.ts:81`、`src/client/sql/workspace-bindings.tsx:86`。
3. 两套数据源注册层：`src/host/data-sources/modules.ts:34,60` 的 `hostModules` 与派生的 `getSourceRuntime`，对 `src/host/data-sources/sql-registry.mjs:5`／`src/host/data-sources/redis-registry.mjs:4`（基于 `provider-registry.mjs` 的 SQL／Redis Provider 注册表）。
4. npm 默认安装的 peer 冲突：`@deepseek-ai/dsh-api-session-controller` → `@deepseek-ai/dsh-agent-presets` → `@deepseek-ai/cordis-plugin-include`（`^1.0.7` 解析到 1.0.10）要求 `@deepseek-ai/cordis@~4.0.5`，根项目固定 `4.0.2`（`package.json:152,191`）；CI 用 `npm ci --legacy-peer-deps` 绕过（`.github/workflows/ci.yml:19`）。2026-10-26 已把解析策略固化到仓库 `.npmrc`（`legacy-peer-deps=true`），`npm ci`／`npm install` 不带参数即可得到与 lockfile 一致的树；真正消除仍需上游对齐 peer 范围，或把 `@deepseek-ai/cordis` 升到 4.0.5 后重新生成 lockfile（需联网重解依赖树，本轮环境无法验证）。

## 2026-10-26 收敛同步

- UI 验收两条长期失败的根因已定位并修复，且**均为脚本／fixture 问题，产品行为未改**：
  - `npm run test:theme-ui`：Kafka 来源有意 keep-alive 双挂载两个 `KafkaOverview`（`src/client/data-sources/kafka.tsx:67`，未激活者 `hidden` 保活），脚本用类选择器 `.db-search-tree-toggle` 定位抽屉开关必然撞两个节点。改为按可访问名定位（`getByRole('button', { name: '打开 Topic 列表', exact: true })`），断言强度不变，strict mode 仍能拦真正的同名重复。
  - `npm run test:ui`：fixture 给了 80 行结果却没传 `resultKey`，与产品契约「有结果必有 `resultKey`」（`src/client/workspace/source/source-workspace.tsx:178`）不一致，紧凑视图停在 `showing-editor`，结果面板 `display:none` 导致 cell 0×0。补 `resultKey` 后按产品状态机自动切到结果视图；折叠往返那组按钮只存在于分栏布局，故改到 768×600 视口执行。紧凑视图契约另有 `scripts/plugin-ui-acceptance.mjs`、`scripts/source-module-ui-acceptance.mjs` 固化，不应改产品。
- 已验证的 UI 子集（`test:plugin-ui`、`test:public-ui`、`test:grid-copy`、`test:theme-ui`、`test:ui`）进入 CI 的 `ui` job；其余 UI 脚本需要真实服务或未在本轮验证，暂不入 CI。
- 测试墙钟时序消除：`database-lifecycle`／`kafka-worker`／`nacos`／`sql-completion-source`／`bounded-parser` 从「断速度」改为「断完成顺序／钉死配置值」（如并发独立性改断「快请求在慢请求仍 pending 时完成」，截止值改用 mock timers 钉死）。20 核压满负载下以 `--test-concurrency=8` 复跑通过；并用探针证明旧的 `fast < 1500ms` 在主线程被饿死 2s 时每轮必假失败。
- npm 解析策略固化到仓库 `.npmrc`，见上文第 4 条。
- 另记一处非缺陷偏差：`src/client/query-detail-layout.ts:1` 的 `GRID_ROW_HEIGHT=28` 与实际行高（`--db-row-height: 34px`，实测 td 37px）不一致，detail 展开时保留行数的预留偏小；现有 `>= 80` 断言仍稳过，如需精确对齐由该文件持有者校准。

## 新增门面的规则

1. 先确认它不是上面这些“有意不合并”之一。
2. 门面必须说明构建路径或边界原因，并登记在本表。
3. `test/structure-gates.test.mjs` 的 `RETAINED` 列表同步更新。

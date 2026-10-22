# 统一打包与 standalone 维护

公共实现位于兄弟工程 `plugin-installer`，不要在插件中再复制发现插件、递增版本、选择 TGZ 或安装 profile 的逻辑。完整必要步骤表见该工程 `README.md`；源码以当前未提交代码为基线，未调整 Host/Worker 接口。

## 常用命令

从数据库工程运行：

```powershell
../plugin-installer/scripts/pack.ps1 database
../plugin-installer/scripts/pack.ps1 database -FullCheck
../plugin-installer/scripts/pack.ps1 database -Install
../plugin-installer/scripts/pack.ps1 database -NoExe
../plugin-installer/scripts/pack.ps1 database remote-exec
../plugin-installer/scripts/pack.ps1 -List -Json
```

默认只打包。`-Install` 才安装；单插件默认只输出 EXE，多插件额外输出 ZIP。`-ZipMode Auto|Always|Never` 控制 ZIP；`-NoExe` 仅 TGZ。版本每个任务递增一次，检查依赖与有效锁后才递增。直接 `npm pack`／`npm run pack:tgz` 自动准备一次，不递增版本。

`npm run install:desktop` 委托同一公共流程，明确执行打包与安装；`scripts/build-win-exe.ps1` 委托公共打包入口。数据库独立运行：

```powershell
$manifest = Get-Content ../plugin-installer/.pack/state/latest.json -Raw -Encoding UTF8 | ConvertFrom-Json
$database = $manifest.packages | Where-Object { $_.id -eq 'database' }
& $database.exe.path --standalone
```

本机须有 Node ≥24。访问地址由 Node 输出，不再固定探测端口。首次解压内置生产依赖，后续验证和复用同一版本缓存，不下载依赖或调用 npm/pnpm。

## 依赖与缓存

CodeMirror、高亮、图标等已进入浏览器 bundle 的依赖放在开发依赖；驱动、SQL 解析／格式化以及 Nacos 服务端实际使用的 `@lezer/xml` 等保留生产依赖。构建通过 esbuild 导入元数据验证 standalone 外部包均属于生产依赖，防止错误归类被开发环境掩盖。

`npm run pack:standalone-runtime -- --out <directory>` 根据 `package-lock.json` 在开发树外的临时目录生成运行包，再导入真实 `lib/serve.js` 验证闭包。仅删除 sourcemap 与声明，保留许可证、动态加载资源、驱动及必要文件。

缓存键覆盖锁内容（忽略自身版本）、平台、架构、Node 主版本、裁剪规则。运行包包含全文件 SHA-256 清单和验证器；EXE 就绪检查同时覆盖插件 payload 和模块包。缓存损坏时重新展开内置数据，不搬走其他版本依赖，不读本机 AppData 的开发缓存。

构建时默认优先本地缓存，缺包可按锁文件下载；`DSH_PACK_OFFLINE=1` 要求构建完全离线。`DSH_STANDALONE_CACHE` 用于指定测试缓存目录。

正常安装保留无关依赖、锁文件、已有 store、用户钩子和构建策略。旧内网环境确有 ssh2 可选原生依赖或 Oracle Thin 策略问题时，显式设置 `DSH_INSTALL_COMPAT_REPAIR=1` 才启用限定修复；用户自定义钩子不会被替换。

## 2026-10-12 交付与实测

任务 `1d592649-455e-4a48-b209-1e1a67ebc954`，状态 `packed`，未向真实 Desktop 安装。精确路径、SHA-256、阶段耗时见 `plugin-installer/.pack/state/latest.json` ；历史任务清单位于 `.pack/logs/<task>/manifest.json`。

| 插件 | 版本 | EXE | 直接 TGZ 命令（含准备） | 最终 EXE 生成及解包验收 |
| --- | --- | --- | --- | --- |
| api-workbench | 0.2.11 | 0.25 MB | 4.80s | 4.61s |
| code-search | 0.2.10 | 0.23 MB | 9.26s | 2.84s |
| database | 0.1.0-alpha.12.47 | 13.65 MB | 8.03s | 3.45s |
| office-tools | 0.3.13 | 49.73 MB | 30.76s | 33.70s |
| remote-exec | 0.2.9 | 0.87 MB | 6.92s | 3.02s |
| tool-search | 0.1.12 | 0.27 MB | 6.25s | 3.71s |
| visualization | 0.1.7 | 1.70 MB | 5.65s | 3.47s |

数据库基线为保留下来的 `alpha.12.46` EXE：30,576,573 字节（30.58 MB）；最终 `alpha.12.47` 为 13,652,444 字节（13.65 MB），减少 55.3%，达到 ≤15 MB 目标。MB 按 1,000,000 字节计算。没有通过删去五种数据源或独立运行功能达标。

本次锁定生产树裁剪前 172,599,666 字节，裁剪后 60,930,440 字节，运行 TGZ 11,435,452 字节。批量 ZIP 65,931,430 字节，只含本次七个 EXE 与 `install-all.cmd`。在最终权威锁安装后重新验证了七个直接命令；六个 TGZ 散列保持不变，图表来源记录变化后重新生成对应 EXE 与 ZIP。旧版打包及启动耗时未同条件记录，前后速度比较为 `NOT_RUN`。

最终 EXE 在开发目录外、无旧缓存、清空 NODE_PATH 的隔离环境实测：冷启动 32.02s，热启动 0.87s，删除 mysql2 清单后的修复启动 25.42s。时间包括解压、验证和服务启动，受本机磁盘与安全软件影响。

## 验收结果与边界

| 验收 | 结果 |
| --- | --- |
| 七插件公共 CLI、准备、TGZ、EXE 解包 | PASS |
| 七插件直接 TGZ 命令及版本不重复递增 | PASS |
| 最终包／锁版本、入口、散列、数据库内嵌运行包、ZIP 精确内容 | PASS |
| 公共打包回归：一次准备、FullCheck 调度、互斥、中文与空格路径、失败留旧、锁不一致、归档、ZIP、安装失败 | 8/8 PASS |
| GUI 使用后台清单、默认不安装、只展示清单产物、不能终止 CLI 任务 | 2/2 受控逻辑回归 PASS |
| 隔离 profile 首次安装与升级，保留无关依赖、store、用户钩子与构建策略 | 1/1 PASS |
| 数据库 npm run check（类型、离线单测、构建） | 914/914 PASS |
| 数据库包闭包、生产依赖树外导入真实 standalone 入口 | PASS |
| 最终 EXE 冷／热／修复启动、资源、五源入口、未授权 API 拒绝、不调用包管理器 | 受控离线 PASS |
| SQL 工作区、格式化与撤销、补全、Nacos 配置编辑／格式／Diff／发布交互 | 受控浏览器 PASS |
| HTA 真实交互、真实 Desktop 安装／升级／批量 EXE 安装 | NOT_RUN |
| 真实 MySQL／Oracle／Redis／Kafka／Nacos 操作 | NOT_RUN |
| 操作系统完全断网、真实库条件下的 standalone 编辑／执行／补全／Diff | NOT_RUN |
| 其余六插件 FullCheck 全离线回归 | NOT_RUN；默认必需准备和各自门禁已执行 |

受控离线测试阻止浏览器外部请求，将 npm registry 指向不可达本机地址并断言无包管理器调用；没有把整台机器断网。浏览器 UI 专项使用受控桥接／Worker，区别于最终 EXE 的实际资源与启动验收。完整离线开关已实现和回归调度验证，但未将所有项目的完整测试套件逐一执行。

日志与 JSON 结果在 `artifacts/pack-refactor/`；最终独立运行证据在 `artifacts/standalone-package-acceptance/8708dc54-4f36-449c-b8ec-a745a1d54010/`。此前放在开发树内的验收结果不用于证明运行依赖闭包；移到树外后发现并修复了 Nacos XML 依赖遗漏。

复核命令：

```powershell
node --test ../plugin-installer/scripts/pack.test.mjs
node --test ../plugin-installer/scripts/ui.test.mjs
node --test ../plugin-installer/scripts/install.test.mjs
npm run check
npm run test:sql-workspace
npm run test:completion-ui
npm run test:nacos-ui
node scripts/package-closure.mjs
node scripts/standalone-package-acceptance.mjs
```

## 目录与保留规则更新

打包器的 `out` 仅保留最新交付物，各插件上一成功版在 `.pack/previous`。数据库运行依赖不再按打包任务复制到 out；项目的 `artifacts/standalone-runtime` 按有效指纹保留最近两份，临时嵌入副本随任务清理。`scripts/organize.ps1 -DryRun` 可预览旧目录整理，实际整理保留未知文件到 `.pack/review`。此前版本与任务数据是历史验收证据，其旧输出路径不保证仍存在。

本次目录整理与回归结果见 [打包目录验收](packaging-directory-acceptance.md)。

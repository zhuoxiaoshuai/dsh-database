# 工作区主题

MySQL、Oracle、Kafka、Redis、Nacos、连接窗口、AI、经验库及公共弹层使用同一组 `--db-*` 语义变量。默认主题为雾灰青绿，默认模式跟随宿主。布局密度不随浅深色变化。

## 添加主题

主题的唯一配置源是 `src/client/workspace/parts/theme/theme-tokens.ts`。在 `workbenchThemes` 中增加一个有展示名称的主题，复制完整的 `shared`、`light`、`dark` 结构，再调整颜色、圆角、阴影和过渡参数。浅深两种配置必须覆盖相同的变量，包括按钮交互、禁用态、编辑器、补全、搜索和 Diff。

运行 `node scripts/gen-database-css.cjs` 会生成预览使用的 `theme.css` 和插件注入使用的 `style-css.ts`；`npm run build` 也会运行该步骤。不要直接编辑这两个生成文件。业务组件只使用变量，不按主题名称判断样式。

## 后续切换入口

客户端设置或主题菜单调用 `src/client/workspace/parts/theme/workbench-theme.ts` 的统一接口：

```ts
setWorkbenchTheme({ paletteId: 'mist-green', mode: 'host' })
setWorkbenchTheme({ paletteId: 'mist-green', mode: 'light' })
setWorkbenchTheme({ paletteId: 'mist-green', mode: 'dark' })
```

`getWorkbenchThemePreference()` 返回当前偏好。模式和主题保存于浏览器本地的版本化存储项 `dsh-database:theme:v1`，同一页面的所有工作区订阅同一个状态。存储不可用时使用内存状态。未知主题、无效模式、旧版本或损坏的保存值回退默认偏好。

跟随模式优先识别宿主的 `body[data-ds-dark-theme]`，再识别 HTML 明确的 `data-theme`、兼容类名和 `color-scheme`，最后回退系统偏好。明确浅色会覆盖系统深色。显式浅深选择覆盖宿主模式。

新工作区根节点和 React Portal 弹层使用 `useWorkbenchTheme()` 返回的 `attributes` 与 `style`。根节点暴露 `data-db-palette`、`data-db-scheme` 和 `data-db-theme-mode`。补全组件使用编辑器生命周期中的主题订阅，销毁时移除订阅与样式。

主题切换通过 CSS 变量更新外观，保留文档、撤销历史、光标、选区、滚动和表单，不发出业务请求。本次没有新增面向用户的独立切换入口。

## 验收

- `npm run check`：类型检查、单元回归、构建。
- `npm run test:theme-ui`：三个真实客户端组件的受控浏览器验收，覆盖宽度、主题切换、草稿、撤销、多实例、弹层和补全。
- 来源验收：`test:kafka-tree`、`test:kafka-readonly-ui`、`test:nacos-ui`、`test:workspace-ui`。
- 公共控件回归：`test:sql-workspace`、`test:grid-copy`、`test:completion-ui`。

主题截图与结果输出到 `artifacts/ui/theme-review`。受控夹具验证 UI 行为，不代表真实数据库或已安装 Desktop 的验收。

### 2026-10-11 验收结果

- `npm run check`：837 / 837 通过，类型检查与构建通过。
- 主题、Kafka 目录树与草稿、Nacos、Redis 工作区、SQL 工作区、补全、右键复制菜单及包入口验收通过。
- 三来源覆盖 420、768、1200px 浅深模式，列表抽屉另检查内容区 759 / 760px 断点和关闭后焦点返回。
- 实时切换保留 Redis 文本与选区、TTL 输入和 Nacos 编辑器实例、草稿、撤销历史；不增加业务请求。已打开菜单与补全同步配色。
- 临时完整配色验证按钮、边框、圆角、编辑器、Diff 与弹层的统一主题来源；该配色仅存在于验收夹具。
- 真实 Kafka / Redis / Nacos 服务、已安装 DSH Desktop：`NOT_RUN`。

同尺寸前后截图（浅色；同目录包含对应 `dark` 文件）：

| 来源 | 实施前 | 实施后 |
|---|---|---|
| Kafka，1280×800 | `artifacts/ui/theme-review/before/kafka-1280-light.png` | `artifacts/ui/kafka-catalog-tree/topic.png` |
| Redis，1280×800 | `artifacts/ui/theme-review/before/redis-1280-light.png` | `artifacts/ui/theme-review/redis-1280-light.png` |
| Nacos，1200×850 | `artifacts/ui/theme-review/before/nacos-1200-light.png` | `artifacts/ui/nacos/overview.png` |

基线使用实施前保存的编译包。Redis 对照在两个编译包挂载前提供相同的受控数据，业务组件和样式来自各自版本。主题切换截图等待颜色过渡结束，避免记录中间状态。

## 全插件布局统一（2026-10-11）

工作台只保留一条任务页签。来源绑定通过 `SourcePages.taskActions` 提供可用任务，`WorkspaceTabs` 负责“＋”、任务列表、名称省略、未保存描述和方向键 / Home / End 导航。继续使用现有页签 ID、恢复数据、关闭确认与草稿，不增加文档或执行状态系统。

布局密度集中在 `style.css` 的 `.db-workbench` 变量中：控件 32px、行内 28px、图标 30px、表格行 34px、页签 34px、正文 12px、辅助文字 11px、代码 13px / 1.7。颜色、圆角、边框宽度、阴影和动效仍只由 `theme-tokens.ts` 提供。新增配色不能改密度变量。

| 容器 | 布局规则 |
|---|---|
| 插件根工作台 | 980px 起显示连接树；更窄使用连接抽屉。树默认 220px，拖动范围 180–320px，同时限制右侧最小空间。 |
| Redis / Kafka 资源内容 | 760px 起列表与详情同排；更窄使用来源列表抽屉。 |
| SQL / 命令分区 | 默认上下各半，受原有最小高度约束，可拖动和折叠。宽度不足 480px 或分区高度不足 420px 时切换编辑 / 结果；新结果出现后展示结果。 |
| AI 内容 | 760px 以下历史进入抽屉；1120px 以下记录详情覆盖主内容，达到断点才显示第三列。 |
| 经验库与 SQL 对象详情 | 760px 以下使用抽屉；关闭后返回入口焦点。 |

`usePanelSize` 观察实际容器；`useDrawerFocus` 管理 Escape、Tab 焦点约束与焦点返回。宽度切换通过 CSS 和组件内布局状态完成。任务内容首次打开后按需保留挂载，SQL 沿用既有常驻任务方式。编辑器、字段表单、分区比例和草稿不因主题或布局切换而销毁。

连接表单分为数据源选择和填写两步；编辑连接直接填写。基本信息与认证采用紧凑分组，有高级选项的来源默认折叠，字段校验错误会展开对应分组。字段区独立滚动，测试 / 取消 / 连接操作固定保留在底部；密码说明使用帮助入口。最终删除、发布与未知写入核验继续使用原有确认机制。

新增验收入口：`npm run test:plugin-ui`。使用实际客户端组件及受控桥接，覆盖五来源、五种连接表单、任务菜单与键盘、连接树 979 / 980、分区 479 / 480 与高度 419 / 420、资源 / 经验 / 对象 759 / 760、AI 1119 / 1120。测试保持浏览器视口不变、改变插件根宽度，避免把窗口断点误当成容器断点。临时配色同时修改颜色、边框宽度、圆角和阴影，并读取已打开弹层与控件的实际计算样式。

本轮受控结果、日志与截图位于 `artifacts/ui/plugin-unification`。`before` 保存本轮修改前的编译夹具和截图；`after` 为本轮五来源、连接窗口和布局截图。SQL 运行与编辑状态对照单独保存在 `after/sql`；三来源同尺寸内容对照保存在 `after/sources`。所有受控证据都不代表真实数据库或已安装 Desktop 的验证。

### 本轮验证结果

`npm run check`：837 / 837，类型检查与构建通过。全插件布局、主题、SQL 工作区、Redis / Kafka / Nacos UI、补全、右键复制、未知写入冻结、执行边界、工作区竞态与包闭包验收通过。日志与测试详情见 `artifacts/ui/plugin-unification/result.json`；同尺寸前后对照见 `artifacts/ui/plugin-unification/comparison.md`。

真实 MySQL / Oracle / Redis / Kafka / Nacos 服务：`NOT_RUN`。已安装 Desktop：`NOT_RUN`；尝试启动隔离安装验收时，环境没有配置 `DSH_DESKTOP_APP`，且无法找到安装的 Node / Harness CLI。没有重启或修改用户 Desktop。

## 公共组件收拢（2026-10-12）

公共实现按 `parts/theme`、`overlay`、`layout`、`controls`、`feedback`、`hooks` 集中维护。旧位置为兼容导出，业务组件已切换到分组目录。弹框、取消确认、右键与更多、连接三个点、选择器、帮助和 Tooltip 使用公共交互与工作区边界。具体接入约定见 [前端公共 UI](frontend-ui-components.md)。

最终 `npm run check`：914 / 914，类型检查与构建通过；公共组件、全插件布局、主题、SQL、补全、右键复制、来源、执行边界、未知写入、维护、竞态及包闭包验收通过。日志和同尺寸对照见 `artifacts/ui/public-components/report.md` 与 `comparison.md`。真实五种服务及已安装 Desktop：`NOT_RUN`。

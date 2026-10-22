# 前端公共 UI

公共 UI 的实际实现集中在 `src/client/workspace/parts/`。业务模块负责数据、权限、执行身份与草稿；公共组件负责展示、交互、焦点和边界。旧路径仅保留导出兼容文件，新增业务代码直接引用以下目录。

| 目录 | 职责与主要入口 |
|---|---|
| `theme` | `theme-tokens.ts` 配色注册；`workbench-theme.ts` 偏好与切换；`use-workbench-theme.ts` 根节点与弹层主题订阅；宿主模式解析 |
| `overlay` | `DialogFrame`、`useWorkbenchConfirm`、`ActionMenu`、`MenuSurface`、帮助和 Tooltip；共享定位、独占菜单、焦点与抽屉键盘处理 |
| `layout` | `WorkspaceTabs`、`ResourceHeading`、`ResourceList`、`QueryResultFrame`、分页、表格及抽屉外壳 |
| `controls` | `Button`、`IconButton`、`FormField`、`SearchSelect`、选择列表键盘规则和编辑器基础扩展 |
| `feedback` | `ResourceError`、`EmptyState`、`CopyButton` 和剪贴板反馈 |
| `hooks` | 容器尺寸、拖动布局、编辑器挂载与尺寸生命周期 |

## 新页面接入

1. 标题使用 `ResourceHeading`，摘要与操作紧邻标题。内容留在可伸缩、内部滚动的区域；分页与状态属于对应结果。
2. 窗口使用 `DialogFrame` 的 `context`、正文与 `footer` 插槽。尺寸只选择 `confirm`、`form`、`wide`；不再各自实现遮罩、标题、关闭按钮、焦点陷阱或固定底部按钮。原生表单通过 `onSubmit` 接入，避免嵌套 form。
3. 按钮触发的“更多”使用 `ActionMenu`；右键或连接三个点使用 `MenuSurface`，传入同一组业务操作与 `MenuAnchor`。鼠标右键使用坐标，键盘菜单使用元素锚点。危险入口放末尾，最终确认保留明确目标。
4. 确认使用 `useWorkbenchConfirm()`，在所属工作区渲染 `confirmation` 并等待 `confirm()`。重复请求返回 false，卸载取消待决请求。等待结束后，业务调用必须重新核对连接、目标、草稿和执行身份，不能用过期闭包执行写入。
5. 图标按钮必须有可访问名称。说明使用 title / 帮助入口；工作区挂载 `WorkbenchTooltips` 后，悬停与聚焦说明统一呈现。禁用菜单保持键盘可访问，`aria-disabled` 阻止操作并允许查看原因。
6. 新颜色只加入完整主题配置。组件使用语义变量；尺寸密度留在共享 CSS。主题和容器切换不能重新创建编辑器或业务订阅。

## 保留的专用机制

结果复制菜单保留多级选择与 SQL / TSV 格式化，复用公共菜单所有权、关闭与工作区边界；编辑器补全保留 CodeMirror 生命周期，复用主题。游标分页、执行结果投影、资源加载和来源权限继续由业务模块维护。浏览器离开页面的 `beforeunload` 是浏览器原生机制，不能用异步组件确认替代。

## 验证

`npm run test:public-ui` 使用真实客户端组件检查保存经验、结构维护、资源筛选、连接表单、Redis / Nacos 新增窗口及公共菜单。覆盖浅深色、420 / 768 / 1200px、嵌套关闭、焦点返回、禁用说明、完整临时配色与重复确认。

结合 `test:plugin-ui`、`test:theme-ui`、`test:sql-workspace`、`test:grid-copy` 和来源验收检查具体页面。执行边界与工作区竞态仍需独立回归。受控桥接证据不能代替真实服务或已安装 Desktop，未执行项目标记 `NOT_RUN`。

本轮日志、结果与截图位于 `artifacts/ui/public-components/`。历史门禁结果带日期保留，当前门禁以本轮报告为准。

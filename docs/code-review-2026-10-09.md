# 代码评审与提交前验证（2026-10-09）

## 范围与结论

评审基线为 `b31a2cf`，评审对象是当前 `0.1.0-alpha.12.18` 工作区的全部待提交改动，包括 SQL／Redis／Kafka 执行边界、共编结果归属、网格维护、补全与复制、持久化及中英文说明。

检查重点是调用链的权限与目标绑定、取消／超时后的回执事实、未知写入禁止重放、过期结果不进入当前目标，以及新增模块的打包闭包。发现的问题已修复，下列最终检查通过；在本轮受控验证范围内，没有留下阻止提交的问题。

## 本轮发现与修复

| 问题 | 修复与回归证据 |
| --- | --- |
| AI 连接解析器无条件要求 generation，离线已保存 SQL 连接无法保存／搜索经验；等待落盘的测试因此挂起 | 仅在线操作必须提供有效 generation，离线经验操作仍要求明确连接并核对已传入的代次。新增真实工具入口回归：离线保存／搜索成功，SQL 执行被拒绝，Worker 调用为零；三个延迟保存测试增加超时保护 |
| 保存失败后尝试运行共编草稿，原始保存错误被“尚未保存”通用错误遮盖 | flush 在阻止执行时保留已有保存错误；现有浏览器回归确认原错误、未保存草稿、重连保留与显式重试 |
| 测试数据源返回无 kind 的裸载荷，不满足当前客户端来源执行回执校验 | 测试 Worker 返回带 kind=mock 的来源载荷，保留执行回执校验；真实 Service、HTTP、公共挂载、接管／归还和经验试运行全部通过 |
| 锁文件根版本及宿主 peer 兼容范围落后于 package.json | 同步根版本和 peer 范围，不改变锁定的依赖版本 |
| README 的二进制展示说明落后于代码，历史 Kafka 评审表有重复行 | 同步中英文为 UTF-8／十六进制及 BIT 展示与二进制列只读；删除重复行 |

## 最终验证

| 命令 | 结果与范围 |
| --- | --- |
| npm run check | PASS：Host／Client 类型检查、801/801 测试、Host ESM／Client factory／预览构建 |
| npm run test:package-closure | PASS：发布文件及相对导入闭包 |
| npm run test:sql-workspace | PASS：MySQL／Oracle 实际组件，受控桥接，文档／批量／经验／目标切换 |
| npm run test:workspace-races | PASS：接管、延迟回复、目标切换、重连与卸载竞态 |
| npm run test:execution-boundary | PASS：注册工具→Service→受控 Worker→事件→实际 Hook／渲染；网格值与过期预览 |
| npm run test:grid-copy | PASS：实际网格、选择与剪贴板，宽度／主题／弹窗布局 |
| npm run test:completion-ui | PASS：MySQL／Oracle／Redis 补全，键盘／鼠标／IME |
| npm run test:kafka-readonly-ui | PASS：7 组 Kafka 页面与补全／展示检查 |
| npm run test:source-module | PASS：测试来源只通过注册接入，真实 HTTP／Service／Worker 和公共挂载 |
| npm run test:storage-faults | PASS：专用子进程强制退出和临时存储故障，恢复状态、重试与不重放 |
| npm run test:grid-unknown | PASS：部分提交／未知项冻结、重新读取与禁止重放 |
| npm run test:fact-adoption | PASS：12 项文档／结果事实接纳与延迟能力回执检查 |
| 文档校验及 git diff --check | PASS：7 份入口文档的本地链接、锚点、npm 命令、代码围栏；无空白错误 |

本地日志保存在 `artifacts/review-2026-10-09/`，该目录被 git 忽略，不属于提交或发布包。首轮沙箱运行的临时文件／回环权限失败、两项修复前浏览器失败日志仍保留；最终结果以 check-after-review.log、相应 *-final.log 及其余成功日志为准。

## 验证边界

本轮未运行真实 MySQL／Oracle／Redis／Kafka 实连、Oracle 19c／SID、已安装 DSH Desktop／Web 或真实模型验收，这些项目保持 **NOT_RUN**。浏览器通过记录对应真实产品组件与受控桥接／Worker；持久化故障通过记录对应专用子进程和临时目录。历史实连记录不能替代当前源码验证。

# DSH 数据源平台架构

## 当前实现边界（2026-09-30）

- 公共客户端组件位于 `src/client/workspace/`。Redis、Kafka 以 standard 模式提供 `useBindings()`，由公共 `StandardSourceMount` 创建 `SourceWorkspace`；不再支持整页 `wrap`。
- 编辑器通过不透明 `editorContext` 获得专属补全缓存。`executionContext`、`executionContextKey`、`executionContextLabel` 分别承担 Host 目标数据、客户端比较和可见目标说明；公共工作台不解释 DB、Topic 等字段。
- 文档文本与规范化上下文共同参与 revision。一次原子更新最多增加一次修订；相同目标不增加；上下文单独变化保持控制权。切换目标取消旧作用域，保存失败保留草稿并提供重试。
- Host standard-text 必须提供 `normalizeContext`、`prepareText` 和 `authorize`。身份、环境和 generation 来自认证入口及实际连接；模块提供 Worker action/input 和结果投影，runtime 再核对允许的 action。
- Redis 配额等待结束后、Worker 派发前复核控制权、修订、文本和目标。普通人工命令台保留发起时目标；人工执行共编文档同样接受修订复核。
- MySQL／Oracle 继续使用 legacy-sql；Host SQL／Redis 保留 legacy-adapter。SQL 批量、维护、网格和事务流程未整体迁移，不能宣称全部执行外围统一完成。
- 测试源只在隔离验收包的静态注册位置加入；生产 ID、注册表和发布包不包含它。验收使用正式注册、认证入口、ConnectionService、Worker、公共页签和经验存储；专属 address 配置无须伪造 SQL 连接字段。
- `shared-query-confirm` 和旧 ApprovalLedger 保持删除，这是已确认的兼容性变化；现有 SQL 维护确认保留。

## 当前模式与接入入口

| 数据源 | 客户端 | Host 执行 | 专属能力 |
|---|---|---|---|
| MySQL | legacy-sql | legacy-adapter | SQL、目录、批量、InnoDB 维护、网格编辑 |
| Oracle | legacy-sql | legacy-adapter | Service/SID、SQL、目录、时间类型、维护与恢复 |
| Redis | standard | legacy-adapter | 命令隔离连接、SCAN、Key 编辑、DB 上下文与补全 |
| Kafka | standard | standard-text | Topic/分区/现有组浏览、有界 PEEK、消息结果 |

standard 复用总览／查询／AI／经验页签、执行窗口、共编修订、请求作用域及结果外框。SQL 页面和 SQL／Redis 的旧执行算法仍由兼容适配承载。新增源采用 standard＋standard-text；完整施工顺序和静态绑定位置见 [接入指南](data-source-onboarding.md)。

## 1. 系统定位

DSH Database 是：

“统一数据源工作平台 + 数据源差异化能力扩展体系”。

现有 MySQL、Oracle、Redis、Kafka 已经具备较完整的连接、操作、结果查看、AI 协作、执行记录和经验沉淀流程。

未来新增 Elasticsearch、MongoDB、PostgreSQL 或其他数据源时，不重新开发一整套系统。

核心目标：

新增数据源 ≠ 新开发一个独立工具。

新增数据源 = 接入现有公共底座 + 实现该数据源真正不同的能力。

系统随着数据源数量增加时，公共核心应该越来越稳定，而不是不断增加特殊判断。

---

## 2. 总体结构

逻辑结构：

DSH Data Source Platform
    │
    ├─ 公共产品能力
    │   ├─ Workspace
    │   ├─ AI / 人工协作
    │   ├─ History
    │   ├─ Knowledge
    │   ├─ 公共 UI
    │   └─ 公共交互
    │
    ├─ 公共运行能力
    │   ├─ Connection
    │   ├─ Execution
    │   ├─ State
    │   ├─ Event
    │   └─ Result 生命周期
    │
    └─ Data Source Boundary
        ├─ MySQL
        ├─ Oracle
        ├─ Redis
        ├─ Kafka
        ├─ Elasticsearch
        └─ Future Sources

每个数据源都是公共系统上的能力扩展，而不是独立系统。

---

## 3. 公共底座职责

所有数据源都会经历、且业务语义稳定一致的内容属于公共底座。

包括但不限于：

- 数据源管理整体流程
- 连接管理整体流程
- Workspace 与页签生命周期
- 编辑器公共生命周期
- 执行开始、运行、取消、结束
- 执行身份和状态
- 执行记录与 History
- AI Query 主流程
- AI / 人工共同编辑
- 人工接管和交还
- 修订与结果归属
- 公共 Result 外围
- Knowledge 公共流程
- 草稿与版本
- 公共 Loading / Error / Empty
- 公共布局
- 公共状态外围
- 公共交互行为

这些能力原则上只存在一套。

---

## 4. 数据源职责

数据源只负责真正依赖自身协议和业务模型的内容。

典型包括：

- 连接字段
- 连接协议
- Driver / Worker
- 连接测试方式
- 对象模型
- 对象获取方式
- 对象详情
- 操作文本或命令语义
- 解析
- 数据源专属授权规则
- 实际执行
- 分页 / Cursor / Offset 等专属机制
- 结果数据结构
- 结果专属展示
- 补全
- 专属 Toolbar 动作
- AI 参数到真实操作内容的转换
- 经验保存中的专属校验、指纹和分析
- 只有该数据源才存在的能力

原则：

公共底座负责“流程怎么走”。

数据源负责“具体怎么做”。

---

## 5. 统一什么

系统统一：

- 产品流程
- 生命周期
- AI 与人工协作方式
- 执行记录体系
- History 主流程
- Knowledge 主流程
- 公共页面框架
- 公共视觉语言
- 状态外围
- 错误外围
- 公共交互方式

---

## 6. 不强行统一什么

不同数据源可以拥有完全不同的：

- 连接参数
- 数据模型
- 对象模型
- 操作语言
- 结果数据结构
- 分页模式
- Cursor
- Offset
- Transaction
- 数据源专属行为

不要求：

- 所有连接都有 host/port/database/username
- 所有对象都是 Schema/Table
- 所有对象浏览都是树
- 所有结果都是二维表
- 所有操作都是 SQL
- Redis、Kafka 实现 SQL 语义
- Kafka Offset 与 Redis Cursor 使用同一种分页模型

核心原则：

“统一流程，不强行统一业务语义。”

---

## 7. AI 与人工边界

AI 和人工使用的是同一套工作体系。

逻辑关系：

当前操作内容
    ├─ 人工修改
    └─ AI 修改
         ↓
       执行
         ↓
       结果
         ↓
     执行记录
         ↓
    AI / 人工继续处理

要求：

- AI 可以看到人工修改后的当前内容
- 人工可以看到 AI 实际产生和执行的内容
- 人工可以接管
- 接管后 AI 不能覆盖人工当前内容
- 交还后 AI 可以继续操作
- AI 与人工最终进入同一 Execution
- 共用同一记录和结果体系
- 不为某个数据源重新建立独立 AI Workspace

---

## 8. Execution 边界

所有数据源都存在统一意义上的 Operation / Execution。

但 Operation 不等于 SQL。

例如：

MySQL / Oracle → SQL
Redis → Command
Kafka → Topic / Partition / Offset Operation
Elasticsearch → DSL
MongoDB → Query / Pipeline

公共执行层关心：

- 谁执行
- 在哪个连接执行
- 哪次执行
- 当前状态
- 取消
- 执行记录
- 事件
- 结果关联
- AI / 人工来源

数据源关心：

- 内容是什么
- 如何解释
- 是否允许
- 如何执行
- 返回什么
- 如何展示

公共执行层不应逐渐变成一个理解所有数据源内部业务语义的 God Service。

---

## 9. Result 边界

系统共用结果生命周期和公共结果区域。

但不存在万能结果数据模型。

SQL 可以是 columns / rows。

Redis 可以是 key / value / type。

Kafka 可以是 topic / partition / offset / message。

Elasticsearch 可以是 document / aggregation。

原则：

“统一结果流程，不统一结果内部结构。”

---

## 10. Knowledge 边界

Knowledge 主流程只有一套。

公共能力可以包含：

- 搜索
- 选择
- 草稿
- 保存
- 修改
- 版本
- 归档
- 试运行
- 再次用于当前操作

数据源可以提供：

- 保存校验
- 标准化
- 指纹
- 相似分析
- 专属分析

不得为每个数据源分别建立完整 Knowledge Library。

---

## 11. UI 边界

系统保持统一的产品外框。

公共：

- Workspace
- Tabs
- Toolbar 外围
- AI 区域
- History
- Knowledge
- Result Frame
- Drawer
- Dialog
- Loading
- Error
- Empty
- 公共状态展示

数据源可以提供：

- 专属连接字段
- 对象浏览
- 编辑器能力
- 补全
- 数据源专属 Toolbar 动作
- Result 内容组件
- Detail 组件

数据源不能重新接管整个公共 Workspace。

---

## 12. Client / Host 边界

整体关系：

公共 Workspace
    ↓
数据源 Client 能力
    ↓
公共 Bridge
    ↓
Host
    ↓
公共运行生命周期
    ↓
数据源 Host 能力
    ↓
Driver / Worker
    ↓
真实数据源

Client 主要负责：

- 编辑
- 交互
- 补全
- 展示
- 结果呈现

Host 负责：

- 真实身份
- 凭据
- 权限
- 安全校验
- 实际连接
- 实际执行
- Driver / Worker
- AI 工具真实调用
- 持久化

影响真实权限、安全和执行结果的判断不能只存在于客户端。

---

## 13. 扩展判断

新增功能时依次判断：

1. 是否所有数据源都会使用？
   是 → 公共能力。

2. 是否只属于某个数据源自身语义？
   是 → 数据源能力。

3. 是否因为公共底座缺少一个真正通用的扩展点？
   是 → 完善公共扩展点。

4. 是否只是为了当前数据源开发方便？
   是 → 不把它塞进公共业务层。

---

## 14. 架构退化信号

出现以下趋势时必须重新检查架构：

- 公共 Workspace 大量判断 sourceType
- AI 主流程大量判断具体数据源
- History / Knowledge 出现大量具体数据源分支
- 同一个状态在多个模块维护多份
- 每接一个数据源都复制一套 Workspace
- 每接一个数据源都增加独立 Store
- 每接一个数据源都增加独立 History
- 每接一个数据源都增加独立 AI 工作台
- 公共 Result 被迫加入越来越多业务字段
- 一个小的数据源需求需要修改大量公共业务代码

---

## 15. 当前数据源角色

MySQL / Oracle：

现有成熟 SQL 能力，是兼容基线。

Redis：

已经证明公共流程可以复用，但数据模型、命令和结果可以与 SQL 完全不同。

Kafka：

当前用于验证底座是否能够支持真正跨类型数据源，而不仅是传统数据库。

未来数据源继续遵守同一架构原则。

---

## 16. 最终健康标准

架构健康时应该满足：

- 删除某个数据源模块，公共平台仍然成立
- 新增一个数据源，不需要重新实现公共系统
- 修改公共流程，不需要在所有数据源复制修改
- 修改某个数据源，不影响其他数据源
- 理解公共流程，只需要阅读公共核心
- 理解某个数据源，只需额外阅读该数据源差异代码
- 数据源数量增加时，公共核心复杂度不会同比增长

一句话：

“公共能力只实现一次，真实差异各自实现；统一流程，隔离变化。”

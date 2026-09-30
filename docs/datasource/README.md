# 数据源专属文档规范

本目录只记录具体数据源自身特殊的能力和约束。

不要重复公共架构。

每种数据源可建立：

docs/datasource/<source>.md

例如：

mysql.md
oracle.md
redis.md
kafka.md
elasticsearch.md

每份文档建议只包含以下内容。

## 1. 定位

该数据源在当前产品中的用途和支持范围。

## 2. 连接

只描述该数据源特殊的：

- 配置
- 认证
- Driver
- Worker
- 安全约束

不要重复公共连接管理流程。

## 3. 对象模型

描述它独有的对象。

例如：

SQL：
Schema / Table / Column

Redis：
Key / Type / TTL

Kafka：
Topic / Partition / Offset

## 4. 操作模型

描述该数据源允许的实际操作语义。

不要重复公共 Execution 生命周期。

## 5. Result

描述该数据源结果结构和专属展示。

不要重新建设公共 Result Frame。

## 6. AI 特殊能力

只记录：

AI 参数如何转换为该数据源实际操作内容，以及该数据源专属权限。

不要重复 AI/人工协作体系。

## 7. Knowledge 特殊能力

只记录：

- 保存校验
- 指纹
- 标准化
- 特有分析

不要重复公共 Knowledge 流程。

## 8. 不支持能力

明确当前不支持什么，避免 AI 自行补齐超出范围的功能。

## 9. 安全边界

记录该数据源必须长期保持的安全规则。

## 10. 兼容基线

已有数据源记录不能随意改变的行为。

原则：

“数据源文档只解释差异，不复制公共系统说明。”

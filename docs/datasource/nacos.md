# Nacos 使用指南

## 支持范围

基线为 Nacos 2.4.3。配置与服务发现接入现有连接树、页签和操作记录，不提供 SQL/命令编辑器或经验库。仅使用固定 Open API，不实现完整控制台。

## 连接

选择 Nacos，填写 HTTP/HTTPS、主机、端口、context path（默认 `/nacos`）、默认 Namespace ID、用户名和密码。HTTPS 使用宿主系统信任的证书。不支持私有 CA、双向 TLS、集群自动发现。旧连接自动补 `http` 与 `/nacos`，旧 database 值作为默认 Namespace。

密码沿用现有安全存储；访问令牌只留在 Worker 内存。Namespace 是资源范围，切换无需重新登录。连接地址由已保存配置决定，工具不能传入任意 URL。重定向被拒绝。`2.4.3 API` 表示实现基线，不能作为检测到的远端版本。

## 配置与服务

展开连接后按需加载 Namespace。右侧支持 Namespace 筛选、Group/Data ID 配置搜索和 Group/服务名搜索。配置/服务/历史/实例默认每页 50 条，最大 100 条，没有自动全量遍历。Namespace 与监听者接口没有相同分页能力，响应受限，页面最多呈现 200 项；可筛选 Namespace。

配置编辑支持 YAML、JSON、Properties 和文本；不自动格式化。历史可查看详情并与当前内容 Diff；本轮没有回滚。监听者仅展示 GET 采样接口返回的信息和可获得的 MD5，空列表不能判定配置未生效。服务详情按集群读取实例，展示 IP、端口、健康、启用、权重和 metadata；这些是注册中心报告值，不能判定业务实际可用性。

打开页面绑定自己的连接、Namespace、Group、资源名和页面类型。切换列表范围不改变已有草稿目标。未保存内容在关闭、切换连接、删除连接及浏览器离开时提示。断线保留草稿。刷新遇到脏草稿时保留文本并展示差异，用户可明确丢弃后重读。

## 人工写入

人工在 SIT/UAT/PVT 均可新增、发布和删除，最终受远端账号权限限制。先预览目标与差异，再确认执行。预览签名有效期 5 分钟，绑定会话、连接 generation、操作者、资源范围、基线与变更摘要。令牌不包含正文或密码，没有提案存储。

预览校验目标和基线；远端 WRITE 权限在实际执行时由 Nacos 判定，预览成功不表示拥有写权限。更新通过 `casMd5` 防止覆盖新版本。新增先检查不存在，删除执行前核对 MD5；Nacos 未提供相同的原子条件删除/创建保证，仍存在跨客户端并发窗口。

发送后超时、断线或丢失回执记录为 `unknown`，不自动重试。必须重新读取核对；相同内容不能追认为原请求成功。已执行的预览在现有记录保留范围内禁止复用，读取后如需新的操作应重新预览。

## AI 工具与权限

读取工具：`nacos_status`、`nacos_namespaces`、`nacos_search_configs`、`nacos_get_config`、`nacos_config_history`、`nacos_config_listeners`、`nacos_search_services`、`nacos_service_detail`。服务详情同时返回一个集群的实例分页；默认首个集群，其他集群需明确查询。

写工具：`nacos_preview_config_change`、`nacos_publish_config`、`nacos_delete_config`。AI 写入仅 SIT；先展示预览结果，再提交相同变更及凭证，不增加 UI 审批。身份来自可信工具上下文；HTTP 固定为人工，不能冒充 AI。除连接发现外，明确提供连接和 generation；资源读取/变更还须提供 Namespace ID（public 为明确空字符串），配置须 Group 和 Data ID。

AI 更新只允许原文唯一匹配的非敏感局部替换，不允许重叠，不接收脱敏全文回写。Host 在原文上修改，保留敏感值、格式及注释，不能改变配置类型。AI 新增拒绝识别出的敏感凭据。JSON/YAML/Properties 按字段范围及密码、Token、私钥、连接凭据等模式脱敏；非法语法、重复字段、YAML 引用/标签、Properties 转义或续行等无法可靠定位的内容保守拒绝 AI 修改，只返回元信息。加密正文不返回模型，也不允许 AI 编辑；整份删除仍按已授权删除处理。

敏感检测并不覆盖任意未知业务秘密，请使用有意义的字段名与远端最小权限账号。配置正文、访问令牌、认证信息和原始远端错误体不进入操作记录或调试日志；记录只包含目标、动作、版本摘要、结果和安全错误。人工详情包含真实正文，请谨慎分享。

## 限制与 API

请求 JSON 上限 512 KiB（按实际 UTF-8 序列化大小检查），单个远端响应上限 2 MiB；超限明确失败，不使用截断正文发布。读请求遇到明确认证过期只刷新并重试一次，写请求不重放。多调用共享刷新，各调用可独立取消。

不实现跨环境对比、回滚、内容搜索、连接识别、实例变更、灰度、批量导入导出、自动巡检和排障编排。跨工具排障继续由现有 Agent 组合其他插件。

API 依据：[Open API](https://nacos.io/en/docs/v2/open-api/)、[2.4.3 配置控制器](https://github.com/alibaba/nacos/blob/2.4.3/config/src/main/java/com/alibaba/nacos/config/server/controller/ConfigController.java)、[v2 配置控制器](https://github.com/alibaba/nacos/blob/2.4.3/config/src/main/java/com/alibaba/nacos/config/server/controller/v2/ConfigControllerV2.java)、[Naming Catalog](https://github.com/alibaba/nacos/blob/2.4.3/naming/src/main/java/com/alibaba/nacos/naming/controllers/CatalogController.java)。不承诺其他版本兼容。

验证证据与未运行项见[实施记录](../nacos-p0-implementation.md)。

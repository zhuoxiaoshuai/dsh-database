# SQL Host 标准文本接入

本轮执行规格：保留 SQL Worker、逐语句授权、事务与维护算法；将文本入口接到实际模块和共同的排队派发。普通 query/manual-query/经验试运行零主记录；共编与解释各一条主记录。source-execute 的 SQL 行为等同 manual-query。

阶段：S0 基线 → S1 异步接口与隔离测试 → S2 普通请求 → S3 共编／解释 → S4 模块声明切换 → S5 同源码验收。

普通 query 使用原 ai 配额和 Worker 授权，manual-query 使用 manual 配额和 Worker 授权。共编保持创建记录后 Host 异步授权，解释保持 Worker 授权。多语句普通请求不增加整批预授权。

只使用已有 mysql8、oracle19、redis、kafka；不下载镜像、不重建环境。安装目录 D:\install\DeepSeek Harness，启用 DSH_TEST_EXISTING_ENV=1。

实际修改、偏差及报告见 ../data-source-foundation-progress.md。

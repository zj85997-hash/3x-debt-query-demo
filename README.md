# 3X 债权查询 Demo

3X 战队的债权信息查询原型。实现公告候选检索、自有台账查询、模拟解锁和人工回访预约。

[打开 GitHub Pages 预览](https://zj85997-hash.github.io/3x-debt-query-demo/)

Pages 预览在浏览器里查询虚构数据。完整应用由 H5、微信小程序客户端、Node.js API、MySQL 和负载均衡组成。

## 运行

使用 Node.js 22 或以上版本，并将 MySQL 服务端命令 `mysqld` 加入 PATH。

```sh
npm ci
npm run local
```

打开 <http://127.0.0.1:8930/>。启动器使用项目独立的数据目录和 Unix Socket，启动两个 API 实例及本地网关。首次启动自动导入样例。Ctrl+C 关闭本次进程。

```sh
npm run verify
node scripts/verify-candidates.mjs
node scripts/verify-mini.mjs
npm run load
```

压测命令在本机运行。默认500个活跃会话持续60秒，随后同时发起500次查询。数据、运行环境和性能报告以各次实测为准。

## 样例数据

`fixtures/债权转让通知-虚构样本.pdf` 是5条虚构记录的 PDF。用 `node scripts/build-candidate-fixture.mjs` 可重新提取文本并生成结构化数据，需要 Poppler。

`docs/data/synthetic-bulk.json` 是10,000条程序生成的测试记录。姓名形如 `样例*00001`，证件字段保留14个星号和4个虚构尾号。每500行重复同一组合以验证冲突。运行 `node scripts/generate-synthetic-bulk.mjs` 可重新生成。两组样例可导入本地 MySQL。

| 用例 | 姓名 | 尾号 | 预期 |
|---|---|---|---|
| 单条命中 | 样例甲 | 0067 | 1条候选，显示来源编号与页码 |
| 批量数据单条 | 样例*00001 | 0001 | 1条候选 |
| 批量数据冲突 | 样例*00000 | 0042 | 20条候选 |
| 未命中 | 样例甲 | 9999 | 暂无匹配 |

公开仓库及 Pages 只使用虚构资料。协作提交同样使用虚构数据，真实资料、业务凭据和个人信息应留在获准的受控环境。

## 客户端与部署

在微信开发者工具导入 `mini/` 并选择测试号或项目 AppID。开发者工具模拟器连接 `mini/config.js` 指定的本机 API。真机联调需要经配置的 HTTPS 域名和对应账号。

`compose.yaml` 提供 MySQL 8.4、双 API 与 Nginx 编排。启动前在本机 `.env` 配置三个独立随机值，分别是 `DEMO_DB_ROOT_PASSWORD`、`DEMO_DB_PASSWORD` 和长度至少32字符的 `DEMO_SIGNING_KEY`。

```sh
docker compose up -d --build
docker compose exec api-a node scripts/seed.mjs 450000
```

GitHub Pages 从 `main` 分支的 `docs/` 发布静态预览。API、数据库、真实身份核验和支付联调需要独立部署环境。

## 团队协作

```sh
git clone https://github.com/zj85997-hash/3x-debt-query-demo.git
cd 3x-debt-query-demo
git switch -c feature/your-change
```

用分支提交改动，再向 `main` 发起 Pull Request。拥有写权限的协作者可在仓库内推送分支，其他队友可通过 Fork 提交改动。PR 请注明改动场景和验证方法。

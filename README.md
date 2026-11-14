# 个人债权信息查询平台（Demo · V2 架构）

用户完成本人核验后，查询与自己相关的债权信息：已授权的债权台账、已核实的债权转让记录、公告线索；可付费解锁转让详情、预约人工回访。配套 H5、微信小程序和运营大盘。

**全部数据为程序生成的虚构数据**（证件号以 99 开头，不可能与真实身份证号重合）。演示环境在接口层就会拒绝真实证件号。

完整的设计、实测数据与运维说明见 [开发文档](design/开发文档.md)。

## 一分钟跑起来

需要 Node.js 22 以上，以及已安装在 PATH 里的 `mysqld`（MySQL 8+）和 `redis-server`（Redis 6+）。

```sh
npm ci
npm run dev
```

启动器会拉起项目私有的 MySQL 和 Redis（独立数据目录，只走本机套接字，不占用也不影响系统里已有的 3306 / 6379），建表并导入约 45 万笔虚构台账，再启动 4 个 API 进程和 1 个后台进程。终端会打印两个地址：

- 用户端 H5：<http://127.0.0.1:8800/>，页面下方有 9 张"演示身份"卡片，点选即可走完每一种结果
- 运营大盘：`http://127.0.0.1:8800/ops#token=…`（令牌在终端输出里）

`Ctrl+C` 全部优雅退出。小程序在微信开发者工具中导入 `mini/` 目录。

## 常用命令

| 命令 | 作用 |
|---|---|
| `npm test` | 单元测试（不需要启动环境） |
| `npm run test:api` | 接口验收测试，含小程序页面逻辑联调（需先 `npm run dev`） |
| `npm run bench` | 验收压测：500 人稳态、洪峰、高压、2 倍与 4 倍过载、恢复，逐阶段与数据库对账 |
| `npm run drill` | 故障演练：滚动重启、杀进程、Redis 假死、MySQL 停顿、核验与支付供应商故障 |
| `npm run bench:capacity` | 容量摸高：查询链路的吞吐上限 |
| `npm run bench:abuse` | 滥用与枚举测试 |
| `npm run dev:exec -- scripts/import.mjs --kind assets --file <csv> --source "来源"` | 导入一批数据（样例见 `fixtures/samples/`） |
| `npm run dev:exec -- scripts/reset-activity.mjs` | 清空业务流水，保留台账（压测前使用） |

macOS 上跑较长的压测时，请用 `caffeinate -is npm run bench` 防止系统中途休眠（压测引擎会检测休眠并把受影响的阶段标为无效）。

## 目录

```
src/
  config.mjs        全部配置的唯一入口（环境变量 → 默认值 → 校验）
  supervisor.mjs    单节点进程管理器：N 个 API 进程 + 1 个后台进程，自动拉起、滚动重启
  api/              接入与协议层：路由、准入、鉴权、参数校验、错误映射
  modules/          业务模块：会话、核验、查询、解锁订单、预约、审计、统计、大盘
  providers/        外部依赖适配：实名核验、支付（舱壁 + 断路器）
  infra/            基础设施：MySQL、Redis、限流、舱壁、断路器、编号、密码学、指标、日志
  domain/           领域规则：证件号校验、虚构人口生成
  worker/           后台进程：审计批量落库、统计同步、超时订单关闭
web/                H5 与运营大盘（原生 ES 模块，无构建步骤）
mini/               微信小程序
mocks/              第三方模拟器（实名核验 + 支付），可注入故障
migrations/         数据库表结构
scripts/            本机环境、迁移、数据生成、导入等工具
test/               单元测试与接口验收测试
bench/              压测引擎、场景、计划与实测报告（bench/reports/*.json）
deploy/             配置项清单、告警规则
design/             开发文档（图在 design/img/）
docs/               旧版（V1）的 GitHub Pages 静态预览，仅含虚构数据，未随 V2 更新，V2 运行不依赖它
```

## 提交约定

从 `main` 拉分支开发，提交 Pull Request。合入前必须：`npm test` 与 `npm run test:api` 全绿；涉及性能或稳定性的改动附上 `npm run bench` / `npm run drill` 的结果。仓库只接受虚构数据，真实资料、业务凭据和个人信息不得提交。

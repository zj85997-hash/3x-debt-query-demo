# 导入样例（全部为虚构数据）

三份 CSV 分别对应三类数据的导入模板，列名即导入脚本要求的列名。

| 文件 | 内容 | 导入命令 |
|---|---|---|
| assets.csv | 自有授权资产台账 | `node scripts/import.mjs --kind assets --file fixtures/samples/assets.csv --source "样例台账"` |
| transfers.csv | 已核实的历史转让记录 | `node scripts/import.mjs --kind transfers --file fixtures/samples/transfers.csv --source "样例转让记录"` |
| candidates.csv | 脱敏公告候选（姓名 + 证件末四位） | `node scripts/import.mjs --kind candidates --file fixtures/samples/candidates.csv --source "样例公告候选"` |

金额单位为元（最多两位小数），日期为 YYYY-MM-DD。证件号只在导入瞬间参与计算，入库的只有盲索引与掩码。

样例里的人对应虚构人口编号 900000–900006，导入后可在 H5 里用下面的身份核验查询：

- 吴子建 990000197206190008
- 邱子英 990000197206190016
- 蒋建伟 990000197206190024
- 毛斌秀 990000197206190032
- 侯勇 990000197206190040
- 杨伟秀 990000197206190059
- 江浩鹏 990000197206190067

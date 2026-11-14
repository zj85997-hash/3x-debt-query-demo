-- 个人债权信息查询平台 · 初始表结构（V2）
-- 约定：金额一律以"分"为单位存 BIGINT；时间为北京时间；证件号只存盲索引与掩码，不存明文。

CREATE TABLE import_batches (
  id            INT UNSIGNED NOT NULL AUTO_INCREMENT COMMENT '导入批次号（数据版本）',
  kind          VARCHAR(24)  NOT NULL COMMENT 'assets / transfers / candidates',
  source        VARCHAR(120) NOT NULL COMMENT '数据来源说明',
  row_count     INT UNSIGNED NOT NULL DEFAULT 0,
  status        TINYINT      NOT NULL DEFAULT 1 COMMENT '1 已发布 0 已撤销',
  published_at  DATETIME(3)  NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
  PRIMARY KEY (id)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COMMENT='数据导入批次';

CREATE TABLE assets (
  id             BIGINT UNSIGNED NOT NULL COMMENT '内部编号',
  debt_no        VARCHAR(32)  NOT NULL COMMENT '债务编号（业务唯一）',
  package_no     VARCHAR(32)  NOT NULL COMMENT '资产包编号',
  id_hash        BINARY(32)   NOT NULL COMMENT '证件号盲索引 HMAC-SHA256',
  name_masked    VARCHAR(40)  NOT NULL COMMENT '姓名掩码',
  id_masked      CHAR(18)     NOT NULL COMMENT '证件号掩码',
  holder         VARCHAR(80)  NOT NULL COMMENT '债权主体',
  originator     VARCHAR(80)  NOT NULL COMMENT '原贷款方',
  loan_date      DATE         NOT NULL,
  principal_fen  BIGINT UNSIGNED NOT NULL COMMENT '贷款本金（分）',
  balance_fen    BIGINT UNSIGNED NOT NULL COMMENT '欠款本息（分）',
  as_of          DATE         NOT NULL COMMENT '数据时点',
  mandate_status TINYINT      NOT NULL COMMENT '委托状态：1 有效 0 已到期或退出',
  batch_id       INT UNSIGNED NOT NULL,
  created_at     DATETIME(3)  NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
  updated_at     DATETIME(3)  NOT NULL DEFAULT CURRENT_TIMESTAMP(3) ON UPDATE CURRENT_TIMESTAMP(3),
  PRIMARY KEY (id),
  UNIQUE KEY uk_debt_no (debt_no),
  KEY idx_owner (id_hash, mandate_status)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COMMENT='自有授权资产台账';

CREATE TABLE transfer_records (
  id            BIGINT UNSIGNED NOT NULL,
  id_hash       BINARY(32)   NOT NULL,
  name_masked   VARCHAR(40)  NOT NULL,
  id_masked     CHAR(18)     NOT NULL,
  transferor    VARCHAR(80)  NOT NULL COMMENT '债权出让方（贷款方）',
  transferee    VARCHAR(80)  NOT NULL COMMENT '债权受让方（新债权人）',
  transfer_date DATE         NOT NULL,
  amount_fen    BIGINT UNSIGNED NOT NULL COMMENT '转让金额（分）',
  notice_ref    VARCHAR(48)  NOT NULL COMMENT '公告编号',
  contact       VARCHAR(80)  NOT NULL COMMENT '受让方联系方式（付费后展示）',
  status        TINYINT      NOT NULL DEFAULT 1 COMMENT '1 已发布 0 已撤销/更正下架',
  batch_id      INT UNSIGNED NOT NULL,
  created_at    DATETIME(3)  NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
  PRIMARY KEY (id),
  KEY idx_owner (id_hash, status)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COMMENT='已核实的历史转让记录';

CREATE TABLE notice_candidates (
  id          BIGINT UNSIGNED NOT NULL,
  pair_hash   BINARY(32)  NOT NULL COMMENT '姓名+证件末四位 的组合盲索引',
  source_ref  VARCHAR(48) NOT NULL COMMENT '公告来源编号',
  source_page SMALLINT UNSIGNED NOT NULL COMMENT '原文页码',
  notice_date DATE        NOT NULL,
  status      TINYINT     NOT NULL DEFAULT 1,
  batch_id    INT UNSIGNED NOT NULL,
  PRIMARY KEY (id),
  KEY idx_pair (pair_hash, status)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COMMENT='脱敏公告候选（仅作线索，不能确认身份）';

CREATE TABLE consents (
  id             BIGINT UNSIGNED NOT NULL,
  sub            CHAR(16)    CHARACTER SET ascii COLLATE ascii_bin NOT NULL COMMENT '用户假名编号',
  kind           VARCHAR(16) NOT NULL COMMENT 'query 查询授权 / contact 回访联系',
  policy_version VARCHAR(40) NOT NULL COMMENT '当时同意的文本版本',
  channel        VARCHAR(32) NOT NULL DEFAULT '',
  ref_id         BIGINT UNSIGNED NULL COMMENT '关联对象（如预约单号）',
  dedup_key      VARCHAR(64) CHARACTER SET ascii COLLATE ascii_bin NULL COMMENT '去重键：同一会话对同一人的同一次授权只记一条（超时重试不重复）',
  created_at     DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
  withdrawn_at   DATETIME(3) NULL,
  PRIMARY KEY (id),
  UNIQUE KEY uk_dedup (dedup_key),
  KEY idx_sub (sub, kind, created_at),
  KEY idx_ref (ref_id)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COMMENT='授权与同意记录（只增不改，撤回记时间）';

CREATE TABLE query_logs (
  id             BIGINT UNSIGNED NOT NULL COMMENT '查询编号（趋势递增）',
  sub            CHAR(16)    CHARACTER SET ascii COLLATE ascii_bin NOT NULL,
  outcome        VARCHAR(16) NOT NULL COMMENT 'own / history / candidate / empty',
  record_count   SMALLINT UNSIGNED NOT NULL DEFAULT 0,
  policy_version VARCHAR(40) NOT NULL,
  channel        VARCHAR(32) NOT NULL DEFAULT '',
  from_cache     TINYINT     NOT NULL DEFAULT 0,
  trace_id       VARCHAR(40) NOT NULL DEFAULT '',
  created_at     DATETIME(3) NOT NULL,
  PRIMARY KEY (id),
  KEY idx_sub (sub, id)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COMMENT='查询审计（异步批量写入；按主键范围归档）';

CREATE TABLE unlock_orders (
  order_no     BIGINT UNSIGNED NOT NULL COMMENT '订单号',
  sub          CHAR(16)    CHARACTER SET ascii COLLATE ascii_bin NOT NULL,
  record_id    BIGINT UNSIGNED NOT NULL COMMENT '要解锁的转让记录',
  query_id     BIGINT UNSIGNED NOT NULL,
  amount_fen   INT UNSIGNED NOT NULL,
  channel      VARCHAR(32) NOT NULL DEFAULT '' COMMENT '来源渠道（用于按渠道统计转化）',
  status       TINYINT     NOT NULL DEFAULT 0 COMMENT '0 待支付 1 已支付 2 已关闭 3 已退款',
  idem_key     VARCHAR(64) CHARACTER SET ascii NOT NULL COMMENT '客户端幂等键',
  provider     VARCHAR(16) NOT NULL DEFAULT 'mock',
  provider_txn VARCHAR(64) NULL COMMENT '支付渠道流水号',
  created_at   DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
  paid_at      DATETIME(3) NULL,
  expire_at    DATETIME(3) NOT NULL,
  PRIMARY KEY (order_no),
  UNIQUE KEY uk_idem (sub, idem_key),
  UNIQUE KEY uk_txn (provider, provider_txn),
  KEY idx_sub_record (sub, record_id, status),
  KEY idx_expire (status, expire_at)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COMMENT='付费解锁订单';

CREATE TABLE unlock_grants (
  sub        CHAR(16) CHARACTER SET ascii COLLATE ascii_bin NOT NULL,
  record_id  BIGINT UNSIGNED NOT NULL,
  order_no   BIGINT UNSIGNED NOT NULL,
  created_at DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
  PRIMARY KEY (sub, record_id)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COMMENT='解锁授权（与订单置为已支付在同一事务内写入）';

CREATE TABLE callback_tickets (
  id          BIGINT UNSIGNED NOT NULL,
  sub         CHAR(16)    CHARACTER SET ascii COLLATE ascii_bin NOT NULL,
  query_id    BIGINT UNSIGNED NOT NULL,
  time_window VARCHAR(24) NOT NULL,
  status      VARCHAR(12) NOT NULL DEFAULT 'pending' COMMENT 'pending / replied / withdrawn',
  created_at  DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
  updated_at  DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3) ON UPDATE CURRENT_TIMESTAMP(3),
  PRIMARY KEY (id),
  UNIQUE KEY uk_query (query_id),
  KEY idx_sub (sub, id)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COMMENT='人工回访预约';

CREATE TABLE stat_daily (
  stat_date DATE        NOT NULL,
  channel   VARCHAR(32) NOT NULL,
  metric    VARCHAR(32) NOT NULL,
  value     BIGINT      NOT NULL DEFAULT 0,
  PRIMARY KEY (stat_date, channel, metric)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COMMENT='按日、按渠道的运营统计';

CREATE TABLE app_meta (
  k VARCHAR(40)  NOT NULL,
  v VARCHAR(255) NOT NULL,
  PRIMARY KEY (k)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COMMENT='系统元数据（如盲索引密钥指纹）';

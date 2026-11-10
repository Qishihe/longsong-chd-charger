-- 违规车牌登记（v3.20）表结构。
-- Worker 在首次请求时用 db.batch() 惰性执行同样的 DDL，控制台不必手工跑这份文件；
-- 这里留作留档、手动重建与 D1 控制台核对用。
-- 契约见 docs/API.md。

CREATE TABLE IF NOT EXISTS plates(
  plate_hash TEXT PRIMARY KEY,          -- HMAC(normalize(plate), PLATE_HMAC_KEY)
  plate_enc  TEXT,                      -- AES-GCM 密文，随机 IV；不能当主键
  first_at   INTEGER,
  last_at    INTEGER,
  total_all  INTEGER DEFAULT 0
);

CREATE TABLE IF NOT EXISTS reports(
  id         INTEGER PRIMARY KEY AUTOINCREMENT,
  plate_hash TEXT,
  src_hash   TEXT,                      -- 设备票据的 HMAC，不是账号
  day        TEXT,                      -- YYYYMMDD（UTC+8）
  campus     TEXT,                      -- weishui | beiyuan | yanta | xiaozhai
  reason     TEXT,                      -- pull | park | other
  at         INTEGER,                   -- 毫秒时间戳
  UNIQUE(plate_hash, src_hash, day)    -- 同设备同日同车牌幂等，不重复扣额度
);
CREATE INDEX IF NOT EXISTS idx_reports_plate_at  ON reports(plate_hash, at);
CREATE INDEX IF NOT EXISTS idx_reports_plate_day ON reports(plate_hash, day);
CREATE INDEX IF NOT EXISTS idx_reports_at        ON reports(at);

-- 月榜不能在 18 万行明细上做全表 GROUP BY（D1 Free 10ms CPU 会超时），
-- 所以登记时就把月份、校区两个维度预汇总好。
CREATE TABLE IF NOT EXISTS plate_month(
  plate_hash TEXT,
  ym         TEXT,                      -- YYYY-MM（UTC+8）
  cnt        INTEGER DEFAULT 0,
  pull       INTEGER DEFAULT 0,
  park       INTEGER DEFAULT 0,
  other      INTEGER DEFAULT 0,
  last_at    INTEGER,
  PRIMARY KEY(plate_hash, ym)
);
CREATE INDEX IF NOT EXISTS idx_pm_ym_cnt ON plate_month(ym, cnt DESC);

CREATE TABLE IF NOT EXISTS plate_month_campus(
  plate_hash TEXT,
  ym         TEXT,
  campus     TEXT,
  cnt        INTEGER DEFAULT 0,
  PRIMARY KEY(plate_hash, ym, campus)
);
CREATE INDEX IF NOT EXISTS idx_pmc ON plate_month_campus(ym, campus, cnt DESC);

-- 原子扣次：UPDATE ... WHERE used < limit，用 meta.changes === 1 判定抢到额度。
-- scope: global | report | query；day 日切归零，不累计。
CREATE TABLE IF NOT EXISTS plate_quota(
  scope TEXT,
  key   TEXT,
  day   TEXT,
  used  INTEGER DEFAULT 0,
  PRIMARY KEY(scope, key, day)
);

-- 总量闸门计数器：绝不在每次登记时全表 COUNT(*)，那会扫穿 D1 免费版行读额度。
-- key='rows' 是 reports 当前行数；登记 +1、撤销 -N、清理 -N。
-- Worker 首次建表时用 INSERT OR IGNORE ... SELECT COUNT(*) FROM reports 补种，
-- 老库升级也能从真实行数起跳；触顶时会再用真实 COUNT 自校正一次。
CREATE TABLE IF NOT EXISTS plate_meta(
  key TEXT PRIMARY KEY,
  val INTEGER NOT NULL DEFAULT 0
);

CREATE TABLE IF NOT EXISTS plate_audit(
  id         INTEGER PRIMARY KEY AUTOINCREMENT,
  at         INTEGER,
  action     TEXT,                      -- report | rank | revoke
  plate_hash TEXT,
  who        TEXT
);

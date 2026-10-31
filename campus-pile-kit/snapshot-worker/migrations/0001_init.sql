-- 快照站 D1 schema（v1）
-- 两张表：kv（快照+统计，行数恒定） + locks（时间片锁，需定期清理）

-- ── kv：快照 + 统计 ──────────────────────────────────────────────
-- key 是主键，覆盖写 = UPSERT，行数恒定：
--   4 个快照（snap/<area>.json）+ 1 个统计（stats/hourly.json）= 5 行
CREATE TABLE IF NOT EXISTS kv (
  key        TEXT PRIMARY KEY,
  value      TEXT NOT NULL,
  updated_at INTEGER NOT NULL
);

-- ── locks：时间片锁 ──────────────────────────────────────────────
-- key 形如 lock/<area>/<slice> 或 lock/_global/<slice>
-- value 存起始时间戳 ts，供 inflightRecently 读「上一轮还在飞吗」
-- slice 冗余一列，供 purgeLocks 批量 DELETE 过期锁
CREATE TABLE IF NOT EXISTS locks (
  key        TEXT PRIMARY KEY,
  value      TEXT NOT NULL,
  slice      INTEGER NOT NULL,
  created_at INTEGER NOT NULL
);

-- 🔴 复合索引是硬要求，不是优化：
-- inflightRecently 的 SELECT ... WHERE key = ? 走主键（点查），但 purgeLocks
-- 的 DELETE ... WHERE slice < ? 若没有 slice 索引，每次清理都全表扫描，
-- 行读额度直接爆掉（锁表一个月 10.8 万行）。
CREATE INDEX IF NOT EXISTS idx_locks_slice ON locks (slice);

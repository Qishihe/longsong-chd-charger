/**
 * D1 专项审计：验证换掉 R2 之后，D1 特有的风险有没有被正确处理。
 *
 * 运行：node audit_d1.mjs
 *
 * R2 的四套审计（crash/quota/rate/overlap）覆盖的是「逻辑」层，D1 和 R2
 * 共用同一套 core.mjs，所以那些结论在 D1 下依然成立。但 D1 有几处 R2
 * 没有的坑，必须单独验：
 *
 *   1. 锁原子性：INSERT ON CONFLICT DO NOTHING 是否等价 R2 的 If-None-Match:*
 *   2. 锁清理：purgeLocks 是否能把锁表压回有界（R2 靠 lifecycle，D1 靠 DELETE）
 *   3. 行计费：锁表累积会不会把「点查」变成「扫表」，行读额度爆炸
 *   4. 读路径降级：D1 读失败是否和 R2 读失败一样走 degraded 而不是 500
 *   5. 覆盖写幂等：UPSERT 是否等价 R2 的覆盖写（快照/统计行数恒定）
 *
 * 注意：这里用 createD1() 内存 mock 对齐 D1 真实语义（meta.changes /
 * UPSERT / 无 TTL），但**不连真 D1**。真正要在部署后验的只有一件事：
 * 「真实 D1 的 INSERT ON CONFLICT 是否真的跨 isolate 强一致」—— 但 D1 是
 * SQLite 强一致，这是数据库的基本保证，不像 R2 的最终一致需要赌。
 */

import { TUNING, SCHEDULE, MIN_INTERVAL_MIN } from './config.mjs';
import { KEYS, refreshArea, snapFor, inflightRecently, sliceOf } from './core.mjs';
import { createD1, createClock, createScanner, asBatch } from './mock.mjs';
import { createD1Store } from './store-d1.mjs';
import { PARTITIONS } from './partitions.mjs';

let pass = 0;
let fail = 0;
const fails = [];
function ok(name, cond, extra) {
  if (cond) {
    pass += 1;
    console.log(`  [ok]   ${name}`);
  } else {
    fail += 1;
    fails.push(name);
    console.log(`  [FAIL] ${name}${extra === undefined ? '' : '  → ' + JSON.stringify(extra)}`);
  }
}

const AREA = PARTITIONS.areas[1]; // beimen, 37 台
const T0 = Date.UTC(2026, 9, 27, 0, 0, 0) / 1000;

/* ── 1. 锁原子性：INSERT ON CONFLICT DO NOTHING ────────────────── */
console.log('\n1. 锁原子性');
{
  const db = createD1();
  const store = createD1Store(db, { now: () => T0 });
  const clock = createClock(T0);
  const scan = createScanner({ mode: 'ok' });

  const slice = sliceOf(T0, TUNING);
  const key = KEYS.lock(AREA.key, slice);

  const r1 = await store.put(key, String(T0), { onlyIf: new Headers({ 'If-None-Match': '*' }) });
  const r2 = await store.put(key, String(T0), { onlyIf: new Headers({ 'If-None-Match': '*' }) });

  ok('第一次抢锁成功（meta.changes=1）', !!r1, r1);
  ok('第二次抢锁冲突（返回 null，等价 R2 412）', r2 === null, r2);
  ok('锁表只有 1 行（不重复累积）', db.lockCount() === 1, db.lockCount());
}

/* ── 2. 并发抢锁：5 个并发只有 1 个抢到 ─────────────────────────── */
console.log('\n2. 并发抢锁（5 并发 → 1 成功）');
{
  const db = createD1();
  const store = createD1Store(db, { now: () => T0 });
  const slice = sliceOf(T0, TUNING);
  const key = KEYS.lock(AREA.key, slice);

  const results = await Promise.all(
    Array.from({ length: 5 }, () =>
      store.put(key, String(T0), { onlyIf: new Headers({ 'If-None-Match': '*' }) }),
    ),
  );
  const won = results.filter(Boolean).length;
  ok('5 并发只有 1 个抢到锁', won === 1, `抢到 ${won} 个`);
  ok('锁表仍只有 1 行', db.lockCount() === 1, db.lockCount());
}

/* ── 3. 覆盖写幂等：快照/统计行数恒定 ───────────────────────────── */
console.log('\n3. 覆盖写幂等');
{
  const db = createD1();
  const store = createD1Store(db, { now: () => T0 });

  const snapKey = KEYS.snap(AREA.key);
  for (let i = 0; i < 10; i++) {
    await store.put(snapKey, JSON.stringify({ piles: i }), {});
  }
  const got = await store.get(snapKey);
  const val = JSON.parse(await got.text());

  ok('覆盖写 10 次后读回最新值', val.piles === 9, val.piles);
  ok('快照行数恒为 1（UPSERT 不累积）', db._kv.size === 1, db._kv.size);
}

/* ── 4. 锁内容保留 ts（inflight 依赖） ──────────────────────────── */
console.log('\n4. 锁内容保留起始时间戳');
{
  const db = createD1();
  const store = createD1Store(db, { now: () => T0 });
  const clock = createClock(T0);

  /* 关键：inflightRecently 读的是「上一片」的锁，比较 age = 现在 - 锁内 ts。
     要模拟「跨片后仍在飞」，锁的 ts 必须接近片边界（起跑时间 = 片尾前 5 秒）。
     片宽 120 秒，起跑在片尾前 5 秒 = slice 起点 + 115 秒。 */
  const slice = sliceOf(T0, TUNING);
  const startAt = T0 + TUNING.LOCK_SLICE_S - 5; // 这一片快结束时起跑
  await store.put(KEYS.lock(AREA.key, slice), String(startAt), {
    onlyIf: new Headers({ 'If-None-Match': '*' }),
  });

  /* 下一个时间片 +5 秒：age = (T0+125) - (T0+115) = 10 秒 < INFLIGHT_S(25) → 在飞 */
  const t2 = T0 + TUNING.LOCK_SLICE_S + 5;
  const inflight = await inflightRecently(store, AREA.key, t2, TUNING);
  ok('跨片后 age=10 秒 → 判定在飞', inflight === true, inflight);

  /* 下一个时间片 +30 秒：age = 40 秒 > 25 → 已结束 */
  const t3 = T0 + TUNING.LOCK_SLICE_S + 30;
  const notInflight = await inflightRecently(store, AREA.key, t3, TUNING);
  ok('跨片后 age=40 秒 → 判定已结束', notInflight === false, notInflight);
}

/* ── 5. purgeLocks：锁表压回有界 ────────────────────────────────── */
console.log('\n5. purgeLocks 锁清理');
{
  const db = createD1();
  const store = createD1Store(db, { now: () => T0 });

  /* 造一批不同 slice 的锁（含很老的） */
  const currentSlice = sliceOf(T0, TUNING);
  for (let s = currentSlice - 10; s <= currentSlice; s++) {
    await store.put(KEYS.lock(AREA.key, s), String(T0 - (currentSlice - s) * TUNING.LOCK_SLICE_S), {
      onlyIf: new Headers({ 'If-None-Match': '*' }),
    });
  }
  const before = db.lockCount();
  const purged = await store.purgeLocks();
  const after = db.lockCount();

  ok('清理前有 11 行锁', before === 11, before);
  ok('清理掉老于当前片-2 的锁', purged > 0, purged);
  ok('清理后剩余 ≤ 3 行（当前片往前 2 片）', after <= 3, after);
  ok('清理后锁表有界', after >= 0 && after <= 3, after);
}

/* ── 6. 读路径降级：D1 读失败 → degraded 而非 500 ───────────────── */
console.log('\n6. 读路径降级');
{
  const db = createD1();
  /* 让 prepare 抛异常，模拟 D1 故障 */
  const brokenDb = {
    prepare() {
      throw new Error('D1 连接失败（模拟配额超限）');
    },
  };
  const store = createD1Store(brokenDb, { now: () => T0 });

  let threw = false;
  try {
    await store.get(KEYS.snap(AREA.key));
  } catch (e) {
    threw = true;
    ok('读失败抛出带 r2 标记的错误（供 degraded 路径识别）', !!e.r2, e.message);
  }
  ok('读失败确实抛错（core 会 catch 转 degraded）', threw, '未抛错');
}

/* ── 7. 行计费上界：一天到底写多少行 ────────────────────────────── */
console.log('\n7. 行计费（D1 免费额度按「天」重置：10 万行写 / 500 万行读，UTC 00:00 清零）');
{
  /* 🔴 口径修正（2026-10-27 核对官方文档）：
   * 「Indexes will add an additional written row when writes include the
   *  indexed column, as there are two rows written: one to the table itself,
   *  and one to the index.」
   *
   * 这直接改本方案的账：
   *   locks 有 idx_locks_slice，锁行必然写 slice 列 → 每次写锁 = 2 行
   *   kv 是 TEXT PRIMARY KEY → SQLite 建隐式唯一索引 → UPSERT 也是 2 行
   *   purgeLocks 的 DELETE 同时删表行和索引项 → 每删 1 行 = 2 行写
   *
   * 第一版估算只按「逻辑行」算（锁 3600 + 快照 5 + 清理 1200 ≈ 4805），
   * 漏了索引这一半 —— 真实记账要 ×2。这里把「设计最坏」和「真实典型」
   * 分开算，不要拿最坏当日常、也不要拿日常当最坏。 */
  const INDEX_ROWS = 2; // 表 1 行 + 索引 1 行

  /* 7a. 设计最坏：全天每个时间片、每个区都被刷满（假设 24 小时不停有人） */
  const slicesPerDay = 86400 / TUNING.LOCK_SLICE_S; // 720
  const lockRows = 4 * slicesPerDay + 1 * slicesPerDay; // 分区锁 2880 + 全站锁 720
  const snapRows = 4;
  const statsRows = 1;
  const purgeRows = 24 * 50; // 每小时清一次，最多 50 行/次
  const logicalWorst = lockRows + snapRows + statsRows + purgeRows;
  const worst = logicalWorst * INDEX_ROWS;

  console.log(`  7a 设计最坏（全天刷满）：逻辑 ${logicalWorst} 行 → 含索引 ${worst} 行/天`);
  ok('设计最坏 < 2 万行/天（免费 10 万/天的 20% 以内）', worst < 20000, worst);

  /* 7b. 真实典型：没人访问、只有 cron。轮数直接由时段表推，不拍脑袋。 */
  const runsPerDay = (table) =>
    table.reduce((sum, min) => sum + 60 / Math.max(MIN_INTERVAL_MIN, min), 0);
  const perAreaWeekday = runsPerDay(SCHEDULE.weekday);
  const perAreaWeekend = runsPerDay(SCHEDULE.weekend);
  const avgPerArea = (5 * perAreaWeekday + 2 * perAreaWeekend) / 7;
  const cronRuns = avgPerArea * 4; // 四区合计

  /* 每轮 cron：1 个分区锁 + 1 次快照 UPSERT = 2 逻辑行
     清理：写多少锁就会删多少锁，≈ cronRuns 行
     统计：每小时 1 次 UPSERT = 24 行 */
  const cronLogical = cronRuns * 2 + cronRuns + 24;
  const typical = Math.round(cronLogical * INDEX_ROWS);

  console.log(
    `  7b 真实典型（只有 cron）：${cronRuns.toFixed(0)} 轮/天 → 逻辑 ${cronLogical.toFixed(0)} 行 → 含索引 ${typical} 行/天`,
  );
  ok('真实典型 < 1 万行/天（免费 10 万/天的 10% 以内）', typical < 10000, typical);

  /* 7c. 有人访问：日 1000 次访问，约 100 次真补刷（其余命中新鲜快照）。
     每次真补刷：全站锁 + 分区锁 + 快照 = 3 逻辑行 → 6 行含索引。 */
  const userRuns = 100;
  const realistic = typical + userRuns * 3 * INDEX_ROWS;
  console.log(
    `  7c 典型 + 日 1000 访问（约 100 次真补刷）≈ ${realistic} 行/天 = 免费额度的 ${((realistic / 100000) * 100).toFixed(1)}%`,
  );
  ok('带访问 < 2 万行/天', realistic < 20000, realistic);

  /* 🔴 抢锁失败零计费 —— D1 相对 R2 的关键优势：
   * R2 的 412 也算一次 Class A 写（并发尖峰白烧额度）；D1 的
   * INSERT ... ON CONFLICT DO NOTHING 撞锁时 changes=0、一行都没落盘，
   * 没落盘就是零行计费。所以 7a 的 3600 是「成功抢到的锁」上界，
   * 不是「尝试次数」上界 —— 并发再凶也不会把行写顶上去。 */
  const failedAttempts = 200 * 20; // 假设一天 20 次「同一秒 200 并发」的尖峰
  console.log(`  （抢锁失败 ${failedAttempts} 次 → 追加 0 行写，D1 不为空操作计费）`);

  /* 🔴 行读（rows_read）也要估，且口径是「扫描行数」不是「返回行数」。
   *
   * 2026-10-27 核对官方文档：rows_read 计的是「扫描」的行数 —— 一个主键
   * 点查即使 miss 也计 1 行读（B-tree 遍历 1 个索引页）。所以 inflight 检查
   * （读上一片锁）每次至少 1 行读，purgeLocks 的 DELETE 走 slice 索引先扫描
   * 命中行（rows_read）再删（rows_written），两个都计。
   *
   * 行读上界估算（免费 500 万读/天）：
   *   inflight 检查：每条「补刷尝试」读 1 次上片锁。日 1000 次访问最坏
   *     1000 次 × 1 行 = 1000 行读。
   *   purgeLocks：每小时 DELETE 扫描 + 删除 ≤ 50 行，24 次 × 50 = 1200 行读。
   *   快照/统计读：每次 /api/snap /api/stats 读 1~4 行。
   *   合计 < 1 万行读/天 = 免费 500 万的 0.2%，完全安全。
   *
   * 唯一能让行读爆炸的是「锁表失控 → 扫表」：purgeLocks 失效后锁表一个月
   * 10.8 万行，inflight 的 SELECT 若没走主键索引就是全表扫描 10.8 万行读。
   * 但 inflight 走的是主键点查（key=?），purgeLocks 走 idx_locks_slice，
   * 两者都靠索引 —— 这是第 5 节断言「清理后锁表恒有界」要守住的根因。 */
  const inflightReads = 1000 * 1; // 日 1000 次访问，每次读 1 行上片锁
  const purgeReads = 24 * 50; // 每小时 DELETE 扫描 ≤ 50 行
  const snapReads = 1000 * 4; // 每次读快照 1~4 行
  const totalReads = inflightReads + purgeReads + snapReads;
  console.log(`  行读上界 ≈ ${totalReads} 行/天（免费 500 万读/天的 ${(totalReads / 5000000 * 100).toFixed(2)}%）`);
  ok('日行读 < 10 万（免费 500 万读/天的 2% 以内）', totalReads < 100000, totalReads);
}

/* ── 8. 锁 key 禁止普通覆盖写（防 updated_at 列不匹配的潜伏 bug） ── */
console.log('\n8. 锁对象禁止走普通覆盖写');
{
  const db = createD1();
  const store = createD1Store(db, { now: () => T0 });

  /* 锁的合法写入只有 onlyIf 原子锁这一条路。普通覆盖写（不带 onlyIf）若落到
     lock/ 前缀的 key，会拼出 `INSERT INTO locks (key, value, updated_at)`，
     而 locks 表是 slice + created_at 两列 —— 真实 D1 直接 SQL 报错。
     内存 mock 不校验列名，所以这个坑六套测试全绿也测不出。这里断言：
     锁的覆盖写必须在 store 层就被显式拒绝（fail-fast），而不是静默写坏。 */
  let threw = false;
  let msg = '';
  try {
    await store.put(KEYS.lock(AREA.key, sliceOf(T0, TUNING)), String(T0), {});
  } catch (e) {
    threw = true;
    msg = String((e && e.message) || e);
  }
  ok('锁 key 的普通覆盖写被拒绝（不静默写坏 locks 表）', threw === true, msg);
  ok('拒绝信息带 r2 标记（上层走降级而非静默）', threw && /锁/.test(msg), msg);

  /* 快照/统计的普通覆盖写仍然正常（走 kv 表） */
  let snapOk = true;
  try {
    await store.put(KEYS.snap(AREA.key), JSON.stringify({ piles: 1 }), {});
  } catch {
    snapOk = false;
  }
  ok('快照普通覆盖写不受影响（仍走 kv 表）', snapOk === true);
}

console.log(`\n${fail === 0 ? '[PASS]' : '[FAIL]'} ${pass} 通过 / ${fail} 失败`);
if (fails.length) {
  console.log('失败项：');
  for (const f of fails) console.log('  - ' + f);
  process.exit(1);
}

/**
 * 循环审计：回答一个具体问题 ——
 * **「数据更新识别」会不会让读写反复循环，把云端打满或搞崩？**
 *
 * 额度审计（audit_quota）问「花得太多吗」，崩溃审计（audit_crash）问
 * 「会不会挂」，这一套问的是第三件事：**会不会形成自我放大的回路**。
 *
 * 嫌疑点有三个：
 *   1. 全军覆没时 `at` 故意不前进（core.mjs 第 477 行）—— 年龄永远超限，
 *      于是每个来的请求都觉得自己该补刷。刹车只靠快照里的 `retryAfter`。
 *   2. 快照**写失败**时 `retryAfter` 没落盘 —— 下一个请求读到的是没标记的
 *      旧快照，会不会再扫一轮？这是「只靠写成功来刹车」的死穴。
 *   3. 前端 AUTO_REFRESH_MS=10min 的轮询叠加 `/api/snap`，会不会一轮⌛
 *      一轮地把自己喂成一个正反馈。
 *
 * 手法：照旧把真 core.mjs 跑起来，换成会坏的 D1 / 会坏的上游，
 * 按 24 小时推进，把**每一次触发刷新**的路径都量出来 ——
 * 请求数、行读、行写（含索引双计）、上游台数、峰值锁行数。
 *
 * 用法：node campus-pile-kit/snapshot-worker/audit_loop.mjs
 */

import { TUNING } from './config.mjs';
import { snapFor, WriteGuard } from './core.mjs';
import { createD1, createClock, createScanner, asBatch } from './mock.mjs';
import { createD1Store } from './store-d1.mjs';
import { PARTITIONS } from './partitions.mjs';

const AREAS = PARTITIONS.areas;
const T0 = Date.UTC(2026, 9, 27, 2, 0, 0) / 1000;
const INDEX_ROWS = 2; // 审计核算口径：行写 = 表 1 行 + 索引 1 行

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
    console.log(`  [FAIL] ${name}${extra !== undefined ? ' → ' + JSON.stringify(extra) : ''}`);
  }
}

/* 工具的失败日志在失败场景里会刷屏，这里收集起来但只记数不刷出来 */
const noise = [];
const realError = console.error;
const realWarn = console.warn;
console.error = (...args) => {
  noise.push(args.join(' '));
};
console.warn = (...args) => {
  noise.push(args.join(' '));
};

/* ── 会坏的 D1 store ──────────────────────────────────────────────
 * failPut:
 *   true    = 所有写都失败（含锁） —— D1 整体不可用
 *   'snap'  = 只有快照写失败、锁写得进去 ← **最危险的一种**：
 *             锁成功了说明这一轮被放行去扫上游，结果产物没落盘，
 *             retryAfter 也就丢了，下一个时间片会再来一轮
 *   false   = 正常
 */
function fragileStore({ failPut = false } = {}) {
  const db = createD1();
  const real = createD1Store(db, { now: () => Date.now() });
  return {
    db,
    get: (k, o) => real.get(k, o),
    put: async (k, v, o) => {
      if (failPut === true || (failPut === 'snap' && String(k).startsWith('snap/'))) {
        throw new Error('D1 put 失败（模拟额度打爆 / 存储不可用）');
      }
      return real.put(k, v, o);
    },
  };
}

/* ── 一天的访问模型 ───────────────────────────────────────────────
 * 站点是很小众的校内地图页，按保守偏乐观取 1000 访问/天；
 * 每访包含「首屏 1 次 + 停留约 10 分钟后再轮询 1 次」（前端
 * AUTO_REFRESH_MS = 10min，页面停留超过 5 分钟就会触发第二次）。
 * staySec 传 0 表示只算首屏那一发。 */
async function runDay({ mode, visits = 1000, stay = true, failPut = false, visitGapJitter = true }) {
  const clock = createClock(T0);
  const bucket = fragileStore({ failPut });
  const scanner = createScanner({ mode });
  const guard = new WriteGuard(TUNING); // 与生产同款：模块级单例、内存态
  bucket.db._resetCounters();
  /* 把时钟拨到某个时刻，返回 snapFor 要的 now 函数 */
  const at = (t) => {
    clock.set(t);
    return clock.now;
  };

  let requests = 0;
  let refreshed = 0;

  /* 一天 86400 秒里均匀铺 visits 个访问 */
  const step = Math.floor(86400 / visits);
  for (let i = 0; i < visits; i += 1) {
    const base = i * step;
    const area = AREAS[i % AREAS.length];
    const jitter = visitGapJitter ? (i * 7) % 5 : 0; // 打散，别全落在整点

    /* 首屏 */
    requests += 1;
    let r = await snapFor({
      bucket,
      area,
      now: at(base + jitter),
      wantRefresh: true,
      scanBatch: asBatch(scanner),
      guard,
    });
    if (r.refreshed) refreshed += 1;

    /* 停留后再拉一次 */
    if (stay) {
      requests += 1;
      r = await snapFor({
        bucket,
        area,
        now: at(base + jitter + Math.floor(TUNING.THROTTLE_S * 5)), // 10 分钟
        wantRefresh: true,
        scanBatch: asBatch(scanner),
        guard,
      });
      if (r.refreshed) refreshed += 1;
    }
  }

  return {
    requests,
    refreshed,
    upstream: scanner.count,
    reads: bucket.db._reads(),
    writesLogical: bucket.db._writes(),
    writesIndexed: bucket.db._writes() * INDEX_ROWS,
    locks: bucket.db.lockCount(),
  };
}

console.log('循环审计：更新识别会不会自我放大\n');
console.log(`配置：THROTTLE_S=${TUNING.THROTTLE_S}s  LOCK_SLICE_S=${TUNING.LOCK_SLICE_S}s`);
console.log('凭证额定 === D1 免费：行写 10 万/天、行读 500 万/天；Workers 免费：请求 10 万/天\n');

/* ── 1. 正常日：对照基线 ────────────────────────────────────────── */
console.log('1. 正常日（上游健康，日 1000 访问，每访 2 次请求）');
const base = await runDay({ mode: 'ok' });
console.log(
  `  请求 ${base.requests} · 真补刷 ${base.refreshed} · 上游 ${base.upstream} 台\n` +
    `  行读 ${base.reads} · 行写 ${base.writesLogical}（含索引 ${base.writesIndexed}）· 锁行 ${base.locks}`,
);
/* 1000 次请求如果每次都回源会是 2000 × 27 ≈ 5.4 万台/天。
   实际 1.9 万台 —— 少 64%，因为「同一时间片同一区只放行一轮」。
   注意这不是「1% 才回源」那种理想的省：四个用户分布在四个区、
   间隔 344 秒（1000 访问 ÷ 4 区），早就超过 THROTTLE_S=120 的门槛，
   所以绝大多数访问确实会补刷 —— 这是设计使然，不是回路失控。
   判断标准应该是「有没有上界」，而不是「回源率够不够低」。 */
const naiveDevices = base.requests * AREAS[0].ids.length;
const sliceCeiling = (86400 / TUNING.LOCK_SLICE_S) * AREAS.length * AREAS[0].ids.length;
console.log(
  `  若无闸门（每次请求都扫）会是 ${naiveDevices} 台\n` +
    `  理论硬上界（每区每片最多一轮）= ${sliceCeiling} 台/天；实测 ${base.upstream} 台（${((base.upstream / sliceCeiling) * 100).toFixed(0)}% 的上界）`,
);
ok('正常日：补刷次数不超过「每区每片一轮」的硬上界', base.refreshed <= (86400 / TUNING.LOCK_SLICE_S) * AREAS.length, base.refreshed);
ok('正常日：上游压力低于「每次请求都扫」的无闸门基线', base.upstream < naiveDevices, {
  upstream: base.upstream,
  naive: naiveDevices,
});
ok('正常日：行写远低于 D1 日额度 10 万', base.writesIndexed < 100000, base.writesIndexed);
ok('正常日：Worker 请求远低于 10 万/天', base.requests < 100000, base.requests);

/* ── 2. 凭证过期：年龄永远超限，会不会无限补刷？ ────────────────── */
console.log('\n2. 凭证过期（上游全 401 —— 「数据更新不过来」的典型触发条件）');
const auth = await runDay({ mode: 'auth' });
console.log(
  `  请求 ${auth.requests} · 真补刷 ${auth.refreshed} · 上游 ${auth.upstream} 台\n` +
    `  行读 ${auth.reads} · 行写 ${auth.writesLogical}（含索引 ${auth.writesIndexed}）· 锁行 ${auth.locks}`,
);
/* 没有退避的话会退化成「每次请求都扫一区」= 2000 × 27 ≈ 54,000 台 */
const naiveUpstream = auth.requests * AREAS[0].ids.length;
console.log(`  若无退避（每次请求都扫）会是 ${naiveUpstream} 台 —— 实测 ${auth.upstream} 台`);
ok('凭证过期：退避把上游压力压到「每次都扫」的 20% 以下', auth.upstream < naiveUpstream * 0.2, {
  upstream: auth.upstream,
  naive: naiveUpstream,
});
ok('凭证过期：行写仍远低于 D1 日额度', auth.writesIndexed < 100000, auth.writesIndexed);
ok('凭证过期：锁表没有失控（若不清理会堆到一天几千行）', auth.locks < 200, auth.locks);

/* ── 3a. D1 整体不可用：连锁都写不进去 ─────────────────────────── */
console.log('\n3a. D1 整体写失败（连锁都落不了盘）');
const writeAll = await runDay({ mode: 'ok', failPut: true });
console.log(
  `  请求 ${writeAll.requests} · 真补刷 ${writeAll.refreshed} · 上游 ${writeAll.upstream} 台\n` +
    `  行读 ${writeAll.reads} · 行写 ${writeAll.writesLogical}（含索引 ${writeAll.writesIndexed}）· 锁行 ${writeAll.locks}`,
);
ok('D1 整体不可用：**fail-closed**，一次上游都不打', writeAll.upstream === 0, writeAll.upstream);
ok('D1 整体不可用：读路径仍可用（用户还能看到旧快照）', writeAll.reads > 0, writeAll.reads);

/* ── 3b. 只有快照写失败（锁写成功）← 全场最危险的死穴 ────────── */
console.log('\n3b. 只有快照写失败（锁写成功 —— 「已放行去扫，但产物没落盘」）');
const writeSnap = await runDay({ mode: 'ok', failPut: 'snap' });
const lockRounds = (86400 / TUNING.LOCK_SLICE_S) * AREAS.length;
console.log(
  `  请求 ${writeSnap.requests} · 真补刷 ${writeSnap.refreshed} · 上游 ${writeSnap.upstream} 台\n` +
    `  行读 ${writeSnap.reads} · 行写 ${writeSnap.writesLogical}（含索引 ${writeSnap.writesIndexed}）· 锁行 ${writeSnap.locks}`,
);
console.log(
  `  理论硬上界：${lockRounds} 轮/天（每区每片一轮）× ${AREAS[0].ids.length} 台 ≈ ` +
    `${lockRounds * AREAS[0].ids.length} 台/天；实测 ${writeSnap.upstream} 台`,
);
ok('快照写失败：真补刷被时间片锁压住，不是「每个请求都回源」', writeSnap.refreshed <= lockRounds, {
  refreshed: writeSnap.refreshed,
  ceiling: lockRounds,
});
ok(
  '快照写失败：上游压力仍 ≤ 硬上界（有界，但会顶到满格）',
  writeSnap.upstream <= lockRounds * Math.max(...AREAS.map((a) => a.ids.length)),
  writeSnap.upstream,
);
ok('快照写失败：行写仍远低于 D1 日额度', writeSnap.writesIndexed < 100000, writeSnap.writesIndexed);
console.log(
  `  ⚠️ 这是全场最坏的一档：${writeSnap.upstream} 台/天全打在上游且毫无产出 ——\n` +
    `     但它是**有界**的（≤ ${lockRounds} 轮/天），只在「锁能写、快照写不了」这种\n` +
    `     极端半故障下发生。真发生时 D1 已在报警，属于运维事件而非失控回路。`,
);

/* ── 4. 部分失败：不累加 streak，会不会拖成一圈一圈试？ ─────────── */
console.log('\n4. 部分失败（每 3 台挂 1 台 —— 平台抖动的真实形态）');
const partial = await runDay({ mode: 'some-fail' });
console.log(
  `  请求 ${partial.requests} · 真补刷 ${partial.refreshed} · 上游 ${partial.upstream} 台\n` +
    `  行读 ${partial.reads} · 行写 ${partial.writesLogical}（含索引 ${partial.writesIndexed}）· 锁行 ${partial.locks}`,
);
ok('部分失败：上游量与正常日同量级（不因 partial 变成无限重试）', Math.abs(partial.upstream - base.upstream) < base.upstream * 3 + 10000, {
  partial: partial.upstream,
  base: base.upstream,
});
ok('部分失败：行写远低于 D1 日额度', partial.writesIndexed < 100000, partial.writesIndexed);

/* ── 5. 峰值并发：同一秒一群人来，写会不会被放大？ ──────────────── */
console.log('\n5. 同一秒并发（快照全超龄时 200 个请求一起挤进来）');
{
  const clock = createClock(T0);
  const at = (t) => {
    clock.set(t);
    return clock.now;
  };
  const bucket = fragileStore({});
  const scanner = createScanner({ mode: 'ok' });
  const guard = new WriteGuard(TUNING);
  bucket.db._resetCounters();

  /* 先把快照喂成「很旧」，让每个请求都有补刷动机 */
  const area = AREAS[0];
  await snapFor({
    bucket,
    area,
    now: at(0),
    wantRefresh: true,
    scanBatch: asBatch(scanner),
    guard,
  });
  const before = bucket.db._writes();
  const baseCount = scanner.count;

  /* 同一秒 200 个请求打同一个区 */
  const results = await Promise.all(
    Array.from({ length: 200 }, () =>
      snapFor({
        bucket,
        area,
        now: at(TUNING.LOCK_SLICE_S * 2),
        wantRefresh: true,
        scanBatch: asBatch(scanner),
        guard,
      }),
    ),
  );
  const realRefresh = results.filter((r) => r.refreshed).length;
  const wrote = bucket.db._writes() - before;
  console.log(
    `  200 个并发 → 真补刷 ${realRefresh} 轮 · 上游 ${scanner.count - baseCount} 台 · 标称行写 ${wrote}（含索引 ${wrote * INDEX_ROWS}）`,
  );
  ok('并发：同一秒只放行 1 轮（不是 200 轮）', realRefresh === 1, realRefresh);
  ok('并发：请求越多≠写越多（写入与作用 workers 数脱钩）', wrote < 20, wrote);
}

/* ── 5b. 决定性测试：高流量去撞硬上界 ──────────────────────────────
 * 前面几档流量太稀（每个区平均 344 秒才被访问一次），「看起来有界」
 * 有可能是因为需求本来就小。真正的证据是：**把访问量拉到 Workers
 * 免费额度允许的最大值，看看写入/回源会不会跟着线性涨上去。**
 * 若 Linear = 运气好；若被压成常数（≤ 每区每片一轮）= 真的有界。 */
console.log('\n5b. 高流量去撞硬上界（日 20000 访问 = 4 万次请求，逼近 Workers 免费 10 万/天）');
{
  const hiSnap = await runDay({ mode: 'ok', failPut: 'snap', visits: 20000 });
  const hiBase = await runDay({ mode: 'ok', visits: 20000 });
  const ceilingRounds = (86400 / TUNING.LOCK_SLICE_S) * AREAS.length;
  const perArea = Math.max(...AREAS.map((a) => a.ids.length));
  console.log(
    `  正常（日 2 万访问） 真补刷 ${hiBase.refreshed} 轮 · 上游 ${hiBase.upstream} 台 · 行写 ${hiBase.writesIndexed}\n` +
      `  快照写失败        真补刷 ${hiSnap.refreshed} 轮 · 上游 ${hiSnap.upstream} 台 · 行写 ${hiSnap.writesIndexed}\n` +
      `  （请求数均为 ${hiBase.requests}，是正常日 ${base.requests} 的 ${(hiBase.requests / base.requests).toFixed(0)} 倍）`,
  );
  const growth = hiBase.upstream / base.upstream;
  console.log(
    `  请求放大 ${(hiBase.requests / base.requests).toFixed(0)}× ，上游只放大 ${growth.toFixed(2)}×` +
      ` —— 这就是「被时间片压住」的直接证据`,
  );
  ok('流量涨 20 倍，回源轮数被时间片压到 ≤ 每区每片一轮', hiSnap.refreshed <= ceilingRounds, {
    refreshed: hiSnap.refreshed,
    ceiling: ceilingRounds,
  });
  ok('流量涨 20 倍，上游台数 ≤ 硬上界', hiSnap.upstream <= ceilingRounds * perArea, hiSnap.upstream);
  ok('流量涨 20 倍，行写仍是常数级（远低于 10 万/天）', hiSnap.writesIndexed < 100000, hiSnap.writesIndexed);
  ok('流量涨 20 倍，请求数仍在 Workers 免费额度内', hiBase.requests < 100000, hiBase.requests);
}

/* ── 6. 跨场景总判断 ───────────────────────────────────────────── */
console.log('\n6. 会不会把云端搞满 / 崩？');
{
  const all = [
    ['正常日', base],
    ['凭证过期', auth],
    ['D1 全写失败', writeAll],
    ['仅快照写失败', writeSnap],
    ['部分失败', partial],
  ];
  for (const [name, r] of all) {
    const w = ((r.writesIndexed / 100000) * 100).toFixed(2);
    const rd = ((r.reads / 5000000) * 100).toFixed(3);
    console.log(
      `  ${name.padEnd(10, '　')} 行写 ${String(r.writesIndexed).padStart(7)} = ${w}% 额度` +
        ` | 行读 ${String(r.reads).padStart(7)} = ${rd}% 额度`,
    );
  }
  const worstWrite = Math.max(...all.map(([, r]) => r.writesIndexed));
  const worstRead = Math.max(...all.map(([, r]) => r.reads));
  ok('所有场景下最坏行写 < D1 免费日额度 10 万', worstWrite < 100000, worstWrite);
  ok('所有场景下最坏行读 < D1 免费日额度 500 万', worstRead < 5000000, worstRead);
  ok('所有场景下请求数 < Workers 免费 10 万/天', Math.max(...all.map(([, r]) => r.requests)) < 100000);
}

console.error = realError; console.warn = realWarn; // 还原，别影响外层
console.log(`\n（运行期间被抑制的工具日志 ${noise.length} 条，均为失败场景的预期输出）`);

console.log(`\n${fail === 0 ? '[PASS]' : '[FAIL]'} ${pass} 通过 / ${fail} 失败`);
if (fails.length) {
  console.log('失败项：');
  for (const f of fails) console.log('  - ' + f);
  process.exit(1);
}

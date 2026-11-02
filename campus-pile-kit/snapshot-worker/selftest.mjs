/**
 * 本地自测：不连 Cloudflare、不连上游，只验证逻辑。
 *
 *   node campus-pile-kit/snapshot-worker/selftest.mjs
 *
 * 覆盖的都是「写错了不会报错、只会慢慢烂」的地方：
 *   锁的原子性 / 固定 key / 120 秒节流 / 上游全挂时保留旧数据 / 统计的 null 与去重
 */


import { readFileSync } from 'node:fs';
import {
  TUNING,
  intervalFor,
  shouldRunAt,
  catchupNeeded,
  SCHEDULE,
  MIN_INTERVAL_MIN,
  AREA_CRON_MINUTES,
  AREA_CRON_GROUPS,
  STATS_CRON_MINUTES,
} from './config.mjs';
import { KEYS, refreshArea, snapFor, appendStats, sliceOf, WriteGuard, inflightRecently } from './core.mjs';
import { PARTITIONS } from './partitions.mjs';
import { createBucket, createClock, createScanner, asBatch } from './mock.mjs';

const AREAS = PARTITIONS.areas;

/** 2026-10-27 08:00 北京时间 = 2026-10-27T00:00:00Z */
const T0 = Date.UTC(2026, 9, 27, 0, 0, 0) / 1000;

async function readJson(bucket, key) {
  const obj = await bucket.get(key);
  return obj ? JSON.parse(await obj.text()) : null;
}

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

function eq(name, actual, expected) {
  ok(name, JSON.stringify(actual) === JSON.stringify(expected), { actual, expected });
}

/* ── 1. 分区表 ─────────────────────────────────────────────────── */
console.log('\n1. 分区表');
ok('总量 174 台', PARTITIONS.total === 174, PARTITIONS.total);
ok('6 个分区', AREAS.length === 6, AREAS.length);
ok(
  '每个区都能被 SCAN_CHUNK 拆成 ≤ 5 批',
  AREAS.every((a) => a.count >= 1 && Math.ceil(a.count / TUNING.SCAN_CHUNK) <= 5),
  AREAS.map((a) => `${a.key}:${a.count}→${Math.ceil(a.count / TUNING.SCAN_CHUNK)}批`),
);
ok('分区台数之和 = 总量', AREAS.reduce((s, a) => s + a.count, 0) === PARTITIONS.total);
/* 一个分区的设备必须同源：/api/pile 一次只认一个 src，混着放会让一半 id
   打到错的平台、整批报错（2026-10-31 v2.63 加第二个平台时的红线）。 */
ok(
  '每个分区的数据源都是 zm 或 lvcc',
  AREAS.every((a) => (a.src || 'zm') === 'zm' || a.src === 'lvcc'),
  AREAS.map((a) => `${a.key}:${a.src || 'zm'}`),
);
ok(
  '住宅那 8 台走 lvcc（驴充充，无鉴权）',
  (AREAS.find((a) => a.key === 'zhu') || {}).src === 'lvcc',
  (AREAS.find((a) => a.key === 'zhu') || {}).src,
);

/* ── 2. 时段表 ─────────────────────────────────────────────────── */
console.log('\n2. 时段表');
eq('北京 08:00（高峰）间隔 = 300 秒', intervalFor(T0), 300);
eq('北京 03:00（深夜）间隔 = 3600 秒', intervalFor(T0 + 3 * 3600 - 8 * 3600), 3600);
ok('高峰档每小时 12 跳', [0, 5, 10, 15, 20, 25, 30, 35, 40, 45, 50, 55].every((m) => shouldRunAt(T0 + m * 60, 0)));
ok('高峰档 :01 不跑', shouldRunAt(T0 + 60, 0) === false);
ok('深夜档只有整点跑', shouldRunAt(T0 - 8 * 3600 + 3 * 3600, 0) === true);
ok('深夜档 :05 不跑', shouldRunAt(T0 - 8 * 3600 + 3 * 3600 + 300, 0) === false);
ok('偏移 1 的分区在 :01 跑', shouldRunAt(T0 + 60, 1) === true);

/* ── 2b. 配置与部署文件不能漂移 ──────────────────────────────────── */
console.log('\n2b. 配置一致性');
{
  /* 时段表的每个值都必须是「cron 能表达的粒度」。写 7 分钟的话
     `shouldRunAt` 会去等 7 的倍数，而 cron 只有 5 分钟一跳 ——
     绝大多数跳都会被判成「不该跑」，表现是「某些小时莫名不刷新」，
     不报错、不告警。 */
  const allIntervals = [...SCHEDULE.weekday, ...SCHEDULE.weekend];
  ok(
    '时段表全是 5 的倍数（cron 的最小粒度）',
    allIntervals.every((m) => m % MIN_INTERVAL_MIN === 0),
    allIntervals.filter((m) => m % MIN_INTERVAL_MIN !== 0),
  );
  ok(
    '时段表没有低于最小粒度的值',
    allIntervals.every((m) => m >= MIN_INTERVAL_MIN),
    Math.min(...allIntervals),
  );

  /* 🔴 wrangler.toml 里的 crons 是**另一份手写配置**，和 config.mjs 没有任何
     代码上的联系。改了 config 忘了改 toml，表现是「某一跳永远不触发」，
     而且 /api/health 一切正常。这条断言直接读文件比对。 */
  const toml = readFileSync(new URL('./wrangler.toml', import.meta.url), 'utf8');
  const cronsBlock = /crons\s*=\s*\[([\s\S]*?)\]/.exec(toml);
  const tomlCrons = cronsBlock
    ? [...cronsBlock[1].matchAll(/"([^"]+)"/g)].map((m) => m[1])
    : [];
  eq('wrangler.toml 里有 5 条 cron', tomlCrons.length, 5);
  eq(
    '分区 cron 与 AREA_CRON_MINUTES 对齐',
    AREA_CRON_MINUTES.map((m) => `${m}-59/5 * * * *`),
    tomlCrons.slice(0, AREA_CRON_MINUTES.length),
  );
  eq(
    '统计 cron 与 STATS_CRON_MINUTES 对齐',
    tomlCrons[4],
    `${STATS_CRON_MINUTES.join(',')} * * * *`,
  );
  /* 🔴 统计那几跳不能和分区 cron 撞分钟：每分钟只允许一个 cron 在跑，
     而统计第一件事就是读各区的快照。分区 cron 是 `N-59/5`，也就是
     「分钟 % 5 ∈ {0,1,2,3}」；统计只能取 % 5 === 4 那一档。 */
  eq('统计 cron 每小时三跳', STATS_CRON_MINUTES.length, 3);
  eq(
    '统计的分钟数取「% 5 === 4」那一档',
    STATS_CRON_MINUTES.filter((m) => m % 5 !== 4),
    [],
  );
  ok(
    '统计 cron 与分区 cron 不共用任何一分钟',
    STATS_CRON_MINUTES.every((m) => !AREA_CRON_MINUTES.some((o) => o % 5 === m % 5)),
    `stats=:${STATS_CRON_MINUTES.join('/')} 分区=${AREA_CRON_MINUTES.join('/')}`,
  );
  /* 🔴 分区组（v2.65）：一跳可以刷多个区，但每个区**必须刚好被排到一次**。
     漏一个 = 那个区的快照永远不刷新（一周回顾里那条线永远是空的，不报错）；
     重一个 = 同一分钟两个区抢同一份资源，白白多一轮上游请求。 */
  const grouped = AREA_CRON_GROUPS.flat();
  eq('每个分区都排进了某一跳（不多不少）', [...grouped].sort(), AREAS.map((a) => a.key).sort());
  eq('分区组数与分区 cron 数一致', AREA_CRON_GROUPS.length, AREA_CRON_MINUTES.length);
  eq(
    '一跳最多两个区',
    Math.max(...AREA_CRON_GROUPS.map((g) => g.length)),
    2,
  );
  eq(
    '住宅与朝晖同一跳（v2.76 重排：把 :03 让给北院）',
    AREA_CRON_GROUPS.find((g) => g.includes('zhu')),
    ['zhu', 'chaohui'],
  );
  /* 🔴 加区时最容易犯的错：往某一跳里硬塞，把那一分钟的台数从 30 抬到 90。
     实测 57 台整轮 5.3 秒 / 37 台 ~5 秒，超过 70 台就逼近 CPU 10ms 和
     18 秒扫描预算 —— 这里按台数卡一刀，逼着加区的人去重排而不是堆。 */
  const countByKey = {};
  for (const a of AREAS) countByKey[a.key] = a.count;
  const heaviest = Math.max(
    ...AREA_CRON_GROUPS.map((g) => g.reduce((s, k) => s + (countByKey[k] || 0), 0)),
  );
  ok('一跳总台数 ≤ 70（超了要重排，不能硬塞）', heaviest <= 70, `最重一跳 ${heaviest} 台`);
  eq(
    '北院独占一跳（57 台，谁也别和它挤）',
    AREA_CRON_GROUPS.find((g) => g.includes('beiyuan')),
    ['beiyuan'],
  );

  /* 在飞判定窗口必须盖得住最坏的一轮扫描，否则自己就会叠。 */
  ok(
    'INFLIGHT_S 大于扫描超时',
    TUNING.INFLIGHT_S * 1000 > TUNING.SCAN_TIMEOUT_MS,
    `${TUNING.INFLIGHT_S}s vs ${TUNING.SCAN_TIMEOUT_MS}ms`,
  );
}

/* ── 3. 一轮全量：固定 5 个对象 ─────────────────────────────────── */
console.log('\n3. 一轮全量');
{
  const bucket = createBucket();
  const clock = createClock(T0);
  const scanner = createScanner();

  for (const area of AREAS) {
    // 这一节在造数据：四个区同一瞬间刷，等价于 cron 的 0/1/2/3 错峰，故关掉全站锁
    await refreshArea({ bucket, area, now: clock.now, scanBatch: asBatch(scanner), useGlobalLock: false });
  }

  eq('每个分区一个快照（固定 key）', bucket.businessKeys(), AREAS.map((a) => `snap/${a.key}.json`).sort());

  const snap = await readJson(bucket, KEYS.snap('beimen'));
  eq('北门台数 = 37', snap.piles, 37);
  eq('北门端口总数 = 148', snap.total, 148);
  ok('北门空闲端口在 0–148 之间', snap.free >= 0 && snap.free <= 148, snap.free);
  eq('北门 interval = 300', snap.interval, 300);
  eq('北门 next = at + 300', snap.next, snap.at + 300);
  eq('北门 error = null', snap.error, null);
  ok('北门 used_pct 在 0–100 之间', snap.used_pct >= 0 && snap.used_pct <= 100, snap.used_pct);
  ok('每区扫描次数 = 该区台数', scanner.count === AREAS.reduce((s, a) => s + a.count, 0), scanner.count);

  /* 再跑一轮（120 秒后，新时间片）不应该新增业务对象 —— 只覆盖 */
  clock.tick(120);
  scanner.reset();
  for (const area of AREAS) {
    // 这一节在造数据：四个区同一瞬间刷，等价于 cron 的 0/1/2/3 错峰，故关掉全站锁
    await refreshArea({ bucket, area, now: clock.now, scanBatch: asBatch(scanner), useGlobalLock: false });
  }
  eq('第二轮后业务对象仍是每区一个', bucket.businessKeys().length, AREAS.length);
  eq('锁对象随时间片累积（每个区一片）', bucket.lockKeys().length, AREAS.length * 2);
}

/* ── 4. 锁的原子性 ─────────────────────────────────────────────── */
console.log('\n4. 锁');
{
  const bucket = createBucket();
  const clock = createClock(T0);
  const scanner = createScanner();
  const area = AREAS[0];

  const results = await Promise.all(
    Array.from({ length: 5 }, () => refreshArea({ bucket, area, now: clock.now, scanBatch: asBatch(scanner) })),
  );
  eq('5 个并发只有 1 个抢到锁', results.filter((r) => r.locked).length, 1);
  eq('只有抢到锁的那个打了上游', scanner.count, area.count);
  eq('锁 key 带时间片', bucket.lockKeys().filter((k) => !k.startsWith('lock/_global/')), [`lock/${area.key}/${sliceOf(T0)}`]);
  eq('全站锁另外算', bucket.lockKeys().filter((k) => k.startsWith('lock/_global/')).length, 1);
}

/* ── 5. 120 秒节流 ─────────────────────────────────────────────── */
console.log('\n5. 节流');
{
  const bucket = createBucket();
  const clock = createClock(T0);
  const scanner = createScanner();
  const area = AREAS[0];

  await refreshArea({ bucket, area, now: clock.now, scanBatch: asBatch(scanner) });
  const base = scanner.count;

  clock.tick(30);
  let r = await snapFor({ bucket, area, now: clock.now, wantRefresh: true, scanBatch: asBatch(scanner) });
  eq('30 秒后打开：节流生效', r.throttled, true);
  eq('30 秒后打开：没有再打上游', scanner.count, base);

  clock.tick(100); // 累计 130 秒
  r = await snapFor({ bucket, area, now: clock.now, wantRefresh: true, scanBatch: asBatch(scanner) });
  eq('130 秒后打开：自己刷了一轮', r.refreshed, true);
  eq('130 秒后打开：快照年龄归零', r.age, 0);
  ok('快照里有 piles / used_pct', typeof r.snapshot.piles === 'number' && typeof r.snapshot.used_pct === 'number', {
    piles: r.snapshot.piles,
    used_pct: r.snapshot.used_pct,
  });
  eq('130 秒后打开：打了一整轮', scanner.count, base + area.count);
  eq('响应里带上 tuning', r.tuning.throttle_s, 120);

  clock.tick(10);
  r = await snapFor({ bucket, area, now: clock.now, wantRefresh: false, scanBatch: asBatch(scanner) });
  eq('不要求刷新时永不打上游', scanner.count, base + area.count);
  eq('age 正确反映快照年龄', r.age, 10);
}

/* ── 6. 抢不到锁时复用 ─────────────────────────────────────────── */
console.log('\n6. 抢不到锁');
{
  const bucket = createBucket();
  const clock = createClock(T0);
  const scanner = createScanner();
  const area = AREAS[0];

  await refreshArea({ bucket, area, now: clock.now, scanBatch: asBatch(scanner) });
  const before = (await readJson(bucket, KEYS.snap(area.key))).at;

  clock.tick(200);
  await bucket.put(KEYS.lock(area.key, sliceOf(clock.now())), 'someone-else', {
    onlyIf: new Headers({ 'If-None-Match': '*' }),
  });
  const base = scanner.count;
  const r = await snapFor({ bucket, area, now: clock.now, wantRefresh: true, scanBatch: asBatch(scanner) });

  eq('返回 refreshing = true', r.refreshing, true);
  eq('没有重复打上游', scanner.count, base);
  eq('快照没有被改写', r.snapshot.at, before);
}

/* ── 6b. 全站分钟锁（分区锁防不住「四区叠加」） ───────────────── */
console.log('\n6b. 全站锁');
{
  const bucket = createBucket();
  const clock = createClock(T0);
  const scanner = createScanner();

  // 同一分钟，四个区同时想刷 —— 这正是「109 台/分」事故形态
  const rs = await Promise.all(
    AREAS.map((area) => refreshArea({ bucket, area, now: clock.now, scanBatch: asBatch(scanner) })),
  );
  eq('同一分钟只放行一个区', rs.filter((r) => r.locked).length, 1);
  eq('其余分区标记为 global', rs.filter((r) => r.reason === 'global').length, AREAS.length - 1);
  eq('这一分钟的上游量 = 单个分区（不是 109）', scanner.count, AREAS[0].count);
  eq('只有被放行的区写了快照', bucket.businessKeys().length, 1);

  const lockedArea = AREAS[rs.findIndex((r) => r.locked)];
  eq('被放行的区在 lock/_global 下留了一个全站锁', bucket.lockKeys().some((k) => k.startsWith('lock/_global/')), true);

  clock.tick(TUNING.LOCK_SLICE_S); // 跨过一个时间片
  const nxt = await refreshArea({ bucket, area: AREAS[1], now: clock.now, scanBatch: asBatch(scanner) });
  eq('下一个时间片换下一个区', nxt.locked, true);
  eq('现在有两份快照', bucket.businessKeys().length, 2);

  const off = await refreshArea({
    bucket,
    area: AREAS[2],
    now: clock.now,
    scanBatch: asBatch(scanner),
    useGlobalLock: false,
  });
  eq('控制台/单测可以关掉全站锁', off.locked, true);
  ok('关掉后不需要知道被放行的是谁', typeof lockedArea.key === 'string');
}

/* ── 7. 上游全挂：保留旧数据但年龄继续变老 ─────────────────────── */
console.log('\n7. 上游全挂');
{
  const bucket = createBucket();
  const clock = createClock(T0);
  const scanner = createScanner();
  const area = AREAS[1];

  await refreshArea({ bucket, area, now: clock.now, scanBatch: asBatch(scanner) });
  const good = await readJson(bucket, KEYS.snap(area.key));

  scanner.setMode('fail');
  clock.tick(300);
  await refreshArea({ bucket, area, now: clock.now, scanBatch: asBatch(scanner) });
  const bad = await readJson(bucket, KEYS.snap(area.key));

  eq('error.code = upstream', bad.error && bad.error.code, 'upstream');
  eq('失败台数 = 全区台数', bad.error.failed, area.count);
  eq('at 保持不变（年龄继续变老）', bad.at, good.at);
  eq('数据保留上一份', bad.devices, good.devices);
  eq('total 保留上一份', bad.total, good.total);
  eq('free 保留上一份', bad.free, good.free);
  eq('error.since 记下起始时刻', bad.error.since, clock.now());

  /* 第一次失败已经触发 5 分钟退避，所以要先跳过它才验证得到「凭证过期」这条分支 */
  scanner.setMode('auth');
  clock.set(bad.retryAfter + 1);
  await refreshArea({ bucket, area, now: clock.now, scanBatch: asBatch(scanner) });
  const authBad = await readJson(bucket, KEYS.snap(area.key));
  eq('凭证失效单独区分出来', authBad.error && authBad.error.code, 'auth');
  eq('auth 时 since 沿用第一次失败的时刻', authBad.error.since, bad.error.since);

  /* 退避：凭证过期时重试毫无意义，必须自己踩刹车。
     审计实测「不退避」的代价是一天白打 29,832 台（比正常时还多）。 */
  ok('连续失败 → failStreak 累加', authBad.failStreak >= 2, authBad.failStreak);
  /* 第 2 次 auth 失败**还只是探针**，不该一步退到 6 小时：
     403（限流）也被标成 auth，一步退 6 小时会让一次几分钟的限流变成半天停更。
     速率审计实测：改之前 403 场景 97% 的时间四区全超龄。 */
  ok(
    '第 2 次 auth 仍按探针退避（≤ 15 分钟）',
    authBad.retryAfter - clock.now() <= 900,
    authBad.retryAfter - clock.now(),
  );

  const beforeBackoff = scanner.count;
  clock.tick(120);
  const bo = await refreshArea({ bucket, area, now: clock.now, scanBatch: asBatch(scanner) });
  eq('退避期内仍拿到锁（锁不空转给别人）', bo.locked, true);
  eq('但明确标记为 backoff 跳过', bo.skipped, 'backoff');
  eq('退避期内一台都没打上游', scanner.count, beforeBackoff);
  eq('数据原样返回', bo.snap.at, bad.at);

  /* 平台恢复后，一次成功就把计数清零 —— 偶尔抖一下不该把下次刷新推到一小时后 */
  scanner.setMode('ok');
  clock.set(authBad.retryAfter + 1);
  const recovered = await refreshArea({ bucket, area, now: clock.now, scanBatch: asBatch(scanner) });
  eq('退避到期后恢复扫描', recovered.locked && !recovered.skipped, true);
  eq('恢复后 failStreak 清零', recovered.snap.failStreak, 0);
  eq('恢复后 retryAfter 清零', recovered.snap.retryAfter, 0);
}

/* ── 7b. force 逃生门（推完新凭证立刻解除退避） ─────────────────── */
console.log('\n7b. force 逃生门');
{
  const bucket = createBucket();
  const clock = createClock(T0);
  const scanner = createScanner({ mode: 'auth' });
  const area = AREAS[0];

  const bad = await refreshArea({ bucket, area, now: clock.now, scanBatch: asBatch(scanner) });
  ok('第一次就失败 → 进入退避', bad.locked && bad.snap.retryAfter > clock.now(), bad.snap.retryAfter);

  /* 跨过一个时间片：分区锁本来就该挡「120 秒内重复扫同一区」，
     force 不破坏这条正确性保护，只是运维动作可以等 120 秒再按。 */
  clock.tick(TUNING.LOCK_SLICE_S);
  const before = scanner.count;
  const r1 = await snapFor({ bucket, area, now: clock.now, wantRefresh: true, scanBatch: asBatch(scanner) });
  eq('退避期内标记为 backoff', r1.blocked_by, 'backoff');
  eq('退避期内返回下次可试时刻', typeof r1.next_retry, 'number');
  eq('退避期内一台都不打', scanner.count, before);

  scanner.setMode('ok');
  const r2 = await snapFor({
    bucket,
    area,
    now: clock.now,
    wantRefresh: true,
    scanBatch: asBatch(scanner),
    force: true,
  });
  eq('force=1 立刻解除退避', r2.refreshed, true);
  eq('force=1 真的打了上游', scanner.count, before + area.count);
  eq('force 之后 retryAfter 清零', r2.snapshot.retryAfter, 0);
  eq('force 之后 failStreak 清零', r2.snapshot.failStreak, 0);
}

/* ── 7c. auth 退避阶梯（区分「临时限流」和「真过期」） ──────────── */
console.log('\n7c. auth 退避阶梯');
{
  const bucket = createBucket();
  const clock = createClock(T0);
  const scanner = createScanner({ mode: 'auth' });
  const area = AREAS[0];

  const waits = [];
  for (let i = 0; i < 4; i += 1) {
    await refreshArea({
      bucket,
      area,
      now: clock.now,
      scanBatch: asBatch(scanner),
      useGlobalLock: false,
    });
    const snap = await readJson(bucket, KEYS.snap(area.key));
    waits.push(Math.round(snap.retryAfter - clock.now()));
    clock.set(snap.retryAfter + 1);
  }

  eq('第 1 次 auth → 探针 10 分钟', waits[0], TUNING.AUTH_PROBE_BACKOFF_S);
  eq('第 2 次 auth → 仍是探针', waits[1], TUNING.AUTH_PROBE_BACKOFF_S);
  eq('第 3 次 auth → 确认真过期，升到 6 小时', waits[2], TUNING.AUTH_BACKOFF_S);
  eq('第 4 次 auth → 保持 6 小时', waits[3], TUNING.AUTH_BACKOFF_S);
  ok(
    '确认前的探测只多打 2 轮，代价可忽略',
    waits.filter((w) => w === TUNING.AUTH_PROBE_BACKOFF_S).length === TUNING.AUTH_CONFIRM_STREAK - 1,
    waits,
  );
}

/* ── 7d. 数据够新就别扫（cron 也要尊重节流） ────────────────────── */
console.log('\n7d. 够新就跳过');
{
  const bucket = createBucket();
  /* 从时间片末尾开始，好让它和下一跳之间**跨过片边界** ——
     这正是「用户补刷完、cron 下一跳落到新时间片」的真实形态：
     分区锁管不到（不同片），只有节流判断能拦住。 */
  const clock = createClock(T0 + 110);
  const scanner = createScanner();
  const area = AREAS[0];

  const first = await refreshArea({
    bucket, area, now: clock.now, scanBatch: asBatch(scanner), useGlobalLock: false,
  });
  eq('第一轮正常扫描', first.locked && !first.skipped, true);
  const afterFirst = scanner.count;

  /* 15 秒后再要求刷新同一区：跨了片（锁放行），但数据才 15 秒新。
     修复前这里会再扫一遍 —— 速率审计实测全天 540 台次纯浪费。 */
  clock.tick(15);
  const second = await refreshArea({
    bucket, area, now: clock.now, scanBatch: asBatch(scanner), useGlobalLock: false,
  });
  eq('15 秒后再刷：拿到锁但跳过扫描', second.locked, true);
  eq('跳过原因是 fresh', second.skipped, 'fresh');
  eq('一台都没打上游', scanner.count, afterFirst);
  eq('快照原样返回（at 不变）', second.snap.at, first.snap.at);

  /* 超过节流门槛就该真扫 */
  clock.tick(TUNING.THROTTLE_S);
  const third = await refreshArea({
    bucket, area, now: clock.now, scanBatch: asBatch(scanner), useGlobalLock: false,
  });
  eq('超过节流门槛 → 真扫', third.skipped, undefined);
  eq('上游被打了一次', scanner.count, afterFirst + area.count);

  /* force 必须绕过这道检查，否则「推完新凭证立刻验一次」会失效 */
  clock.tick(1);
  const forced = await refreshArea({
    bucket, area, now: clock.now, scanBatch: asBatch(scanner),
    useGlobalLock: false, ignoreBackoff: true, ignoreFreshness: true, skipAreaLock: true,
  });
  eq('force 绕过「够新」检查', forced.skipped, undefined);
  eq('force 真的扫了', scanner.count, afterFirst + area.count * 2);
}

/* ── 7e. 预算耗尽（busy）不该当成平台故障 ──────────────────────── */
console.log('\n7e. 预算耗尽');
{
  const bucket = createBucket();
  const clock = createClock(T0);
  const area = AREAS[0];

  /* 模拟 /api/pile 把整批降级成 throttled（我们自己人太多，240 台/分用完） */
  const throttledBatch = async (ids) =>
    ids.map((id) => ({ id, error: '刚才查询的人太多了，几秒后再点一次刷新', throttled: true }));

  const r1 = await refreshArea({
    bucket, area, now: clock.now, scanBatch: throttledBatch, useGlobalLock: false,
  });
  eq('整批被挤掉 → 错误码是 busy', r1.snap.error && r1.snap.error.code, 'busy');
  eq('busy 不累加 failStreak', r1.snap.failStreak, 0);
  eq(
    'busy 只退 60 秒（预算下分钟就重置）',
    Math.round(r1.snap.retryAfter - clock.now()),
    TUNING.BUSY_BACKOFF_S,
  );

  /* 对照：平台真没响应时要退 5 分钟。
     跨一个时间片 —— 分区锁本来就该挡「120 秒内重扫同一区」。 */
  const deadBatch = async (ids) => ids.map((id) => ({ id, error: '平台没响应（8 秒超时）' }));
  clock.set(r1.snap.retryAfter + TUNING.LOCK_SLICE_S);
  const r2 = await refreshArea({
    bucket, area, now: clock.now, scanBatch: deadBatch, useGlobalLock: false,
  });
  eq('平台没响应 → upstream', r2.snap.error && r2.snap.error.code, 'upstream');
  eq('upstream 才累加 failStreak', r2.snap.failStreak >= 1, true);
  ok(
    'upstream 退避明显长于 busy',
    r2.snap.retryAfter - clock.now() > TUNING.BUSY_BACKOFF_S * 3,
    r2.snap.retryAfter - clock.now(),
  );

  /* 🔴 结构化信号优先于文案正则：即使站点改了文案（不再含「太多」两字），
     只要 throttled:true 标志还在，就必须正确归成 busy，而不是靠正则
     碰运气掉进 upstream。用独立的桶和时钟，不干扰上面的时序。 */
  {
    const b2 = createBucket();
    const c2 = createClock(T0);
    const renamedBatch = async (ids) =>
      ids.map((id) => ({ id, error: '请稍后再试', throttled: true }));
    const rRenamed = await refreshArea({
      bucket: b2, area, now: c2.now, scanBatch: renamedBatch, useGlobalLock: false,
    });
    eq('文案改了但 throttled 标志在 → 仍是 busy', rRenamed.snap.error && rRenamed.snap.error.code, 'busy');
  }
}

/* ── 8. 每小时统计 ─────────────────────────────────────────────── */
console.log('\n8. 每小时统计');
{
  const bucket = createBucket();
  const clock = createClock(T0);
  const scanner = createScanner();

  for (const area of AREAS) {
    // 这一节在造数据：四个区同一瞬间刷，等价于 cron 的 0/1/2/3 错峰，故关掉全站锁
    await refreshArea({ bucket, area, now: clock.now, scanBatch: asBatch(scanner), useGlobalLock: false });
  }

  clock.set(T0 + 2200); // 36 分钟后：除刚刷的北门外全部超龄（>1800 秒）
  await refreshArea({ bucket, area: AREAS[1], now: clock.now, scanBatch: asBatch(scanner) });

  const res = await appendStats({ bucket, areas: AREAS, now: clock.now });
  eq('该小时只落 1 个点', res.kept, 1);
  eq('chaohui 超龄 → pct = null', res.point.areas.chaohui.pct, null);
  eq('chaohui 标记为 stale', res.point.areas.chaohui.reason, 'stale');
  ok('beimen 有效 → pct 有值', typeof res.point.areas.beimen.pct === 'number', res.point.areas.beimen);
  eq('全校只按有效区计算', res.point.all, res.point.areas.beimen.pct);
  eq('coverage 报出只有 1 个区参与', res.point.coverage, 1);

  const again = await appendStats({ bucket, areas: AREAS, now: clock.now });
  eq('同一小时重复采样不增点', again.kept, 1);

  const stats = await readJson(bucket, KEYS.stats());
  eq('统计对象只有 1 个点', stats.points.length, 1);
}

/* ── 8b. partial 且接不齐 → 仍然不入账 ───────────────────────────── */
/* 没有上一份快照可接（新桩一次都没成功过）时，partial 快照的
   used_pct/total/free 仍是「只含成功那批桩」的残缺口径。这种时候宁可空着，
   也不拿半区的数冒充全区 —— 前端会画成灰桩，用户知道这一格没采到。 */
console.log('\n8b. partial 接不齐 → 不入账');
{
  const bucket = createBucket();
  const clock = createClock(T0);
  const scanner = createScanner({ mode: 'some-fail' }); // 每 3 台挂 1 台 → partial

  await refreshArea({ bucket, area: AREAS[0], now: clock.now, scanBatch: asBatch(scanner), useGlobalLock: false });
  const res = await appendStats({ bucket, areas: AREAS, now: clock.now });

  const c = res.point.areas.chaohui;
  eq('无上一份可接 → pct 置 null', c.pct, null);
  eq('无上一份可接 → reason = partial', c.reason, 'partial');
  eq('无上一份可接 → 不计入 coverage', res.point.coverage, 0);
  eq('只有 partial 区时 all = null', res.point.all, null);
}

/* ── 8c. partial 但能接上上一份 → 全区口径，正常入账 ──────────────── */
/* 2026-11-01 修的就是这一条：用户看到「某个地址某个时段没记录」，74 个点里
   5 个全是 partial —— 分区 cron 5 分钟就自愈的抖动，把整小时判死了。
   现在 refreshArea 会把失败那几台接上上一份数据，total/free 重新是全区口径，
   于是这一格有数可记（`est` 记下接了几台）。 */
console.log('\n8c. partial 接齐 → 入账');
{
  const bucket = createBucket();
  const clock = createClock(T0);
  const scanner = createScanner(); // 先来一轮正常的，攒出 prev

  await refreshArea({ bucket, area: AREAS[0], now: clock.now, scanBatch: asBatch(scanner), useGlobalLock: false });
  const full = await readJson(bucket, KEYS.snap(AREAS[0].key));
  const fullTotal = full.total;

  clock.set(T0 + 600); // 10 分钟后：超 THROTTLE_S，且「每 3 台挂 1 台」从第 1 台重新数
  scanner.setMode('some-fail');
  const r = await refreshArea({
    bucket, area: AREAS[0], now: clock.now, scanBatch: asBatch(scanner), useGlobalLock: false,
  });

  ok('这一轮确实是 partial', r.snap.error && r.snap.error.code === 'partial', r.snap.error);
  ok('失败台全部接上了上一份', r.snap.carried === r.snap.failed && r.snap.failed > 0, {
    carried: r.snap.carried, failed: r.snap.failed,
  });
  eq('total 仍是全区口径（不是只剩成功那批）', r.snap.total, fullTotal);
  eq('piles 覆盖全区', r.snap.piles, AREAS[0].ids.length);

  const res = await appendStats({ bucket, areas: AREAS, now: clock.now });
  const c = res.point.areas.chaohui;
  ok('partial 区 pct 有值（不再是灰桩）', typeof c.pct === 'number', c);
  eq('reason 不再是 partial', c.reason, undefined);
  eq('est 记下接了几台', c.est, r.snap.failed);
  eq('计入 coverage', res.point.coverage, 1);
  ok('all 用全区口径算出来', typeof res.point.all === 'number', res.point.all);
}

/* ── 8d. 同一小时多次采样 → 按区择优合并 ────────────────────────── */
/* 每小时三跳之后，「覆盖」就不能用了：第二跳若正好抖一下，会把第一跳采到的
   好读数擦成 null —— 多采样反而制造灰桩。规则改成「新区有数用新的，新区没数
   保留旧的」，并且 all/coverage 用合并后的各区重算。 */
console.log('\n8d. 同小时合并');
{
  /* ① 好的读数不被后来的空值擦掉 */
  const b1 = createBucket();
  const c1 = createClock(T0);
  const s1 = createScanner();
  for (const area of AREAS) {
    await refreshArea({ bucket: b1, area, now: c1.now, scanBatch: asBatch(s1), useGlobalLock: false });
  }
  const first = await appendStats({ bucket: b1, areas: AREAS, now: c1.now });
  eq('首跳采满 5 区', first.point.coverage, AREAS.length);

  /* 同一个小时内（< 3600 秒），但快照已超过 maxAge(1800) → 这一跳若按老逻辑
     覆盖写，各区分量就会全变 null。这里断言它们**与首跳逐区相同**。 */
  c1.set(T0 + 1900);
  const second = await appendStats({ bucket: b1, areas: AREAS, now: c1.now });
  const sameAsFirst = AREAS.every(
    (a) => second.point.areas[a.key].pct === first.point.areas[a.key].pct,
  );
  ok('第二跳全是空值，但各区分量仍是首跳的数（没被擦掉）', sameAsFirst, second.point.areas);
  eq('首跳的好读数被保留（不被空值擦掉）', second.point.coverage, AREAS.length);
  eq('仍是同一个点（不新增）', second.kept, 1);
  eq('samples 记下采了几次', second.point.samples, 2);

  /* ② 后来的好读数能把先前空着的那格补上 */
  const b2 = createBucket();
  const c2 = createClock(T0);
  const s2 = createScanner();
  const empty = await appendStats({ bucket: b2, areas: AREAS, now: c2.now });
  eq('先采一次：全空', empty.point.coverage, 0);

  c2.set(T0 + 600);
  for (const area of AREAS) {
    await refreshArea({ bucket: b2, area, now: c2.now, scanBatch: asBatch(s2), useGlobalLock: false });
  }
  const healed = await appendStats({ bucket: b2, areas: AREAS, now: c2.now });
  eq('补采后 5 区都填上了', healed.point.coverage, AREAS.length);
  eq('仍是一个点', healed.kept, 1);
  ok('all 有值', typeof healed.point.all === 'number', healed.point.all);
}

/* ── 9. 窗口按北京自然日对齐 ───────────────────────────────────── */
/* 前端要「筛某一天看各时段」，窗口就必须落在自然日边界上。滚动 168 小时
   会让最早那天只剩几根柱子 —— 用户会当成数据坏了。 */
const bjDayStartOf = (h) => h - ((h + 8 * 3600) % 86400);
console.log('\n9. 窗口对齐');
{
  const bucket = createBucket();
  const clock = createClock(T0);
  /* 连采 10 天：窗口里最多只该剩 7 个北京自然日。 */
  for (let i = 0; i < 240; i += 1) {
    clock.set(T0 + i * 3600);
    await appendStats({ bucket, areas: AREAS, now: clock.now });
  }
  const stats = await readJson(bucket, KEYS.stats());
  const lastH = T0 + 239 * 3600;
  const bjStart = bjDayStartOf(lastH);

  eq('最新点仍在末尾', stats.points[stats.points.length - 1].h, lastH);
  ok(
    '起点不早于「今天北京 0 点 − 6 天」',
    stats.points[0].h >= bjStart - 6 * 86400,
    { first: stats.points[0].h, floor: bjStart - 6 * 86400 },
  );
  ok(
    '起点不晚于「今天北京 0 点 − 6 天」+ 1 小时',
    stats.points[0].h <= bjStart - 6 * 86400 + 3600,
    { first: stats.points[0].h },
  );
  ok('所有点都在今天北京 0 点之后', stats.points.every((p) => p.h >= bjStart - 6 * 86400), true);
  ok('点数不超过 168', stats.points.length <= 168, stats.points.length);
  eq('全部缺快照 → all = null', stats.points[0].all, null);
  eq('全部缺快照 → coverage 为 0', stats.points[0].coverage, 0);

  /* 四区都新鲜时 coverage 应该是满的 */
  const b2 = createBucket();
  const c2 = createClock(T0);
  const sc2 = createScanner();
  for (const area of AREAS) {
    await refreshArea({ bucket: b2, area, now: c2.now, scanBatch: asBatch(sc2), useGlobalLock: false });
  }
  const r2 = await appendStats({ bucket: b2, areas: AREAS, now: c2.now });
  eq('五区都新鲜 → coverage 5', r2.point.coverage, AREAS.length);
}

/* ── 9b. 漏采不滑窗 ─────────────────────────────────────────────── */
/* 「能不能保证看到过去七天各时段」的核心：窗口按自然日裁，漏采就如实缺格，
   而不是 slice(-168) 把 7 天外的老点挤进来冒充 —— 前端按（天, 时段）
   打格子分辨不出来，整段会静默错位。 */
console.log('\n9b. 漏采不滑窗');
{
  const bucket = createBucket();
  const clock = createClock(T0);
  for (let i = 0; i < 200; i += 1) {
    clock.set(T0 + i * 3600);
    await appendStats({ bucket, areas: AREAS, now: clock.now });
  }
  let s = await readJson(bucket, KEYS.stats());
  const firstH = s.points[0].h;
  eq('连续采满时 gaps 为 0', (await appendStats({ bucket, areas: AREAS, now: clock.now })).gaps, 0);

  /* 连丢 6 跳，再采一次（T0+199h → T0+206h）。 */
  clock.set(T0 + 206 * 3600);
  const res = await appendStats({ bucket, areas: AREAS, now: clock.now });
  s = await readJson(bucket, KEYS.stats());

  eq('gaps 如实报出缺 6 格', res.gaps, 6);
  eq('窗口起点保持不动（旧的 slice(-168) 会往前滑）', s.points[0].h, firstH);
  eq('最新点仍在末尾', s.points[s.points.length - 1].h, T0 + 206 * 3600);
}

/* ── 10. 子请求预算 ────────────────────────────────────────────── */
console.log('\n10. 子请求预算');
{
  /* 🔴 站点 Worker 每台要花 3 个子请求：cache.match（查这份缓存还新吗）
   *    + fetch（真打平台）+ cache.put（写回结果），另外还要 2 个桶读写。
   *
   *    这个式子**没有分支**：撞预算被降级时那几台不再 fetch/put，但会在
   *    「降级时读一次缓存」和「跑完再读一次缓存」各多出 1 次 match，
   *    a + d = N 抵消下来仍然是 3N + 2。
   *
   *    2026-10-29 事故：整区 37 台一把梭 → 39 个额度花在 match + 桶上，
   *    只剩 11 个 fetch 名额 → 前 11 台成功、第 12 台起全「8 秒超时」。 */
  const costOf = (n) => 3 * n + 2;
  const worst = AREAS.reduce((m, a) => Math.max(m, a.count), 0);

  ok(
    `单批 ${TUNING.SCAN_CHUNK} 台 = ${costOf(TUNING.SCAN_CHUNK)} 个子请求 ≤ ${TUNING.SUBREQUEST_LIMIT}`,
    costOf(TUNING.SCAN_CHUNK) <= TUNING.SUBREQUEST_LIMIT,
    costOf(TUNING.SCAN_CHUNK),
  );
  ok('SCAN_CHUNK 落在 3N+2≤50 解出的安全区（≤16）', TUNING.SCAN_CHUNK <= 16, TUNING.SCAN_CHUNK);
  ok(
    '整区一把梭确实会超预算（证明分批不是可选项）',
    costOf(worst) > TUNING.SUBREQUEST_LIMIT,
    `${worst} 台 → ${costOf(worst)}`,
  );
  ok('SCAN_LANES ≥ 1', TUNING.SCAN_LANES >= 1, TUNING.SCAN_LANES);

  /* 时间预算：一批实测 2~3 秒，分两路并发。最坏一轮要跑几批 × 每批秒数 / 路数，
     必须落在 makeScanBatch 的截止点（SCAN_TIMEOUT_MS − 1500ms）之内。 */
  const waves = AREAS.reduce((m, a) => Math.max(m, Math.ceil(a.count / TUNING.SCAN_CHUNK)), 0);
  const lanes = Math.ceil(waves / TUNING.SCAN_LANES);
  ok(
    `最坏 ${waves} 批 ÷ ${TUNING.SCAN_LANES} 路 = ${lanes} 轮 × 3s = ${lanes * 3}s < ${TUNING.SCAN_TIMEOUT_MS - 1500}ms`,
    lanes * 3 * 1000 < TUNING.SCAN_TIMEOUT_MS - 1500,
    lanes,
  );
}

/* ── 11. Worker 入口（cron 映射 / CORS / 路由） ─────────────────── */
console.log('\n11. Worker 入口');
{
  const realNow = Date.now;
  const realFetch = globalThis.fetch;
  const realLog = console.log;

  const bucket = createBucket();
  const scanner = createScanner();
  // 北京 08:01（周二高峰档，间隔 5 分钟）→ 偏移 1 的分区（北门）该跑
  const at = (T0 + 60) * 1000;
  Date.now = () => at;
  const batchSizes = [];
  /* 每一批发出去的 src（缺省 zm）。住宅那 8 台必须带 lvcc ——
     站点 `/api/pile` 就是靠这个开关走无鉴权分支的，漏了会一路
     `no_token`，而快照会把它记成「平台挂了」。 */
  const batchSrcs = [];
  globalThis.fetch = async (url, opts) => {
    const body = JSON.parse(opts.body);
    batchSizes.push(body.ids.length);
    batchSrcs.push(body.src || 'zm');
    const results = {};
    for (const id of body.ids) {
      const r = await scanner.scanOne(id);
      results[id] = { at, ports: r.ports };
    }
    return new Response(JSON.stringify({ ok: true, results }), {
      status: 200,
      headers: { 'content-type': 'application/json' },
    });
  };

  const logs = [];
  console.log = (...a) => logs.push(a.join(' '));
  const realWarn = console.warn;
  console.warn = (...a) => logs.push('WARN ' + a.join(' '));

  try {
    const mod = await import('./worker.mjs');
    const env = { SNAP: bucket, PILE_ORIGIN: 'https://example.test', SNAP_KEY: 'k' };
    const ctx = { waitUntil() {} };

    await mod.default.scheduled({ cron: '1-59/5 * * * *' }, env, ctx);
    const beimen = await readJson(bucket, KEYS.snap('beimen'));
    ok('cron 偏移 1 → 刷北门', beimen && beimen.piles === 37, beimen && beimen.piles);
    eq('刷完只有北门一个快照', bucket.businessKeys(), ['snap/beimen.json']);
    eq('内部密钥随请求发出', scanner.count, 37);

    /* 🔴 分批不是「优化」，是唯一能拿到完整数据的方式：整批 37 台会撞站点
       Worker 的子请求额度，前 11 台成功、其余全「8 秒超时」，而且返回体
       看起来完全正常。所以这里必须验证**真的拆了批、每批都在安全线内**。 */
    const wantBatches = Math.ceil(37 / TUNING.SCAN_CHUNK);
    ok(
      `北门 37 台拆成 ${wantBatches} 批，每批 ≤ ${TUNING.SCAN_CHUNK}`,
      batchSizes.length === wantBatches && batchSizes.every((n) => n <= TUNING.SCAN_CHUNK),
      batchSizes,
    );
    eq('分批后台数不漏不重（合计 37）', batchSizes.reduce((s, n) => s + n, 0), 37);

    /* 🔴 偏移 0 那一跳带两个区（住宅 + 朝晖，v2.76 重排）：免费版一个账号只有
       5 条 cron，4 跳分区 + 1 跳统计已经用满，加北院只能靠重排分组。
       这里验三件事：两个区都真的刷了、住宅那批带了 src=lvcc、
       朝晖那批仍走住芒（没被住宅的数据源带偏）。 */
    Date.now = () => T0 * 1000; // 北京 08:00
    batchSrcs.length = 0;
    await mod.default.scheduled({ cron: '0-59/5 * * * *' }, env, ctx);
    const chaohui = await readJson(bucket, KEYS.snap('chaohui'));
    const zhu = await readJson(bucket, KEYS.snap('zhu'));
    ok('偏移 0 一跳刷两个区：朝晖', chaohui && chaohui.piles === 36, chaohui && chaohui.piles);
    ok('偏移 0 一跳刷两个区：住宅', zhu && zhu.piles === 8, zhu && zhu.piles);
    ok('住宅那 8 台是带 src=lvcc 发出去的', batchSrcs.includes('lvcc'), batchSrcs);
    ok(
      '朝晖那批仍走住芒（没被住宅的数据源带偏）',
      batchSrcs.filter((s) => s === 'zm').length >= 1,
      batchSrcs,
    );
    /* mock 每台固定 4 个插座 —— 这条只是确认「8 台的数据真的摊进了快照」，
       真实口数（2/10/20 口混装）在线上验收里看。 */
    eq('住宅快照的插座总数 = 8 台 × 4 口', zhu && zhu.total, 32);
    /* 先跑谁：住宅（8 台 1 批）先于朝晖（36 台 3 批），让小区早点落地 ——
       这条断言锁的是「配平顺序」这个意图，不是正确性。 */
    eq('偏移 0 先发住宅、后发朝晖', batchSrcs[0], 'lvcc');

    Date.now = () => (T0 + 120) * 1000; // 北京 08:02，偏移 2 的那一跳
    await mod.default.scheduled({ cron: '2-59/5 * * * *' }, env, ctx);
    eq(
      '偏移 2 → 刷 20号楼 + 物业',
      bucket.businessKeys(),
      ['snap/b20.json', 'snap/beimen.json', 'snap/chaohui.json', 'snap/wuye.json', 'snap/zhu.json'],
    );
    const wuye = await readJson(bucket, KEYS.snap('wuye'));
    eq('偏移 2 里的物业 12 台', wuye && wuye.piles, 12);

    /* 🔴 偏移 3 独占北院 57 台（v2.76）。这是全站最大的一个区 ——
       实测 5 批 5.3 秒，所以它自己占一跳，谁也不和它挤。 */
    Date.now = () => (T0 + 180) * 1000; // 北京 08:03
    batchSizes.length = 0;
    await mod.default.scheduled({ cron: '3-59/5 * * * *' }, env, ctx);
    const beiyuan = await readJson(bucket, KEYS.snap('beiyuan'));
    eq('偏移 3 → 刷北院 57 台', beiyuan && beiyuan.piles, 57);
    eq('北院拆成 5 批', batchSizes.length, Math.ceil(57 / TUNING.SCAN_CHUNK));
    ok(
      '北院每批都 ≤ SCAN_CHUNK',
      batchSizes.every((n) => n <= TUNING.SCAN_CHUNK),
      batchSizes,
    );

    await mod.default.scheduled({ cron: '9-59/5 * * * *' }, env, ctx);
    eq('未知偏移不刷任何区', bucket.businessKeys().length, 6);

    await mod.default.scheduled({ cron: '2 * * * *' }, env, ctx);
    ok('统计 cron 落点', (await readJson(bucket, KEYS.stats())) !== null);

    const headers = { origin: 'https://chd-charge.pages.dev' };
    const r1 = await mod.default.fetch(new Request('https://x/api/snap?area=beimen&refresh=0', { headers }), env);
    const b1 = await r1.json();
    eq('/api/snap 200', r1.status, 200);
    eq('允许站点来源跨源读取', r1.headers.get('access-control-allow-origin'), 'https://chd-charge.pages.dev');
    /* 响应会被 CDN 缓存 60 秒，前端必须能用 `age + Age 头` 算出真实年龄。
       Age 不在 CORS 安全列表里 —— 不显式暴露的话浏览器读不到，前端算不了。 */
    ok(
      '暴露 Age 头（否则前端算不出真实年龄）',
      String(r1.headers.get('access-control-expose-headers') || '').includes('Age'),
      r1.headers.get('access-control-expose-headers'),
    );
    eq('refresh=0 不触发补扫', b1.refreshed, false);
    eq('返回快照', b1.snapshot.piles, 37);

    const r2 = await mod.default.fetch(new Request('https://x/api/snap?area=nope'), env);
    eq('未知分区 400', r2.status, 400);

    const r3 = await mod.default.fetch(new Request('https://x/api/snap?area=all', { headers }), env);
    const b3 = await r3.json();
    eq('/api/snap?area=all 汇总', b3.summary.areas, 6);
    eq('总览不传 refresh 时没有提示', b3.refresh_ignored, null);
    ok('总览会指认最旧的那个区', typeof b3.oldest_key === 'string', b3.oldest_key);

    /* 总览页如果传 refresh=1 必须被告知「没刷」—— 否则它会永远停在旧数据上。
       四个区串行最坏 72 秒，超过 Workers 的 30 秒 wall-clock，所以这条不能支持。 */
    const scansBeforeAll = scanner.count;
    const r3b = await mod.default.fetch(
      new Request('https://x/api/snap?area=all&refresh=1', { headers }),
      env,
    );
    const b3b = await r3b.json();
    eq('总览收到 refresh=1 时明确告知不支持', b3b.refresh_ignored, 'area=all_not_supported');
    eq('总览收到 refresh=1 也不打上游', scanner.count, scansBeforeAll);

    const r4 = await mod.default.fetch(new Request('https://x/api/health'), env);
    eq('/api/health 200', r4.status, 200);

    const r5 = await mod.default.fetch(new Request('https://x/api/nothing'), env);
    eq('未知路由 404', r5.status, 404);

    /* force=1 是「推完新凭证立刻验一次」的运维后门，必须持密钥才能用，
       否则等于给所有人一个绕过节流打爆上游的按钮。 */
    const r6 = await mod.default.fetch(
      new Request('https://x/api/snap?area=beimen&refresh=1&force=1'),
      env,
    );
    eq('公开请求的 force=1 被忽略', (await r6.json()).forced, false);

    const r7 = await mod.default.fetch(
      new Request('https://x/api/snap?area=beimen&refresh=1&force=1', {
        headers: { 'x-snap-key': 'k' },
      }),
      env,
    );
    eq('带内部密钥的 force=1 生效', (await r7.json()).forced, true);

    const r8 = await mod.default.fetch(
      new Request('https://x/api/snap?area=beimen&refresh=1&force=1', {
        headers: { 'x-snap-key': 'wrong' },
      }),
      env,
    );
    eq('密钥不对同样忽略', (await r8.json()).forced, false);

    /* 多部署互斥：第二份部署必须设 DISABLE_CRON=1，否则两边 cron 同时跑、
       锁在各自桶里互相看不见 → 峰值回到 109 台/分（速率审计 S7 实测）。 */
    const beforeDisabled = scanner.count;
    await mod.default.scheduled(
      { cron: '0-59/5 * * * *' },
      { ...env, DISABLE_CRON: '1' },
      ctx,
    );
    eq('DISABLE_CRON=1 时 cron 不打上游', scanner.count, beforeDisabled);

    const rHealth = await mod.default.fetch(new Request('https://x/api/health'), env);
    const hHealth = await rHealth.json();
    eq('健康检查里能看到 cron 被禁用', hHealth.config.cron_disabled, false);
    ok(
      '/api/health 暴露写入闸门状态',
      hHealth.write_guard && hHealth.write_guard.enabled === true && typeof hHealth.write_guard.attempts === 'number',
      hHealth.write_guard,
    );

    /* 🔴 部署漏配 SNAP_KEY：站点会回 403，而 403 在 core 里被归类成 auth
       → 连续 3 次后退避 6 小时 → 整站停更半天，日志还写着「凭证失效」。
       所以缺密钥时必须**根本不跑**，绝不留下一个假的 auth 退避。 */
    const noKeyEnv = { SNAP: bucket, PILE_ORIGIN: 'https://example.test' };
    const scansBeforeNoKey = scanner.count;
    const snapBeforeNoKey = await readJson(bucket, KEYS.snap('beimen'));
    await mod.default.scheduled({ cron: '1-59/5 * * * *' }, noKeyEnv, ctx);
    eq('缺 SNAP_KEY 时 cron 不打上游', scanner.count, scansBeforeNoKey);
    const snapAfterNoKey = await readJson(bucket, KEYS.snap('beimen'));
    eq('缺 SNAP_KEY 时不改写快照', snapAfterNoKey.at, snapBeforeNoKey.at);
    eq('缺 SNAP_KEY 时不留下假退避', snapAfterNoKey.retryAfter, snapBeforeNoKey.retryAfter);

    const rNoKey = await mod.default.fetch(
      new Request('https://x/api/snap?area=beimen&refresh=1'),
      noKeyEnv,
    );
    const bNoKey = await rNoKey.json();
    eq('缺 SNAP_KEY 时响应里点明原因', bNoKey.config_error, 'snap_key_missing');
    eq('缺 SNAP_KEY 时仍然能读到旧快照', bNoKey.snapshot.piles, 37);
    eq('缺 SNAP_KEY 时不补刷', bNoKey.refreshed, false);
    const rHealth2 = await mod.default.fetch(
      new Request('https://x/api/health'),
      { ...env, DISABLE_CRON: '1' },
    );
    eq('另一处部署显示 cron_disabled=true', (await rHealth2.json()).config.cron_disabled, true);

    ok('日志里有 skip / 刷新记录', logs.length > 0, logs.slice(0, 3));
  } finally {
    console.log = realLog;
    console.warn = realWarn;
    Date.now = realNow;
    globalThis.fetch = realFetch;
  }
}

/* ── 12. 写入闸门（把并发风暴压成常数次写） ─────────────────────── */
console.log('\n12. 写入闸门');
{
  const slice = sliceOf(T0);
  const g = new WriteGuard(TUNING);

  eq('第一次放行', g.allow(slice, 'u:beimen').ok, true);
  eq('同片同分区第二次拒绝', g.allow(slice, 'u:beimen').ok, false);
  eq('拒绝原因是 slice', g.allow(slice, 'u:beimen').reason, 'slice');
  eq('同片不同用途放行（cron 不被用户顶掉）', g.allow(slice, 'cron:beimen').ok, true);
  eq('同片不同分区放行', g.allow(slice, 'u:chaohui').ok, true);
  eq('跨片立即恢复', g.allow(slice + 1, 'u:beimen').ok, true);
  eq('放行计数 = 4', g.stats().attempts, 4);
  eq('拦截计数 = 2', g.stats().blocked, 2);
  eq('est_put 按预扣值算', g.stats().est_put, 4 * TUNING.WRITE_COST_PER_ATTEMPT);

  /* 内存不泄漏：isolate 可能活几小时，跑满 200 片后只该留最近那些。 */
  const gLong = new WriteGuard(TUNING);
  for (let i = 0; i < 200; i += 1) gLong.allow(slice + i, 'u:x');
  ok(
    '内存里只留最近 N 片',
    gLong.stats().tracked_slices <= TUNING.WRITE_GUARD_MAX_SLICES,
    gLong.stats().tracked_slices,
  );

  /* 逃生门：关掉闸门必须能用，但也必须明显 —— 关掉之后写入量不再有上界。 */
  const gOff = new WriteGuard({ ...TUNING, WRITE_GUARD_ENABLED: false });
  eq('关掉闸门后第一次放行', gOff.allow(slice, 'u:x').ok, true);
  eq('关掉闸门后重复也放行（这正是危险之处）', gOff.allow(slice, 'u:x').ok, true);

  /* 真场景：快照超龄 + 100 个人同时打开同一个区。
     没有闸门时，每个请求都要写「全站锁 + 分区锁」两次注定失败的 412。 */
  const bucket = createBucket();
  const clock = createClock(T0);
  const scanner = createScanner();
  const area = AREAS[0];
  const guard = new WriteGuard(TUNING);

  await refreshArea({
    bucket,
    area,
    now: clock.now,
    scanBatch: asBatch(scanner),
    useGlobalLock: false,
  });
  clock.tick(TUNING.THROTTLE_S + 60); // 让快照超龄，每个请求都想补刷
  bucket.resetPuts();
  const beforeScans = scanner.count;

  const rs = await Promise.all(
    Array.from({ length: 100 }, () =>
      snapFor({ bucket, area, now: clock.now, wantRefresh: true, scanBatch: asBatch(scanner), guard }),
    ),
  );

  eq('100 并发只有 1 个真刷', rs.filter((r) => r.refreshed).length, 1);
  eq('其余 99 个被闸门挡下', rs.filter((r) => r.rate_limited).length, 99);
  eq(
    '被挡的请求全部标 blocked_by=rate_limited',
    rs.filter((r) => r.blocked_by === 'rate_limited').length,
    99,
  );
  ok(
    '被挡时不置 refreshing（否则前端 3 秒重拉会放大三倍）',
    rs.filter((r) => r.rate_limited).every((r) => r.refreshing === false),
  );
  ok(
    '被挡时 throttled=true（前端照旧数据展示，不转圈）',
    rs.filter((r) => r.rate_limited).every((r) => r.throttled === true),
  );
  /* 🔴 这条是整个闸门存在的理由：100 个并发 = 3 次写，而不是 3 + 99×2 次。 */
  eq('100 并发的写入次数 = 3（全站锁 + 分区锁 + 快照）', bucket.putCount, 3);
  eq('上游只被打了一轮', scanner.count - beforeScans, area.count);

  /* 下一个时间片必须立刻恢复 —— 闸门只压并发，不能让站点停更。 */
  clock.tick(TUNING.LOCK_SLICE_S + 1);
  const nxt = await snapFor({
    bucket,
    area,
    now: clock.now,
    wantRefresh: true,
    scanBatch: asBatch(scanner),
    guard,
  });
  eq('跨片后恢复补刷', nxt.refreshed, true);
  eq('跨片后不再标 rate_limited', nxt.rate_limited, false);

  /* force 是持密钥的运维动作，必须能连点四个区 —— 不能被闸门挡。 */
  const fBucket = createBucket();
  const fClock = createClock(T0);
  const fGuard = new WriteGuard(TUNING);
  await refreshArea({
    bucket: fBucket,
    area,
    now: fClock.now,
    scanBatch: asBatch(scanner),
    useGlobalLock: false,
    guard: fGuard,
  });
  const forced = await snapFor({
    bucket: fBucket,
    area,
    now: fClock.now,
    wantRefresh: true,
    scanBatch: asBatch(scanner),
    guard: fGuard,
    force: true,
  });
  eq('force 绕过节流/锁/闸门', forced.refreshed, true);
  eq('force 也不会被标成 rate_limited', forced.rate_limited, false);
}

/* ── 13. 在飞重叠（锁是按片切的，扫描是跨片跑的） ────────────────── */
console.log('\n13. 跨片在飞');
{
  const bucket = createBucket();
  const area = AREAS[0];
  const slice = sliceOf(T0);

  eq('上一片没有锁 → 不在飞', await inflightRecently(bucket, area.key, T0), false);

  /* 上一片的锁里存的是那一轮的起始时间戳（这不是新加的字段，本来就存着）。
     注意：T0 正好落在一片的第一秒，所以「上一片」= slice-1。 */
  await bucket.put(KEYS.lock(area.key, slice - 1), String(T0));

  eq('上一片 5 秒前起跑 → 判定在飞', await inflightRecently(bucket, area.key, T0 + 5), true);
  eq('上一片 30 秒前起跑 → 判定已结束', await inflightRecently(bucket, area.key, T0 + 30), false);

  /* 时钟回拨：锁里的时间戳在未来，别当成「刚起跑」把站点永久锁死 */
  await bucket.put(KEYS.lock(area.key, slice - 1), String(T0 + 9999));
  eq('锁时间戳在未来 → 放行', await inflightRecently(bucket, area.key, T0), false);

  /* 内容坏掉 / 读异常都必须放行：一次 R2 抖动不该让整个区停更 */
  await bucket.put(KEYS.lock(area.key, slice - 1), 'not-a-number');
  eq('锁内容不是数字 → 放行', await inflightRecently(bucket, area.key, T0), false);

  const brokenBucket = {
    async get() {
      throw new Error('模拟 R2 500');
    },
  };
  eq('R2 读失败 → 放行（不因抖动停更）', await inflightRecently(brokenBucket, area.key, T0), false);

  /* 端到端：真的在飞时，refreshArea 必须**零写入**地跳过 */
  const b2 = createBucket();
  const clock = createClock(T0);
  await b2.put(KEYS.lock(area.key, sliceOf(T0) - 1), String(T0 - 2));
  b2.resetPuts();
  const r = await refreshArea({
    bucket: b2,
    area,
    now: clock.now,
    scanBatch: asBatch(createScanner()),
    useGlobalLock: false,
  });
  eq('在飞时返回 reason=inflight', r.reason, 'inflight');
  eq('在飞时一次 put 都没发生', b2.putCount, 0);

  /* force 是运维动作，必须在飞也能插进去 */
  const clock2 = createClock(T0);
  const forced = await refreshArea({
    bucket: b2,
    area,
    now: clock2.now,
    scanBatch: asBatch(createScanner()),
    useGlobalLock: false,
    ignoreFreshness: true,
    skipAreaLock: true,
  });
  ok('force 能越过在飞判断', forced.locked === true && forced.skipped === undefined, forced.reason);
}

/* ── cron 可靠性：投递延迟不丢跳 + 丢跳能补跑 ──────────────────────
 * CF 的 Cron Triggers **不重试、不告警**（官方文档与合作方实测一致）：
 * 一次触发丢了就只是丢了。而 shouldRunAt 是「分钟取模」式判定，原来拿
 * Date.now()（实际醒来时刻）去算，迟几秒跨过分钟边界就会被判成不该跑。
 * 深夜 60 分钟档每区每小时只有一次机会 —— 那一区的数据会静默老化到 2 小时。
 * 这里把两件事都钉住。 */
console.log('\n# cron 可靠性');
{
  /* catchupNeeded 是纯函数，先单测它的边界 */
  ok('年龄刚到间隔不算丢跳（留 120 秒余量）', catchupNeeded(3600 + 60, 3600) === false);
  ok('深夜档丢一跳（65 分钟）→ 判为需补跑', catchupNeeded(3900, 3600) === true);
  ok('从没成功过（Infinity）→ 不补跑（那是首次部署，交给正常那一跳）',
    catchupNeeded(Infinity, 3600) === false);
  ok('年龄非法（NaN / null）→ 不补跑', catchupNeeded(NaN, 3600) === false && catchupNeeded(null, 3600) === false);
  ok('间隔非法 → 不补跑', catchupNeeded(99999, 0) === false);
  ok(
    '闸门关闭后永不补跑',
    catchupNeeded(99999, 3600, { ...TUNING, CRON_CATCHUP_ENABLED: false }) === false,
  );
  ok('高峰 5 分钟档：正常间隔不会误判（300s < 420s）', catchupNeeded(300, 300) === false);
  ok('高峰 5 分钟档：丢一跳（600s）会被补上', catchupNeeded(600, 300) === true);

  /* 端到端：真跑 worker.scheduled，喂 CF 会给的 scheduledTime */
  const realNow = Date.now;
  const realLog = console.log;
  const realWarn = console.warn;
  const realErr = console.error;
  const logs = [];
  try {
    const b = createBucket();
    const scanner = createScanner();
    console.log = (...a) => logs.push(a.join(' '));
    console.warn = (...a) => logs.push('WARN ' + a.join(' '));
    console.error = (...a) => logs.push('ERR ' + a.join(' '));
    globalThis.fetch = async (url, opts) => {
      const body = JSON.parse(opts.body);
      const results = {};
      for (const id of body.ids) results[id] = { ports: (await scanner.scanOne(id)).ports };
      return new Response(JSON.stringify({ ok: true, results }), {
        status: 200,
        headers: { 'content-type': 'application/json' },
      });
    };

    const mod = await import('./worker.mjs');
    const env = { SNAP: b, PILE_ORIGIN: 'https://example.test', SNAP_KEY: 'k' };
    const ctx = { waitUntil() {} };
    /* 北京 03:00 = UTC 前一日 19:00。周二 03 点档是 60 分钟一轮 */
    const slotSec = T0 - 5 * 3600 + 60; // 北京 03:01（偏移 1 的那一跳）

    /* ① 投递迟了 65 秒：计划 03:01，实际醒来已是 03:02:05 */
    Date.now = () => (slotSec + 65) * 1000;
    await mod.default.scheduled(
      { cron: '1-59/5 * * * *', scheduledTime: slotSec * 1000 },
      env,
      ctx,
    );
    const first = await readJson(b, KEYS.snap('beimen'));
    ok('投递迟了 65 秒仍然照跑（按计划时刻判定，不被 CALENDAR 抖动坑掉）', !!first, first && first.at);

    /* ② 下一次 cron（03:06）不该它跑，且数据才新 → 跳过，不触发补跑 */
    Date.now = () => (slotSec + 300) * 1000;
    scanner.reset();
    await mod.default.scheduled(
      { cron: '1-59/5 * * * *', scheduledTime: (slotSec + 300) * 1000 },
      env,
      ctx,
    );
    eq('数据还新时不补跑（没有 N+1 次无效扫描）', scanner.count, 0);

    /* ③ 模拟「上一跳丢了」：跳到 04:06，快照还停在 03:02:05（65 分钟前） */
    Date.now = () => (slotSec + 3900) * 1000;
    scanner.reset();
    await mod.default.scheduled(
      { cron: '1-59/5 * * * *', scheduledTime: (slotSec + 3900) * 1000 },
      env,
      ctx,
    );
    ok('丢跳后下一次 cron 会补跑', scanner.count === 37, scanner.count);
    ok(
      '补跑会留下 WARN 日志（不是静默）',
      logs.some((l) => l.includes('catch-up') && l.includes('beimen')),
      logs.filter((l) => l.includes('catch-up')).slice(0, 2),
    );

    /* ④ 补跑之后不该连环补：紧跟的下一跳必须安静跳过 */
    scanner.reset();
    Date.now = () => (slotSec + 3900 + 300) * 1000;
    await mod.default.scheduled(
      { cron: '1-59/5 * * * *', scheduledTime: (slotSec + 3900 + 300) * 1000 },
      env,
      ctx,
    );
    eq('补跑过后不会连环补跑', scanner.count, 0);
  } finally {
    Date.now = realNow;
    console.log = realLog;
    console.warn = realWarn;
    console.error = realErr;
  }
  /* try 期间接管了 console，段内的断言输出被吞了 —— 这里补打印出来，
     否则「通过 190 条」里看不见 cron 那几条到底验了什么。 */
  for (const l of logs) if (l.startsWith('[') || l.includes('catch-up')) realLog(l);
}

console.log(`\n${fail === 0 ? '[PASS]' : '[FAIL]'} ${pass} 通过 / ${fail} 失败`);
if (fail) {
  console.log('失败项：\n  - ' + fails.join('\n  - '));
  process.exit(1);
}

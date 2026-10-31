/**
 * 额度审计：用真实代码路径跑满 24 小时，数清每一次 R2 读写和上游请求。
 *
 * 不靠估算 —— 直接 import 真正的 core.mjs / worker.mjs，喂一份假 R2 和假上游，
 * 按 wrangler.toml 里那 5 条 cron 逐分钟敲门，再叠加用户访问，最后对账免费额度。
 *
 *   node audit_quota.mjs            # 跑全部场景
 *   node audit_quota.mjs normal     # 只跑一个场景
 *
 * 判读基准（免费版，2026-10 官方文档）：
 *   Class A  100 万次/月      条件写 412 也算一次（抢锁失败要算钱）
 *   Class B  1000 万次/月
 *   存储     10 GB-month
 */

import { KEYS, snapFor, refreshArea, WriteGuard } from './core.mjs';
import { TUNING } from './config.mjs';
import { createBucket, createClock, createScanner, asBatch } from './mock.mjs';
import { PARTITIONS } from './partitions.mjs';

/* ── 与 wrangler.toml 保持一致 ─────────────────────────────────── */

const CRONS = ['0-59/5 * * * *', '1-59/5 * * * *', '2-59/5 * * * *', '3-59/5 * * * *', '2 * * * *'];

const FREE = {
  classA: 1_000_000, // 次/月
  classB: 10_000_000, // 次/月
  storageGB: 10,
};

/** 2026-10-27 00:00:00 北京时间（周二） */
const T0 = Date.UTC(2026, 9, 26, 16, 0, 0) / 1000;
const DAY = 86_400;

/* ── 工具 ─────────────────────────────────────────────────────── */

/** 确定性的伪随机，保证每次跑结果一致。 */
function lcg(seed) {
  let s = seed >>> 0;
  return () => {
    s = (Math.imul(s, 1664525) + 1013904223) >>> 0;
    return s / 4294967296;
  };
}

function cronMatch(expr, ts) {
  const minute = new Date((ts + 8 * 3600) * 1000).getUTCMinutes();
  const step = /^(\d{1,2})-59\/(\d{1,2})/.exec(expr);
  if (step) return minute % Number(step[2]) === Number(step[1]) % Number(step[2]);
  const fixed = /^(\d{1,2}) \* \* \* \*$/.exec(expr);
  if (fixed) return minute === Number(fixed[1]);
  return false;
}

/** 给 R2 包一层计数器，按 key 前缀分类。 */
function meteredBucket() {
  const base = createBucket();
  const m = {
    get: 0,
    getMiss: 0,
    put: 0,
    putConflict: 0,
    getByKind: {},
    putByKind: {},
  };
  const kind = (k) => (k.startsWith('lock/') ? 'lock' : k.startsWith('snap/') ? 'snap' : 'stats');
  const bump = (o, k) => {
    o[k] = (o[k] || 0) + 1;
  };

  return {
    store: base.store,
    businessKeys: () => base.businessKeys(),
    lockKeys: () => base.lockKeys(),
    stats: m,
    async get(k) {
      m.get += 1;
      bump(m.getByKind, kind(k));
      const r = await base.get(k);
      if (!r) m.getMiss += 1;
      return r;
    },
    async put(k, v, o) {
      m.put += 1;
      bump(m.putByKind, kind(k));
      const r = await base.put(k, v, o);
      // 条件写失败（If-None-Match 冲突）官方明确按 Class A 计费
      if (!r) m.putConflict += 1;
      return r;
    },
  };
}

function fakeUpstream(mode, clock) {
  const st = { requests: 0, ids: 0, byMinute: new Map(), areasPerMinute: new Map(), dupScans: 0 };

  globalThis.fetch = async (url, opts) => {
    const body = JSON.parse(opts.body);
    const ids = body.ids || [];
    st.requests += 1;
    st.ids += ids.length;
    const minute = Math.floor(clock.now() / 60);
    st.byMinute.set(minute, (st.byMinute.get(minute) || 0) + ids.length);

    /* 同一分钟内这个区是不是被扫了第二次？—— 用来验证锁有没有真的挡住重复扫描。
       判定依据：台数相同的批次视作同一个区（36/37/24/12 互不相同）。 */
    const seen = st.areasPerMinute.get(minute) || new Set();
    const tag = ids.length;
    if (seen.has(tag)) st.dupScans += 1;
    else seen.add(tag);
    st.areasPerMinute.set(minute, seen);

    if (mode === 'http500') {
      return new Response('upstream exploded', { status: 500 });
    }

    const results = {};
    for (const id of ids) {
      if (mode === 'auth') {
        results[id] = { error: 'JWT token is missing', auth: true };
        continue;
      }
      if (mode === 'timeout') {
        results[id] = { error: '平台没响应（8 秒超时）' };
        continue;
      }
      // 确定性造点空闲口，别全 0 也别全满
      const seed = [...id].reduce((a, c) => (a * 31 + c.charCodeAt(0)) % 997, 7);
      results[id] = {
        at: clock.now(),
        ports: [1, 2, 3, 4, 5, 6].map((n) => ({ num: n, state: (seed + n) % 3 === 0 ? 0 : 1 })),
      };
    }
    return new Response(JSON.stringify({ ok: true, results }), {
      status: 200,
      headers: { 'content-type': 'application/json' },
    });
  };

  return st;
}

/** 按「每小时权重」生成访问秒数，返回升序数组。 */
function makeVisits(total, seed = 42) {
  const weight = [1, 1, 1, 1, 1, 2, 4, 8, 10, 8, 8, 10, 12, 8, 8, 8, 8, 10, 10, 10, 8, 6, 3, 1];
  const sum = weight.reduce((a, b) => a + b, 0);
  const rnd = lcg(seed);
  const out = [];
  for (let h = 0; h < 24; h++) {
    const n = Math.round((total * weight[h]) / sum);
    for (let i = 0; i < n; i++) out.push(T0 + h * 3600 + Math.floor(rnd() * 3600));
  }
  out.sort((a, b) => a - b);
  return out;
}

/* ── 跑一个场景 ───────────────────────────────────────────────── */

/** 每个场景换一个模块实例，避免模块级 WriteGuard 跨场景串味。 */
let runSeq = 0;

async function runScenario({ name, mode = 'ok', visitsPerDay = 0, concPerVisit = 1 }) {  const realNow = Date.now;
  const realFetch = globalThis.fetch;
  const clock = createClock(T0);
  Date.now = () => clock.now() * 1000;

  const bucket = meteredBucket();
  const upstream = fakeUpstream(mode, clock);
  const visits = makeVisits(visitsPerDay);

  const env = { SNAP: bucket, PILE_ORIGIN: 'https://pile.test', SNAP_KEY: 'k' };
  const ctx = { waitUntil() {} };

  const realLog = console.log;
  const realWarn = console.warn;
  console.log = () => {};
  console.warn = () => {};

  let fetchCalls = 0;
  let lockedOut = 0;

  try {
    /* ⚠️ 加 query 换一个**全新的模块实例**：worker.mjs 里有一个模块级的
       WriteGuard，9 个场景都从同一个 T0 开始跑，共用一份闸门状态会让
       第 2 个场景开始就被上一轮的时间片挡掉（假数据）。query 不同 →
       URL 不同 → Node 视为另一个模块，闸门自然重置。 */
    const mod = await import('./worker.mjs?run=' + runSeq++);

    let vi = 0;
    for (let t = T0; t < T0 + DAY; t++) {
      clock.set(t);

      // cron 只会在整分钟触发
      if (t % 60 === 0) {
        for (const cron of CRONS) {
          if (cronMatch(cron, t)) await mod.default.scheduled({ cron }, env, ctx);
        }
      }

      // 用户访问：同一秒可能有 concPerVisit 个并发（验证锁是否挡住重复扫描）
      let hit = 0;
      while (vi < visits.length && visits[vi] === t) {
        vi += 1;
        hit += 1;
      }
      if (hit > 0) {
        const area = PARTITIONS.areas[(t + hit) % PARTITIONS.areas.length];
        const reqs = Array.from({ length: hit * concPerVisit }, () => {
          fetchCalls += 1;
          return mod.default
            .fetch(new Request(`https://snap.test/api/snap?area=${area.key}&refresh=1`), env)
            .then((r) => r.json());
        });
        const out = await Promise.all(reqs);
        lockedOut += out.filter((x) => x.refreshing).length;
      }
    }
  } finally {
    console.log = realLog;
    console.warn = realWarn;
    globalThis.fetch = realFetch;
    Date.now = realNow;
  }

  const peakMinute = Math.max(0, ...upstream.byMinute.values());
  const busiest = [...upstream.byMinute.entries()].sort((a, b) => b[1] - a[1]).slice(0, 3);

  return {
    name,
    mode,
    visitsPerDay,
    classA: bucket.stats.put,
    classB: bucket.stats.get,
    putConflict: bucket.stats.putConflict,
    putByKind: bucket.stats.putByKind,
    getByKind: bucket.stats.getByKind,
    upstreamIds: upstream.ids,
    upstreamReq: upstream.requests,
    peakMinute,
    busiest,
    dupScans: upstream.dupScans,
    fetchCalls,
    lockedOut,
    businessObjects: bucket.businessKeys().length,
    lockObjects: bucket.lockKeys().length,
    snapBytes: [...bucket.store.entries()]
      .filter(([k]) => k.startsWith('snap/'))
      .reduce((s, [, v]) => s + v.length, 0),
  };
}

/* ── 输出 ─────────────────────────────────────────────────────── */

const pad = (s, n) => String(s).padStart(n);
const pct = (a, b) => ((a / b) * 100).toFixed(2) + '%';

function report(r) {
  const mA = r.classA * 30;
  const mB = r.classB * 30;
  const kind = (o) =>
    Object.entries(o)
      .map(([k, v]) => `${k}:${v}`)
      .join(' ') || '-';

  console.log(`\n── ${r.name} ──`);
  console.log(`  模式 ${r.mode} / 日访问 ${r.visitsPerDay} 次`);
  console.log(`  R2 Class A（写）  ${pad(r.classA, 7)} 次/天   [${kind(r.putByKind)}]  抢锁失败 ${r.putConflict}`);
  console.log(`  R2 Class B（读）  ${pad(r.classB, 7)} 次/天   [${kind(r.getByKind)}]`);
  console.log(
    `  上游扫描          ${pad(r.upstreamIds, 7)} 台/天   请求 ${r.upstreamReq} 次   ` +
      `峰值 ${r.peakMinute} 台/分   同区同分钟重复扫描 ${r.dupScans} 次`,
  );
  console.log(`  Worker 请求       ${pad(r.fetchCalls, 7)} 次/天   其中被锁拦下 ${r.lockedOut}`);
  console.log(`  对象数            业务 ${r.businessObjects} 个 / 锁 ${r.lockObjects} 个   快照合计 ${(r.snapBytes / 1024).toFixed(1)} KB`);
  console.log(
    `  → 月外推  Class A ${pad(mA.toLocaleString(), 10)} / 100 万 (${pct(mA, FREE.classA)})` +
      `   Class B ${pad(mB.toLocaleString(), 10)} / 1000 万 (${pct(mB, FREE.classB)})`,
  );
  console.log(`  → 上游月外推 ${(r.upstreamIds * 30).toLocaleString()} 台`);

  // 30 天不清理锁会怎样
  if (r.lockObjects > 0) {
    console.log(`  → 若不配 lifecycle：锁对象 30 天约 ${(r.lockObjects * 30).toLocaleString()} 个，一年 ${(r.lockObjects * 365).toLocaleString()} 个`);
  }
}

const only = process.argv[2];

const scenarios = [
  { name: 'A0 无人访问（纯 cron 兜底）', mode: 'ok', visitsPerDay: 0 },
  { name: 'A1 日 100 访问', mode: 'ok', visitsPerDay: 100 },
  { name: 'A2 日 300 访问', mode: 'ok', visitsPerDay: 300 },
  { name: 'A3 日 1000 访问', mode: 'ok', visitsPerDay: 1000 },
  { name: 'A4 日 5000 访问', mode: 'ok', visitsPerDay: 5000 },
  { name: 'B1 凭证过期（日 1000 访问）', mode: 'auth', visitsPerDay: 1000 },
  { name: 'B2 平台超时（日 1000 访问）', mode: 'timeout', visitsPerDay: 1000 },
  { name: 'B3 站点接口 500（日 1000 访问）', mode: 'http500', visitsPerDay: 1000 },
  { name: 'C1 并发打开（日 1000，每次 3 人同时）', mode: 'ok', visitsPerDay: 1000, concPerVisit: 3 },
];

const results = [];
for (const s of scenarios) {
  if (only && !s.name.toLowerCase().includes(only.toLowerCase())) continue;
  results.push(await runScenario(s));
}

for (const r of results) report(r);

console.log('\n图例：Class A = 写入 + 抢锁（含失败），Class B = 读取。');

/* ── C2 尖峰写入：闸门到底省了多少 ───────────────────────────────
 *
 * 场景：快照全部超龄（上游刚挂过 / 退避刚到期）的那一秒，200 个请求
 * 同时涌进来、平摊到 4 个区。这正是「写入爆炸」的真实形态 ——
 * 每个请求都去抢锁，抢不到的那 412 也照样记一次 Class A。
 *
 * 结论用于判断 WRITE_GUARD_ENABLED 值不值得开。
 */
async function burstWrites({ guardOn, requests = 200 }) {
  const bucket = createBucket();
  const clock = createClock(T0);
  const scanner = createScanner();
  const guard = guardOn ? new WriteGuard({ ...TUNING, WRITE_GUARD_ENABLED: true }) : null;

  /* 先造一份超龄快照（这一步不计入统计） */
  for (const area of PARTITIONS.areas) {
    await refreshArea({
      bucket,
      area,
      now: clock.now,
      scanBatch: asBatch(scanner),
      useGlobalLock: false,
    });
  }
  clock.tick(TUNING.THROTTLE_S + 60);
  bucket.resetPuts();
  const beforeScans = scanner.count;

  const out = await Promise.all(
    Array.from({ length: requests }, (_, i) =>
      snapFor({
        bucket,
        area: PARTITIONS.areas[i % PARTITIONS.areas.length],
        now: clock.now,
        wantRefresh: true,
        scanBatch: asBatch(scanner),
        guard,
      }),
    ),
  );

  return {
    puts: bucket.putCount,
    refreshed: out.filter((r) => r.refreshed).length,
    rateLimited: out.filter((r) => r.rate_limited).length,
    upstream: scanner.count - beforeScans,
  };
}

if (!only || 'c2'.includes(only.toLowerCase())) {
  const off = await burstWrites({ guardOn: false });
  const on = await burstWrites({ guardOn: true });
  console.log('\n── C2 尖峰写入：同一秒 200 个请求，快照全超龄 ──');
  console.log(`  无闸门   写入 ${pad(off.puts, 4)} 次/秒   真刷 ${off.refreshed}   上游 ${off.upstream} 台`);
  console.log(`  有闸门   写入 ${pad(on.puts, 4)} 次/秒   真刷 ${on.refreshed}   上游 ${on.upstream} 台`);
  console.log(
    `  → 同一秒的写入少 ${((1 - on.puts / off.puts) * 100).toFixed(0)}%，上游量不变（${
      on.upstream === off.upstream ? '闸门不减少有效刷新' : '⚠️ 上游量变了，闸门挡到了真活'
    }）`,
  );
  /* 按「这种尖峰一天来 20 次」外推，看会不会吃掉月额度 */
  const monthOff = off.puts * 20 * 30;
  const monthOn = on.puts * 20 * 30;
  console.log(
    `  → 若一天 20 次这种尖峰：无闸门 ${monthOff.toLocaleString()} / 有闸门 ${monthOn.toLocaleString()} 次/月（额度 100 万）`,
  );
}

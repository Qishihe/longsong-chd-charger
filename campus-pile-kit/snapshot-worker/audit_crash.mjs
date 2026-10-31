/**
 * 崩溃审计：额度审计（audit_quota.mjs）问的是「花得太多吗」，
 * 这里问的是「会不会直接挂」。
 *
 * 手法：把 core.mjs / worker.mjs 原样跑起来，但把 R2 和上游换成
 * 「会坏」的版本 —— 读抛异常、写抛异常、永不 resolve、返回垃圾数据、
 * 对象被写坏。然后观察两件事：
 *
 *   1. cron 抛不抛异常（抛了 = 这一轮彻底没有记录，连「失败」都留不下）
 *   2. /api/snap 返回 200 还是 500（500 = 用户连旧数据都看不到）
 *
 * 用法：node campus-pile-kit/snapshot-worker/audit_crash.mjs
 */

import { TUNING } from './config.mjs';
import { KEYS, refreshArea, snapFor, appendStats } from './core.mjs';
import { PARTITIONS } from './partitions.mjs';

const AREAS = PARTITIONS.areas;
const T0 = Date.UTC(2026, 9, 27, 2, 0, 0) / 1000;

/* ── 可注入故障的 R2 ─────────────────────────────────────────────── */

function fragileBucket({ failGet = null, failPut = null, hangGet = false, hangPut = false } = {}) {
  const store = new Map();
  const log = [];
  const maybeHang = () => new Promise(() => {}); // 永不 resolve

  return {
    store,
    log,
    async get(key) {
      log.push(['get', key]);
      if (hangGet) return maybeHang();
      if (failGet && failGet(key)) throw new Error('R2 get 失败（模拟 500 / 网络中断）');
      const v = store.get(key);
      return v === undefined ? null : { text: async () => v, json: async () => JSON.parse(v) };
    },
    async put(key, value, opts) {
      log.push(['put', key]);
      if (hangPut) return maybeHang();
      if (failPut && failPut(key)) throw new Error('R2 put 失败（模拟配额超限 / 5xx）');
      if (opts && opts.onlyIf) {
        const inm = opts.onlyIf.get ? opts.onlyIf.get('if-none-match') : opts.onlyIf['If-None-Match'];
        if (inm === '*' && store.has(key)) return null;
      }
      store.set(key, String(value));
      return { key };
    },
  };
}

const okScan = async (ids) =>
  ids.map((id) => ({ id, ports: [{ num: 1, state: 0 }, { num: 2, state: 1 }] }));

/* ── 场景执行器 ─────────────────────────────────────────────────── */

const results = [];

async function scenario(name, fn) {
  let outcome;
  try {
    outcome = await fn();
  } catch (err) {
    outcome = { threw: String((err && err.message) || err) };
  }
  results.push({ name, ...outcome });
}

/** 让 worker.fetch 返回 { status, body }，捕获 500。 */
async function callFetch(mod, env, urlStr, headers = {}) {
  const req = new Request(urlStr, { headers });
  const res = await mod.default.fetch(req, env);
  let body = null;
  try {
    body = await res.json();
  } catch {
    body = null;
  }
  return { status: res.status, body };
}

/* ── 主流程 ─────────────────────────────────────────────────────── */

const realNow = Date.now;
const realFetch = globalThis.fetch;
const realLog = console.log;
const realWarn = console.warn;
Date.now = () => T0 * 1000;
console.log = () => {};
console.warn = () => {};

let mod;
try {
  mod = await import('./worker.mjs');
} finally {
  console.log = realLog;
  console.warn = realWarn;
}

const area = AREAS[0];
/** 线上部署一定有 SNAP_KEY —— 没有的话站点会 403，worker 会直接不跑（见 worker.hasSnapKey）。 */
const envOf = (bucket, extra = {}) => ({
  SNAP: bucket,
  PILE_ORIGIN: 'https://x.test',
  SNAP_KEY: 'k',
  ...extra,
});
const ctx = { waitUntil() {} };

/* A. R2 读失败 */
await scenario('A1 快照读失败 → /api/snap', async () => {
  const b = fragileBucket({ failGet: (k) => k.startsWith('snap/') });
  const r = await callFetch(mod, envOf(b), 'https://x/api/snap?area=' + area.key + '&refresh=0');
  return { status: r.status, degraded: r.status === 200 };
});

/* A. 锁写失败 */
await scenario('A2 抢锁写失败 → /api/snap', async () => {
  const b = fragileBucket({ failPut: (k) => k.startsWith('lock/') });
  const r = await callFetch(mod, envOf(b), 'https://x/api/snap?area=' + area.key + '&refresh=1');
  const body = r.body || {};
  /* 三个都要成立：
     ① 不 500（旧数据还在，只是没法更新）
     ② ok 仍为 true —— 快照本身是好的，不该让页面把已有数据扔掉
     ③ refreshing 为 false —— 锁坏了重拉也一样失败，3 秒一次只会变成请求风暴 */
  return {
    status: r.status,
    degraded: r.status === 200 && body.ok === true && body.refreshing === false,
    note: `ok=${body.ok} blocked_by=${body.blocked_by} refreshing=${body.refreshing}`,
  };
});

/* A. 快照写失败 */
await scenario('A3 快照写失败 → /api/snap', async () => {
  const b = fragileBucket({ failPut: (k) => k.startsWith('snap/') });
  const r = await callFetch(mod, envOf(b), 'https://x/api/snap?area=' + area.key + '&refresh=1');
  return { status: r.status, degraded: r.status === 200 };
});

/* A. cron 全挂 */
await scenario('A4 全部 R2 写失败 → cron', async () => {
  const b = fragileBucket({ failPut: () => true });
  await mod.default.scheduled({ cron: '0-59/5 * * * *' }, envOf(b), ctx);
  return { status: 'cron 未抛异常', degraded: true };
});

/* A. R2 hang（永不返回） */
await scenario('A5 R2 读 hang 5 秒 → /api/snap', async () => {
  const b = fragileBucket({ hangGet: true });
  const race = Promise.race([
    callFetch(mod, envOf(b), 'https://x/api/snap?area=' + area.key + '&refresh=0'),
    new Promise((r) => setTimeout(() => r({ status: 'HANG' }), 5000)),
  ]);
  const r = await race;
  return { status: r.status, degraded: r.status === 200 };
});

/* B. 上游 hang */
await scenario('B1 站点接口 hang → cron', async () => {
  const b = fragileBucket();
  globalThis.fetch = () => new Promise(() => {});
  const race = Promise.race([
    mod.default
      .scheduled({ cron: '0-59/5 * * * *' }, envOf(b), ctx)
      .then(() => ({ status: 'cron 返回' })),
    new Promise((r) => setTimeout(() => r({ status: 'HANG >5s' }), 5000)),
  ]);
  globalThis.fetch = realFetch;
  const r = await race;
  return { status: r.status, degraded: r.status === 'cron 返回' };
});

/* B. 上游返回垃圾 */
for (const [label, payload] of [
  ['B2 返回 null', null],
  ['B3 返回字符串', 'oops'],
  ['B4 results 是数组', { ok: true, results: [1, 2] }],
  ['B5 results 缺 id', { ok: true, results: {} }],
  ['B6 ports 是 null', { ok: true, results: { [area.ids[0]]: { ports: null } } }],
]) {
  await scenario(label + ' → cron', async () => {
    const b = fragileBucket();
    globalThis.fetch = async () =>
      new Response(JSON.stringify(payload), {
        status: 200,
        headers: { 'content-type': 'application/json' },
      });
    await mod.default.scheduled({ cron: '0-59/5 * * * *' }, envOf(b), ctx);
    globalThis.fetch = realFetch;
    const snap = b.store.get(KEYS.snap(area.key));
    return {
      status: 'cron 未抛异常',
      degraded: !!snap,
      note: snap ? `快照已写 piles=${JSON.parse(snap).piles}` : '没有写到快照',
    };
  });
  globalThis.fetch = realFetch;
}

/* C. 数据形状被写坏 */
for (const [label, blob] of [
  ['C1 快照不是 JSON', '{not json'],
  ['C2 快照缺 at', JSON.stringify({ piles: 1, total: 2, free: 1 })],
  ['C3 快照 devices 是数组', JSON.stringify({ at: T0, devices: [], total: 0, free: 0 })],
  ['C4 快照是 null 字面量', 'null'],
]) {
  await scenario(label + ' → /api/snap', async () => {
    const b = fragileBucket();
    b.store.set(KEYS.snap(area.key), blob);
    const r = await callFetch(mod, envOf(b), 'https://x/api/snap?area=' + area.key + '&refresh=0');
    const age = r.body && r.body.age;
    return {
      status: r.status,
      degraded: r.status === 200,
      note: Number.isNaN(age) ? '⚠️ age 是 NaN' : `age=${age}`,
    };
  });
}

/* D. 首次部署：空桶 */
for (const [label, url] of [
  ['D1 空桶 → /api/snap', 'https://x/api/snap?area=' + area.key],
  ['D2 空桶 → /api/snap?area=all', 'https://x/api/snap?area=all'],
  ['D3 空桶 → /api/health', 'https://x/api/health'],
  ['D4 空桶 → /api/stats', 'https://x/api/stats'],
]) {
  await scenario(label, async () => {
    const b = fragileBucket();
    const r = await callFetch(mod, envOf(b), url);
    return {
      status: r.status,
      degraded: r.status === 200,
      note: r.body && r.body.snapshot === null ? 'snapshot=null（前端需容错）' : '',
    };
  });
}

/* E. Promise.all 一处失败 */
await scenario('E1 area=all 时一个区读失败', async () => {
  const b = fragileBucket({ failGet: (k) => k.includes(AREAS[1].key) });
  const r = await callFetch(mod, envOf(b), 'https://x/api/snap?area=all');
  return { status: r.status, degraded: r.status === 200 };
});

await scenario('E2 统计时一个区读失败 → cron', async () => {
  const b = fragileBucket({ failGet: (k) => k.includes(AREAS[1].key) });
  b.store.set(KEYS.snap(area.key), JSON.stringify({ at: T0, total: 10, free: 4, used_pct: 60 }));
  await mod.default.scheduled({ cron: '2 * * * *' }, envOf(b), ctx);
  return { status: 'cron 未抛异常', degraded: true };
});

/* F. cron 表达式异常 */
for (const [label, cron] of [
  ['F1 cron 为空', ''],
  ['F2 cron 是统计但时分不对', '7 * * * *'],
  ['F3 偏移超出分区数', '9-59/5 * * * *'],
]) {
  await scenario(label, async () => {
    const b = fragileBucket();
    await mod.default.scheduled({ cron }, envOf(b), ctx);
    return { status: 'cron 未抛异常', degraded: true };
  });
}

/* G. 时间字段 */
await scenario('G1 快照 at 在未来（时钟回拨）', async () => {
  const b = fragileBucket();
  b.store.set(KEYS.snap(area.key), JSON.stringify({ at: T0 + 86400, total: 10, free: 4, used_pct: 60 }));
  const r = await callFetch(mod, envOf(b), 'https://x/api/snap?area=' + area.key + '&refresh=0');
  return { status: r.status, degraded: r.status === 200, note: `age=${r.body && r.body.age}` };
});

/* H. 敏感信息外泄 */
await scenario('H1 上游原文是否进了公开响应', async () => {
  const b = fragileBucket();
  globalThis.fetch = async () =>
    new Response(
      JSON.stringify({
        ok: true,
        results: Object.fromEntries(
          area.ids.map((id) => [id, { at: 0, error: 'JWT token is missing; trace=abc123', auth: true }]),
        ),
      }),
      { status: 200, headers: { 'content-type': 'application/json' } },
    );
  await mod.default.scheduled({ cron: '0-59/5 * * * *' }, envOf(b), ctx);
  globalThis.fetch = realFetch;
  const r = await callFetch(mod, envOf(b), 'https://x/api/snap?area=' + area.key + '&refresh=0');
  const raw = JSON.stringify(r.body || {});
  const leak = /JWT|trace=|token is missing/i.test(raw);
  return { status: r.status, degraded: !leak, note: leak ? '⚠️ 上游原文出现在公开响应里' : '' };
});

/* H. 敏感信息外泄（第二条路径：日志） */
await scenario('H2 上游原文是否进了 Worker 日志', async () => {
  const b = fragileBucket();
  globalThis.fetch = async () =>
    new Response(
      JSON.stringify({
        ok: true,
        results: Object.fromEntries(
          area.ids.map((id) => [
            id,
            { at: 0, error: 'JWT token is missing; trace=abc123; host=10.0.0.5', auth: true },
          ]),
        ),
      }),
      { status: 200, headers: { 'content-type': 'application/json' } },
    );
  /* 捕获 console.warn / console.error，看日志里是否泄漏上游原文 */
  const captured = [];
  const realW = console.warn;
  const realE = console.error;
  console.warn = (...a) => captured.push(a.join(' '));
  console.error = (...a) => captured.push(a.join(' '));
  try {
    await mod.default.scheduled({ cron: '0-59/5 * * * *' }, envOf(b), ctx);
  } finally {
    console.warn = realW;
    console.error = realE;
    globalThis.fetch = realFetch;
  }
  const logText = captured.join('\n');
  /* 上游原文（trace id / 内部地址 / token 提示）不该出现在任何日志里 */
  const leak = /trace=|10\.0\.0|JWT token/i.test(logText);
  return { status: 'cron 未抛异常', degraded: !leak, note: leak ? '⚠️ 上游原文进了日志' : '日志只含归类码' };
});

/* I. 序列化体积与耗时 */
await scenario('I1 快照大小 / 序列化耗时', async () => {
  const b = fragileBucket();
  const big = {
    v: 1,
    at: T0,
    total: 148,
    free: 60,
    used_pct: 59.5,
    devices: Object.fromEntries(
      area.ids.map((id) => [id, { p: '0'.repeat(12), f: 6, n: 12, t: T0 }]),
    ),
  };
  b.store.set(KEYS.snap(area.key), JSON.stringify(big));
  const t = process.hrtime.bigint();
  const r = await callFetch(mod, envOf(b), 'https://x/api/snap?area=all');
  const ms = Number(process.hrtime.bigint() - t) / 1e6;
  const bytes = Buffer.byteLength(JSON.stringify(r.body || {}), 'utf8');
  return {
    status: r.status,
    degraded: ms < 50,
    note: `${bytes} B, ${ms.toFixed(1)} ms（含 4 次假 R2 读）`,
  };
});

/* I2. 真实规模下的 CPU：免费版 Workers 只有 10ms */
await scenario('I2 真实规模 CPU（4 区 109 台）', async () => {
  const b = fragileBucket();
  const mkSnap = (a) => ({
    v: 1,
    area: a.key,
    at: T0,
    total: a.ids.length * 8,
    free: a.ids.length * 3,
    used_pct: 62.5,
    valid: true,
    error: null,
    devices: Object.fromEntries(
      a.ids.map((id) => [id, { p: '0'.repeat(8), f: 3, n: 8, t: T0 }]),
    ),
  });
  for (const a of AREAS) b.store.set(KEYS.snap(a.key), JSON.stringify(mkSnap(a)));

  const t = process.hrtime.bigint();
  const r = await callFetch(mod, envOf(b), 'https://x/api/snap?area=all&refresh=0');
  const ms = Number(process.hrtime.bigint() - t) / 1e6;
  const bytes = Buffer.byteLength(JSON.stringify(r.body || {}), 'utf8');

  /* 统计对象：168 点 × 4 区，是这套系统里最大的一个 JSON */
  const pts = Array.from({ length: 168 }, (_, i) => ({
    h: T0 - (168 - i) * 3600,
    at: T0 - (168 - i) * 3600 + 30,
    areas: Object.fromEntries(AREAS.map((a) => [a.key, { pct: 62.5, free: 20, total: 80, age: 30 }])),
    all: 62.5,
  }));
  b.store.set(KEYS.stats(), JSON.stringify({ v: 1, updated: T0, keep: 168, points: pts }));
  const t2 = process.hrtime.bigint();
  const st = await callFetch(mod, envOf(b), 'https://x/api/stats');
  const ms2 = Number(process.hrtime.bigint() - t2) / 1e6;
  const bytes2 = Buffer.byteLength(JSON.stringify(st.body || {}), 'utf8');

  return {
    status: r.status,
    degraded: ms < 5 && ms2 < 10,
    note: `all: ${(bytes / 1024).toFixed(1)} KB / ${ms.toFixed(1)} ms · ` +
      `stats: ${(bytes2 / 1024).toFixed(0)} KB / ${ms2.toFixed(1)} ms`,
  };
});

/* J. 本次修复点的回归 */
await scenario('J1 不带 refresh 参数不打上游', async () => {
  const b = fragileBucket();
  const before = b.log.filter((x) => x[0] === 'put').length;
  const r = await callFetch(mod, envOf(b), 'https://x/api/snap?area=' + area.key);
  const puts = b.log.filter((x) => x[0] === 'put').length - before;
  return {
    status: r.status,
    degraded: puts === 0 && r.body && r.body.throttled === false,
    note: `未抢锁（put 次数 ${puts}）`,
  };
});

await scenario('J2 超时预算 < cron 30 秒', async () => {
  const worst = TUNING.SCAN_TIMEOUT_MS + TUNING.IO_TIMEOUT_MS * 4;
  return {
    status: worst + ' ms',
    degraded: worst < 28000,
    note: '扫描 18s + 4 次 R2×2s',
  };
});

await scenario('J3 扫描超时会被兜住（200ms 版）', async () => {
  const b = fragileBucket();
  const tuning = { ...TUNING, SCAN_TIMEOUT_MS: 200, IO_TIMEOUT_MS: 200 };
  const t = Date.now();
  const r = await refreshArea({
    bucket: b,
    area,
    now: () => T0,
    scanBatch: () => new Promise(() => {}),
    tuning,
  });
  return {
    status: 'returned',
    degraded: r.locked && r.snap && r.snap.error && r.snap.error.kinds.includes('timeout'),
    note: `kinds=${r.snap && r.snap.error ? r.snap.error.kinds.join(',') : '-'}`,
  };
});

await scenario('J4 首轮全失败 → valid=false（不是「0 台桩」）', async () => {
  const b = fragileBucket();
  globalThis.fetch = async () =>
    new Response(JSON.stringify({ ok: true, results: {} }), {
      status: 200,
      headers: { 'content-type': 'application/json' },
    });
  await mod.default.scheduled({ cron: '0-59/5 * * * *' }, envOf(b), ctx);
  globalThis.fetch = realFetch;
  const snap = JSON.parse(b.store.get(KEYS.snap(area.key)));
  return {
    status: 'piles=' + snap.piles,
    degraded: snap.valid === false && snap.error && snap.error.code === 'upstream',
    note: '前端必须看 valid，不能只看 piles',
  };
});

await scenario('J5 快照与 /api/health 都不含上游原文', async () => {
  const b = fragileBucket();
  globalThis.fetch = async () =>
    new Response(
      JSON.stringify({
        ok: true,
        results: Object.fromEntries(
          area.ids.map((id) => [id, { at: 0, error: 'Authorization: Bearer eyJhbGciOi... 401', auth: true }]),
        ),
      }),
      { status: 200, headers: { 'content-type': 'application/json' } },
    );
  await mod.default.scheduled({ cron: '0-59/5 * * * *' }, envOf(b), ctx);
  globalThis.fetch = realFetch;
  const snapText = b.store.get(KEYS.snap(area.key));
  const h = await callFetch(mod, envOf(b), 'https://x/api/health');
  const leak = /Bearer|eyJhbGci|Authorization/.test(snapText) ||
    /Bearer|eyJhbGci|Authorization/.test(JSON.stringify(h.body || {}));
  return {
    status: h.status,
    degraded: !leak,
    note: leak ? '⚠️ 凭证样式字符串出现在存储或公开响应里' : `kinds=${JSON.parse(snapText).error.kinds}`,
  };
});

Date.now = realNow;
globalThis.fetch = realFetch;

/* ── 报告 ───────────────────────────────────────────────────────── */

const pad = (s, n) => String(s).padEnd(n);
let bad = 0;

console.log('\n════ 崩溃审计 ════════════════════════════════════════════════');
for (const r of results) {
  const mark = r.degraded ? 'OK  ' : 'FAIL';
  if (!r.degraded) bad += 1;
  const note = r.note ? '  ' + r.note : '';
  console.log(`${mark}  ${pad(r.name, 40)} ${pad(r.status, 18)}${note}`);
}
console.log('══════════════════════════════════════════════════════════════');
console.log(`${results.length - bad} 通过 / ${bad} 失败\n`);
process.exit(bad === 0 ? 0 : 1);

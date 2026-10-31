/**
 * v2 快照扫描器（makeScanBatch）2026-10-30 改动的针对性验证：
 *   ① 批间错峰：多批不再同一瞬间打出（第二条 lane 起步晚 SCAN_STAGGER_MS）；
 *   ② 失败补扫：首轮失败的非 auth 台，隔 SCAN_RETRY_GAP_MS 补一发并合并结果；
 *   ③ auth 失败不补（凭证过期重试无意义）；
 *   ④ 时间预算不够时果断收手，不拖过 BUDGET（SCAN_TIMEOUT_MS - 1500）。
 *
 * 跑法：node snapshot-worker/_check_scanbatch.mjs
 */
import { makeScanBatch } from './worker.mjs';
import { TUNING } from './config.mjs';

let failed = 0;
const ok = (name, cond, extra) => {
  console.log((cond ? '  [ok]   ' : '  [FAIL] ') + name + (cond ? '' : '  →  ' + JSON.stringify(extra || '')));
  if (!cond) failed += 1;
};
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/** 假 fetch：可编程每批的返回与延迟，并记录每批的发起时刻。 */
function mockFetch(script) {
  const calls = [];
  globalThis.fetch = async (url, init) => {
    const body = JSON.parse(init.body);
    const started = Date.now();
    const s = script(calls.length, body.ids);
    calls.push({ started, ids: body.ids, plan: s });
    /* 真 fetch 会因 signal 中止（callChunk 按剩余时间设了 AbortSignal.timeout），
       mock 必须同样尊重 —— 否则预算收口那组测的就是假行为。 */
    await new Promise((resolve, reject) => {
      const t = setTimeout(resolve, s.delay);
      if (init && init.signal) {
        init.signal.addEventListener('abort', () => {
          clearTimeout(t);
          const e = new Error('This operation was aborted');
          e.name = 'TimeoutError';
          reject(e);
        }, { once: true });
      }
    });
    const results = {};
    for (const id of body.ids) {
      if (s.fail && s.fail.includes(id)) {
        results[id] = s.authFail && s.authFail.includes(id)
          ? { error: 'JWT token is missing', auth: true }
          : { error: '平台超时' };
      } else {
        results[id] = { ports: [{ state: 0 }] };
      }
    }
    return { ok: true, json: async () => ({ ok: true, results }) };
  };
  return calls;
}

const env = { PILE_ORIGIN: 'https://x.example', SNAP_KEY: 'k' };
const ids37 = Array.from({ length: 37 }, (_, i) => 'D' + String(i + 1).padStart(2, '0'));

/* ── ① 错峰 ── */
{
  const calls = mockFetch(() => ({ delay: 120 }));
  const scan = makeScanBatch(env);
  const t0 = Date.now();
  await scan(ids37);
  const starts = calls.map((c) => c.started - t0).sort((a, b) => a - b);
  const minGap = Math.min(...starts.slice(1).map((s, i) => s - starts[i]));
  ok('37 台切成 3 批', calls.length === 3, calls.length);
  ok('所有批的起步全局错开 ≥ ' + TUNING.SCAN_STAGGER_MS + 'ms（实测最小间隔 ' + minGap + 'ms）',
     minGap >= TUNING.SCAN_STAGGER_MS - 30, starts);
}

/* ── ② 失败补扫 ── */
{
  const badIds = ['D05', 'D06', 'D20', 'D21'];
  let phase = 0;
  const calls = mockFetch((i, ids) => {
    phase = i;
    // 首轮 3 批：第 2 批里 D05/D06 失败、第 3 批 D20/D21 失败；补扫批全成功
    const isRetry = ids.length < 14 && ids.every((id) => badIds.includes(id));
    return { delay: 60, fail: isRetry ? [] : ids.filter((id) => badIds.includes(id)) };
  });
  const scan = makeScanBatch(env);
  const rows = await scan(ids37);
  const errRows = rows.filter((r) => r.error);
  ok('首轮失败的台在补扫后全部拿到数据', errRows.length === 0, errRows);
  ok('补扫只发失败的台（第 4 次调用只含 4 台）',
     calls.length === 4 && calls[3].ids.length === 4 && calls[3].ids.every((id) => badIds.includes(id)),
     calls.map((c) => c.ids.length));
  const gotBad = rows.filter((r) => badIds.includes(r.id)).every((r) => r.ports);
  ok('失败的 4 台结果被合并回原位', gotBad, badIds);
}

/* ── ③ auth 不补 ── */
{
  const calls = mockFetch((i, ids) => ({
    delay: 60,
    fail: ['D02'],
    authFail: ['D02'],
  }));
  const scan = makeScanBatch(env);
  const rows = await scan(ids37.slice(0, 12));          // 12 台单批
  ok('auth 失败的台保留错误', rows.find((r) => r.id === 'D02').auth === true);
  ok('单批 auth 失败不触发补扫（共 1 次调用）', calls.length === 1, calls.length);
}

/* ── ④ 单批失败也补扫（05:00 物业那种） ── */
{
  const calls = mockFetch((i, ids) => ({ delay: 60, fail: i === 0 ? ids.slice(0, 3) : [] }));
  const scan = makeScanBatch(env);
  const rows = await scan(ids37.slice(0, 12));
  ok('单批部分失败 → 补扫后全好（共 2 次调用）',
     calls.length === 2 && rows.every((r) => r.ports), calls.length);
}

/* ── ⑤ 预算收口：补扫不会拖过 BUDGET ── */
{
  const SLOW = 15000;                    // 3 批串到一起必然顶到预算
  const calls = mockFetch(() => ({ delay: SLOW }));
  const scan = makeScanBatch(env);
  const t0 = Date.now();
  const rows = await scan(ids37);
  const cost = Date.now() - t0;
  const budget = TUNING.SCAN_TIMEOUT_MS - 1500;
  ok('整轮耗时 ' + cost + 'ms ≤ 预算 ' + budget + 'ms', cost <= budget + 250, cost);
  ok('没拿到结果的台老实标错（不虚构数据）', rows.filter((r) => r.error).length > 0);
}

console.log(failed ? '\n=== ' + failed + ' 项未过 ===' : '\n=== 全部通过 ===');
process.exit(failed ? 1 : 0);

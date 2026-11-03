/**
 * 用**线上真实快照**验一遍 v2.65 的统计点里有没有「住宅」。
 *
 * 为什么不在页面上等：`/api/stats` 的 cron 是每小时 :05 一跳，接进新分区后
 * 第一个含住宅的点要等整点才出现。干等没有意义，而这个脚本能做到等价的事：
 *   ① 从线上把 5 个分区的真实快照取回来（就是 cron 在 :05 会读的那几份）；
 *   ② 喂给 core.appendStats（线上同一份代码）；
 *   ③ 看它算出来的点里 zhu 有没有 pct、coverage 是不是 5。
 *
 * 用法：node snapshot-worker/_probe_stats_v265.mjs
 */
import { PARTITIONS } from './partitions.mjs';
import { appendStats, KEYS } from './core.mjs';

const ORIGIN = 'https://chd-charge.pages.dev';
const BACKEND = 'https://chd-snap.203147001.workers.dev';

/** 跟线上 D1 同形的「只读桶」：get(key) 返回 { text() }。 */
function bucketFrom(snaps, stats) {
  return {
    async get(key) {
      if (key in snaps) return { text: async () => JSON.stringify(snaps[key]) };
      if (stats.has(key)) return { text: async () => JSON.stringify(stats.get(key)) };
      return null;
    },
    async put() { throw new Error('这个探针不该写任何东西'); },
  };
}

const snaps = {};
for (const a of PARTITIONS.areas) {
  /* 走站点反代（worker.dev 直连在本机被墙）。带随机参数绕开边缘缓存 60 秒。 */
  const url = `${ORIGIN}/api/snap?area=${encodeURIComponent(a.key)}&_t=${Date.now()}${Math.random()}`;
  const r = await fetch(url, { headers: { origin: ORIGIN } });
  const j = await r.json();
  const s = j && j.snapshot;
  if (!s) {
    console.log(`  [x] ${a.key}: 没拿到快照（${j && j.error}）`);
    continue;
  }
  snaps[`snap/${a.key}.json`] = s;
  console.log(`  [ok] ${a.key}: ${s.piles} 台 / ${s.total} 口 / 空闲 ${s.free} / 占用 ${s.used_pct}%`);
}

/* appendStats 会先去读上一份统计再合并 —— 这里给一个空的历史，只看**新算出来的那一个点**。 */
const stats = new Map([[KEYS.stats(), { v: 1, points: [] }]]);
const bucket = bucketFrom(snaps, stats);

const { TUNING } = await import('./config.mjs');
const res = await appendStats({
  bucket,
  areas: PARTITIONS.areas,
  now: () => Math.floor(Date.now() / 1000),
  tuning: TUNING,
});
const point = res.point;

console.log('\n统计点：');
console.log('  h=%s coverage=%s all=%s%%', point.h, point.coverage, point.all);
for (const k of Object.keys(point.areas)) {
  const a = point.areas[k];
  console.log('  %s  pct=%s  %s', k.padEnd(8), a.pct === null ? 'null' : a.pct + '%',
    a.pct === null ? `(${a.reason})` : `${a.free}/${a.total} 空闲 · 快照 ${a.age}s 前`);
}

const zhu = point.areas.zhu;
const problems = [];
if (!zhu) problems.push('点里没有 zhu 这个键');
else {
  if (typeof zhu.pct !== 'number') problems.push(`zhu 的 pct 是 ${zhu.pct}（${zhu.reason}）`);
  if (zhu.pct < 0 || zhu.pct > 100) problems.push(`zhu 的 pct 越界：${zhu.pct}`);
  if (zhu.total !== 104) problems.push(`zhu 的口数应为 104（8 台实测），拿到 ${zhu.total}`);
}
if (point.coverage !== PARTITIONS.areas.length) {
  problems.push(`coverage=${point.coverage}，应该等于分区数 ${PARTITIONS.areas.length}`);
}
if (!(typeof point.all === 'number' && point.all > 0 && point.all < 100)) {
  problems.push(`all=${point.all} 不像一个占用率`);
}

console.log('');
if (problems.length) {
  console.log('[FAIL] ' + problems.join('；'));
  process.exit(1);
}
console.log('[PASS] 统计点里含「住宅」：%s%%，五个区齐全，全站 %s%%', zhu.pct, point.all);

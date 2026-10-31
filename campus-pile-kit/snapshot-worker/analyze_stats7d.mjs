/**
 * 「过去七天各时段占用率」的额度影响分析。
 *
 * 不靠估算：调度轮数直接从 config.mjs 的 SCHEDULE 逐分钟模拟出来，
 * 统计行的字节数用**和 appendStats 完全相同**的 point 结构序列化后实测。
 *
 * 要回答的是四件事：
 *   1. 七天数据现在有没有在攒？（STATS_KEEP = 168 = 24×7）
 *   2. 这一行数据有多大？离 D1 单行 2 MB 上限多远？
 *   3. 如果每次打开页面都读一次，读额度够不够？
 *   4. 换成「更自然」的存法（逐台快照 / 逐区快照 + GROUP BY）会不会爆？
 *      —— 这题的关键从来不是数据量，是**存法**。
 *
 * 跑法：node campus-pile-kit/snapshot-worker/analyze_stats7d.mjs
 */

import { SCHEDULE, TUNING, intervalFor, shouldRunAt, AREA_CRON_MINUTES, STATS_CRON_MINUTE } from './config.mjs';
import { PARTITIONS } from './partitions.mjs';

const AREAS = PARTITIONS.areas;
const DEVICES = PARTITIONS.total;

/* ── 免费额度（2026-10 官方） ─────────────────────────────────── */
const FREE = {
  rowsRead: 5_000_000,     // 行读 / 天
  rowsWritten: 100_000,    // 行写 / 天
  dbBytes: 500 * 1024 * 1024,   // 单库 500 MB
  accountBytes: 5 * 1024 ** 3,  // 账号 5 GB
  rowMax: 2_000_000,       // 单行 / 单值 2 MB
  requests: 100_000,       // Workers 请求 / 天
};
const INDEX_ROWS = 2;      // 审计口径：行写 = 表 1 行 + 索引 1 行

const pad = (s, n) => String(s).padStart(n);
const pct = (v, cap) => ((v / cap) * 100).toFixed(2) + '%';

/* ── 1. 从调度表算出真实的轮数 ─────────────────────────────────── */

/** 逐分钟模拟一整天的 cron，数出每个区被唤醒几轮。 */
function roundsPerDay(dayOffset, label) {
  // 2026-11-02 是周一（dayOffset=0），往后推得周二…周日
  const base = Date.UTC(2026, 10, 2, 0, 0, 0) / 1000 + dayOffset * 86400;
  const perArea = AREAS.map(() => 0);
  for (let m = 0; m < 1440; m += 1) {
    const ts = base + m * 60;
    AREAS.forEach((_, i) => {
      if (shouldRunAt(ts, AREA_CRON_MINUTES[i], SCHEDULE)) perArea[i] += 1;
    });
  }
  const total = perArea.reduce((a, b) => a + b, 0);
  return { label, base, perArea, total };
}

/* 2026-11-02 = 周一（UTC），北京时间也是周一 */
const days = [
  roundsPerDay(0, '周一'),
  roundsPerDay(1, '周二'),
  roundsPerDay(2, '周三'),
  roundsPerDay(3, '周四'),
  roundsPerDay(4, '周五'),
  roundsPerDay(5, '周六'),
  roundsPerDay(6, '周日'),
];
const weekdayTotal = days[0].total;          // 四区合计 456 轮
const weekendTotal = days[5].total;          // 四区合计 288 轮
const weekdayPerArea = days[0].perArea[0];   // 单区 114 轮
const weekendPerArea = days[5].perArea[0];   // 单区 72 轮
const weekTotal = days.reduce((a, d) => a + d.total, 0);

console.log('══ 1. 现有调度：每区每天跑几轮 ══');
console.log('  单区：工作日 ' + weekdayPerArea + ' 轮 / 周末 ' + weekendPerArea + ' 轮');
console.log('  四区合计：工作日 ' + weekdayTotal + ' 轮 / 周末 ' + weekendTotal + ' 轮');
console.log('  全周：' + weekTotal + ' 轮（四区合计）');
console.log('  单区明细：' + days[0].perArea.map((n, i) => AREAS[i].key + '=' + n).join(' '));
/* 🔴 这两个数别混：单区轮数（114）用于算「每台桩一天扫几次」，
   四区合计（456）用于算「一天总共几次扫描」。混用会差 4 倍。 */
console.log('  由此：一天全站扫 ' + (DEVICES * weekdayPerArea).toLocaleString() +
  ' 台次（109 台 × 114 轮）');

/* ── 2. 七天统计行的真实字节数 ─────────────────────────────────── */

/** 完全照抄 core.mjs appendStats 里的 point 结构。 */
function makePoint(hourStart) {
  const per = {};
  AREAS.forEach((a, i) => {
    // 用估算模型的典型值：晚高峰 ~95%，凌晨 ~40%
    const hod = new Date((hourStart + 8 * 3600) * 1000).getUTCHours();
    const p = hod >= 12 && hod <= 22 ? 88 + (i % 4) * 2.5 : 38 + (i % 4) * 3.5;
    per[a.key] = { pct: Math.round(p * 10) / 10, free: 20 + i, total: 361, age: 40 + i * 7 };
  });
  return { h: hourStart, at: hourStart + 300, areas: per, all: 78.4 };
}

function statsBlobBytes(points) {
  return Buffer.byteLength(JSON.stringify({ v: 1, updated: 1793263500, keep: TUNING.STATS_KEEP, points }), 'utf8');
}

const points168 = Array.from({ length: TUNING.STATS_KEEP }, (_, i) =>
  makePoint(1793263200 - (TUNING.STATS_KEEP - 1 - i) * 3600));
const blobBytes = statsBlobBytes(points168);
const perPoint = Math.round(blobBytes / points168.length);

console.log('\n══ 2. 七天统计这一行有多大 ══');
console.log('  STATS_KEEP = ' + TUNING.STATS_KEEP + ' 点（=' + TUNING.STATS_KEEP / 24 + ' 天 × 24 小时）');
console.log('  每个点 ' + perPoint + ' 字节，整行 ' + blobBytes + ' 字节 = ' + (blobBytes / 1024).toFixed(1) + ' KB');
console.log('  占 D1 单行上限 2 MB 的 ' + pct(blobBytes, FREE.rowMax));
console.log('  距 2 MB 上限还能放 ' + Math.floor(FREE.rowMax / perPoint) + ' 个点 = ' +
  (FREE.rowMax / perPoint / 24).toFixed(0) + ' 天（当前只留 7 天，永远碰不到）');

/* ── 3. 加功能之后的增量成本 ───────────────────────────────────── */

const SCENARIOS = [
  { label: '冷清（日 2000 次页面加载）', loads: 2000 },
  { label: '活跃（日 10000 次页面加载）', loads: 10000 },
  { label: '宣传后（日 40000 次页面加载）', loads: 40000 },
];

/* 基线：audit_loop.mjs 实测的正常日 */
const BASE = { rowsRead: 3153, rowsWritten: 4320 };

console.log('\n══ 3. 四种存法的日成本对比 ══');
console.log('  基线（audit_loop 实测正常日）：行读 ' + BASE.rowsRead + ' · 行写 ' + BASE.rowsWritten);

const variants = [];

/* A. 单行 JSON blob（现设计，stats/hourly.json） */
{
  const writes = 24 * INDEX_ROWS;            // 每小时 UPSERT 一次
  variants.push({
    key: 'A',
    name: '单行 JSON blob（现设计）',
    writes,
    readsPerLoad: 1,                          // 按主键点查，1 行
    storageBytes: blobBytes,
    note: '一次 SELECT ... WHERE key=? 取整行',
  });
}

/* B. 分时段聚合表：4 区 × 24 时段 = 96 行，每小时更新当前时段 */
{
  const rows = AREAS.length * 24;
  const writes = AREAS.length * 24 * INDEX_ROWS;   // 只写当前小时那 4 行
  variants.push({
    key: 'B',
    name: '分时段聚合表（96 行）',
    writes,
    readsPerLoad: rows,                       // 要读满 96 行才画得出曲线
    storageBytes: rows * 180,
    note: '每小时只 UPSERT 当前那 4 行',
  });
}

/* C. 逐台原始快照（最直觉、也最贵） */
{
  const rowsPerDay = DEVICES * weekdayPerArea;    // 109 台 × 单区 114 轮 = 12,426 台次
  variants.push({
    key: 'C',
    name: '逐台原始快照（109 台/轮）',
    writes: rowsPerDay * INDEX_ROWS,
    readsPerLoad: 0,                          // 靠预聚合，读时不扫
    storageBytes: rowsPerDay * 7 * 130,
    note: '每天 ' + rowsPerDay.toLocaleString() + ' 行新增',
  });
}

/* D. 逐区原始快照 + 读时 GROUP BY */
{
  const rowsPerDay = AREAS.length * weekdayPerArea;   // 4 区 × 114 轮 = 456 行/天
  const scanRows = rowsPerDay * 7;            // 一次查询扫七天
  variants.push({
    key: 'D',
    name: '逐区原始快照 + GROUP BY',
    writes: rowsPerDay * INDEX_ROWS,
    readsPerLoad: scanRows,
    storageBytes: rowsPerDay * 7 * 150,
    note: '一次查询扫 ' + scanRows.toLocaleString() + ' 行',
  });
}

for (const v of variants) {
  console.log('\n  ── ' + v.key + '. ' + v.name + ' —— ' + v.note);
  console.log('     行写/天：' + pad(v.writes.toLocaleString(), 7) +
    '  (' + pct(v.writes, FREE.rowsWritten) + ' 额度)');
  console.log('     存储：   ' + (v.storageBytes / 1024 / 1024).toFixed(1) + ' MB（7 天窗口，不增长）');
  for (const s of SCENARIOS) {
    const reads = BASE.rowsRead + v.readsPerLoad * s.loads;
    const flag = reads > FREE.rowsRead ? '  🔴 爆' : '';
    console.log('     ' + pad(s.label, 26) + ' 行读 ' + pad(reads.toLocaleString(), 12) +
      '  (' + pct(reads, FREE.rowsRead) + ')' + flag);
  }
}

/* ── 4. 结论 ──────────────────────────────────────────────────── */

const A = variants[0];
console.log('\n══ 4. 结论 ══');
console.log('  现设计（A）每天只多写 ' + A.writes + ' 行 = ' + pct(A.writes, FREE.rowsWritten) + ' 额度；');
console.log('  即使日 4 万次页面加载全部触发统计读取，行读也只有 ' +
  (BASE.rowsRead + A.readsPerLoad * 40000).toLocaleString() +
  ' = ' + pct(BASE.rowsRead + A.readsPerLoad * 40000, FREE.rowsRead) + ' 额度。');
console.log('  存储 ' + (A.storageBytes / 1024).toFixed(0) + ' KB，是单库 500 MB 的 ' +
  pct(A.storageBytes, FREE.dbBytes) + '。');

const C = variants.find((v) => v.key === 'C');
const D = variants.find((v) => v.key === 'D');
console.log('\n  ⚠️ 但换成两种「更自然」的存法就会出事：');
console.log('     C 逐台原始快照 → 行写 ' + C.writes.toLocaleString() + ' = ' +
  pct(C.writes, FREE.rowsWritten) + ' 额度' + (C.writes > FREE.rowsWritten ? '  🔴 当天就停' : '  ⚠️ 只剩零头'));
console.log('     D 逐区快照 + GROUP BY → 单次查询扫 ' + D.readsPerLoad.toLocaleString() +
  ' 行，日 4000 次查询就把 ' +
  pct(D.readsPerLoad * 4000, FREE.rowsRead) + ' 额度吃光');

/* 一个容易被忽略的量：统计 cron 本身的请求数 */
console.log('\n  统计 cron 自身：每小时 1 次 = 24 次/天 请求（Workers 额度 10 万/天，' +
  pct(24, FREE.requests) + '）');

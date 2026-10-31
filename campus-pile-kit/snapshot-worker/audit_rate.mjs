/**
 * 速率审计：前两轮问的是「花得太多吗」（audit_quota）和「会不会挂」
 * （audit_crash）。这一轮问的是第三个问题：
 *
 *   **我们会不会因为打得太密、太集中，被上游屏蔽？**
 *
 * 手法：把 worker.mjs / core.mjs 原样跑起来，用假时钟推演，记录每一次
 * 上游请求的**毫秒级时间戳**，然后按 1 秒 / 10 秒 / 60 秒三个窗口算峰值，
 * 并统计「同一台桩被重复请求」的次数。
 *
 * 对齐的基准（来自 _worker.js 里 2026-10-24 的实测记录）：
 *   · 20 台并发  → 1857ms，20/20 成功
 *   · 30 台并发  → 约 1/3 报「8 秒超时」
 *   · 40 台并发  → 只有 3 台成功，37 台超时
 *   · 109 台/分钟 → 整片 TCP 超时（历史事故）
 *
 * 用法：node campus-pile-kit/snapshot-worker/audit_rate.mjs
 */

import { TUNING, AREA_CRON_MINUTES } from './config.mjs';
import { KEYS, refreshArea, snapFor, readSnap } from './core.mjs';
import { PARTITIONS } from './partitions.mjs';
import { createBucket, createClock, createScanner, asBatch } from './mock.mjs';

const AREAS = PARTITIONS.areas;

/* 事故线：109 台/分钟。所有峰值都以它为分母衡量。 */
const INCIDENT_PER_MIN = 109;
/* 并发线的实测拐点：20 并发开始退化，30 并发 1/3 失败。 */
const CONCURRENCY_KNEE = 20;

/**
 * 记录每一次上游请求的时间戳与台数。
 * mode 控制上游怎么失败 —— 真实平台在限流时返回的不一定是 429，
 * 也可能是 403 / 5xx / 直接超时，所以这几种都要单独测。
 */
function fakeUpstream(clock) {
  const calls = [];          // { t: 秒(浮点), ids, ok }
  const idTimes = new Map(); // id -> [t, t, ...]  用于识别「120 秒内重打同一台」
  let seq = 0;
  /* 可变的模式开关：场景开始时才设定，闭包读的是这个对象。 */
  const cfg = { mode: 'ok', failRatio: 0, recoverAtS: null, startedAt: 0 };

  const api = async (ids) => {
    const t = clock.now();
    seq += 1;
    const n = seq;
    let mode = cfg.mode;
    const failRatio = cfg.failRatio;

    /* 「限流十分钟后自己好了」—— 用来检验退避是不是能自己爬起来，
       而不是一路退到 6 小时。 */
    if (cfg.recoverAtS !== null && t - cfg.startedAt >= cfg.recoverAtS) mode = 'ok';

    let ok = true;
    if (mode === 'timeout') ok = false;
    else if (mode === 'forbidden') ok = false;          // 平台限流常见表现

    /* failRatio 是「一半的**台**失败」，不是「一半的**批次**全失败」。
       两者对退避的影响完全不同：前者走 partial（数据仍可用），
       后者走 allFailed（该退避）。第一版写成了后者，测出来的是另一条路径。 */
    const failIds = new Set();
    if (failRatio > 0 && ok) {
      ids.forEach((id, i) => { if (i % 2 === 0) failIds.add(id); });
    }

    calls.push({
      t,
      ids: ids.length,
      ok: ok && failIds.size === 0,
      idsList: ok ? ids.filter((id) => !failIds.has(id)) : [],
    });
    /* 重复统计算「真正发出去的请求」—— 失败的台也算发了请求。 */
    for (const id of ids) {
      if (!idTimes.has(id)) idTimes.set(id, []);
      idTimes.get(id).push(t);
    }

    if (!ok) {
      return ids.map((id) => ({
        id,
        error:
          mode === 'forbidden'
            ? '平台没响应（HTTP 403）'
            : mode === 'timeout'
              ? '平台没响应（8 秒超时）'
              : '平台没响应',
        /* 关键：403 会被 _worker.js 的 pileScan 判成 auth —— 这是本轮的
           重点怀疑对象，所以这里如实标出来。 */
        auth: mode === 'forbidden',
      }));
    }
    return ids.map((id) => (failIds.has(id)
      ? { id, error: '平台没响应（8 秒超时）', auth: false }
      : { id, ports: idlePorts(id) }));
  };

  return { api, calls, cfg, idTimes, reset: () => { calls.length = 0; seq = 0; idTimes.clear(); } };
}

/** 一台桩 4 个口，按 id 哈希决定空闲数，保证同一 id 每次结果一致。 */
function idlePorts(id) {
  let h = 0;
  for (const ch of id) h = (h * 31 + ch.charCodeAt(0)) % 97;
  return [1, 2, 3, 4].map((num) => ({ num, state: (h + num) % 3 === 0 ? 0 : 1 }));
}

/* ── 峰值统计 ───────────────────────────────────────────────────── */

/** 滑动窗口峰值：任意 windowS 秒内的最大请求台数。 */
function peakInWindow(calls, windowS) {
  if (!calls.length) return 0;
  let best = 0;
  let head = 0;
  let sum = 0;
  for (let i = 0; i < calls.length; i += 1) {
    sum += calls[i].ids;
    while (calls[i].t - calls[head].t >= windowS) {
      sum -= calls[head].ids;
      head += 1;
    }
    if (sum > best) best = sum;
  }
  return best;
}

/** 瞬时并发：同一秒内同时发出的请求数（对应平台「并发」那条线）。 */
function peakConcurrentReqs(calls) {
  const bySec = new Map();
  for (const c of calls) {
    const s = Math.floor(c.t);
    bySec.set(s, (bySec.get(s) || 0) + 1);
  }
  return Math.max(0, ...bySec.values());
}

/**
 * 真正该叫「重复」的东西：同一台桩在**节流窗口内**被打第二次。
 *
 * 第一版我把「同一个 id 在整期运行里出现多次」算成重复，那是错的 ——
 * 每 5 分钟刷一轮，一台桩一天必然被请求几十次，那是按计划刷新，不是浪费。
 * 只有间隔小于 THROTTLE_S（120 秒）的相邻两次，才是「绕过节流的重复」。
 */
function wastefulRepeat(idTimes, minGapS = TUNING.THROTTLE_S) {
  let dup = 0;
  const samples = [];
  for (const [id, ts] of idTimes) {
    for (let i = 1; i < ts.length; i += 1) {
      const gap = ts[i] - ts[i - 1];
      if (gap < minGapS) {
        dup += 1;
        if (samples.length < 5) samples.push({ id, gap, at: ts[i] });
      }
    }
  }
  if (process.env.RATE_DEBUG && samples.length) {
    console.log('   重复样本：', samples.map((s) => `${s.id} 间隔${s.gap}s`).join(' / '));
  }
  return dup;
}

/* ── 跑一个场景 ─────────────────────────────────────────────────── */

/**
 * @param {string} name
 * @param {object} opts
 * @param {number} opts.hours       推演多久
 * @param {string} opts.mode        上游模式
 * @param {number[]} opts.visitHours 哪几个小时有人访问（其余时间只跑 cron）
 * @param {number} opts.visitsPerHour 有人看的那些小时里，每小时几次访问
 * @param {number} opts.concPerVisit 每次访问同时来几个人（各看一个区）
 * @param {number} opts.instances   同时部署了几份（锁不共享 → 危险的重复）
 * @param {number} opts.cronDelayS  cron 触发延迟（秒），模拟平台传播抖动
 */
async function scenario(name, opts = {}) {
  const {
    hours = 24,
    mode = 'ok',
    visitHours = null,
    visitsPerHour = 12,
    concPerVisit = 1,
    instances = 1,
    cronDelayS = 0,
    recoverAfterS = null,
  } = opts;

  const realNow = Date.now;

  /* 每个「部署实例」有自己的桶（锁不共享），但共用同一个上游与同一个时钟。 */
  const buckets = Array.from({ length: instances }, () => createBucket());
  const clock = createClock(Date.UTC(2026, 9, 27, 0, 0, 0) / 1000); // 北京 08:00 周二
  const up = fakeUpstream(clock);
  up.cfg.mode = mode;
  up.cfg.failRatio = mode === 'fail-half' ? 0.5 : 0;
  up.cfg.recoverAtS = recoverAfterS;
  up.cfg.startedAt = clock.now();

  let visits = 0;
  let refreshAttempts = 0;
  /* 停摆度量：每隔 5 分钟采样一次「四区里最老的那份快照有多旧」。
     速率低不代表健康 —— 403 被判成凭证失效时，请求确实很少，
     但整站数据已经停更几小时了。这两个指标必须一起看。 */
  let worstAgeS = 0;
  let blindSamples = 0;   // 采样中「最老那份已超过 STALE_HARD_S」的次数
  let totalSamples = 0;
  /* 上游恢复后，多久快照才重新变新？
     这是「退避会不会退过头」的唯一直接证据。 */
  let recoverLatencyS = null;

  try {
    Date.now = () => clock.now() * 1000;

    const start = clock.now();
    const totalS = hours * 3600;

    /* 每 60 秒推进一步，模拟 cron 与真实访问交错发生。 */
    for (let s = 0; s < totalS; s += 60) {
      const nowTs = start + s;
      clock.set(nowTs);
      const bjHour = ((new Date((nowTs + 8 * 3600) * 1000).getUTCHours()) % 24);

      /* 0) 每 5 分钟采一次健康度。
         ⚠️ 只统计 08:00–23:00：深夜是 60 分钟档，快照年龄本来就会到 3600 秒，
         那是**有意**的低频（前端会显示骨架屏），不是停摆。第一版把深夜也算
         进去，基准场景就报了 13% 「全超龄」，属于指标用错地方。 */
      const inDaytime = bjHour >= 8 && bjHour < 23;
      if (s % 300 === 0 && inDaytime) {
        const ages = await Promise.all(
          AREAS.map(async (a) => {
            const snap = await readSnap(buckets[0], a.key);
            return snap && Number.isFinite(snap.at) ? Math.max(0, clock.now() - snap.at) : Infinity;
          }),
        );
        const oldest = Math.max(...ages.map((x) => (x === Infinity ? 1e9 : x)));
        totalSamples += 1;
        if (oldest > worstAgeS && oldest < 1e9) worstAgeS = oldest;
        if (oldest > TUNING.STALE_HARD_S) blindSamples += 1;
      }

      /* 0b) 上游恢复后多久重新变新。判据：某区快照的 at 已经落到恢复时刻之后。 */
      if (recoverAfterS !== null && recoverLatencyS === null && s >= recoverAfterS) {
        const recoverAt = start + recoverAfterS;
        const newest = await Promise.all(
          AREAS.map(async (a) => {
            const snap = await readSnap(buckets[0], a.key);
            return snap && Number.isFinite(snap.at) ? snap.at : 0;
          }),
        );
        if (newest.some((at) => at >= recoverAt)) recoverLatencyS = s - recoverAfterS;
      }

      /* 1) cron：四条分区 cron 各自在匹配的分钟触发（+ 抖动） */
      for (let i = 0; i < AREA_CRON_MINUTES.length; i += 1) {
        const offset = AREA_CRON_MINUTES[i];
        const minuteOfHour = new Date((nowTs + 8 * 3600) * 1000).getUTCMinutes();
        const intervalMin = Math.max(5, Math.round(
          intervalOfHour(bjHour, nowTs) / 60,
        ));
        if (minuteOfHour % intervalMin !== offset % intervalMin) continue;

        /* 抖动：延迟只会让它在「下一分钟」执行，shouldRunAt 会据此跳过。 */
        clock.set(nowTs + cronDelayS);
        for (const bucket of buckets) {
          await refreshArea({
            bucket,
            area: AREAS[i],
            now: clock.now,
            scanBatch: up.api,
            /* cron 不占全站锁：靠 0/1/2/3 分钟偏移错峰 */
            useGlobalLock: TUNING.CRON_USES_GLOBAL_LOCK,
          });
        }
        clock.set(nowTs);
      }

      /* 2) 访问：有人打开页面，快照超龄就补刷 */
      const live = visitHours === null || visitHours.includes(bjHour);
      if (live) {
        const visitsThisMinute = visitsPerHour / 60;
        for (let v = 0; v < visitsThisMinute; v += 1) {
          visits += 1;
          /* 每次访问同时来 concPerVisit 个不同的人，各看一个区 */
          const jobs = [];
          for (let c = 0; c < concPerVisit; c += 1) {
            const area = AREAS[(visits + c) % AREAS.length];
            const bucket = buckets[(visits + c) % buckets.length];
            jobs.push(
              snapFor({
                bucket,
                area,
                now: clock.now,
                wantRefresh: true,
                scanBatch: up.api,
              }).then((r) => {
                if (r.refreshed) refreshAttempts += 1;
              }),
            );
          }
          await Promise.all(jobs);
        }
      }
    }
  } finally {
    Date.now = realNow;
  }

  const calls = up.calls;
  const totalIds = calls.reduce((s, c) => s + c.ids, 0);

  return {
    name,
    mode,
    instances,
    hours,
    calls: calls.length,
    totalIds,
    peak1s: peakInWindow(calls, 1),
    peak10s: peakInWindow(calls, 10),
    peak60s: peakInWindow(calls, 60),
    peakReqPerSec: peakConcurrentReqs(calls),
    duplicates: wastefulRepeat(up.idTimes),
    visits,
    refreshAttempts,
    avgPerMin: hours > 0 ? totalIds / (hours * 60) : 0,
    worstAgeS,
    blindPct: totalSamples ? Math.round((blindSamples / totalSamples) * 100) : 0,
    recoverLatencyS,
  };
}

/** 该小时的间隔（秒），与 config.intervalFor 同逻辑，这里只需要分钟数。 */
function intervalOfHour(hour, ts) {
  /* 不 import config 的 SCHEDULE 是为了让本脚本能单独说明时段表；
     两边数值必须一致 —— selftest 里有一条断言盯着这件事。 */
  const wd = new Date((ts + 8 * 3600) * 1000).getUTCDay();
  const table = wd === 0 || wd === 6 ? WEEKEND : WEEKDAY;
  return Math.max(5, table[hour] ?? 15) * 60;
}
const WEEKDAY = [60, 60, 60, 60, 60, 60, 30, 15, 5, 15, 15, 15, 5, 15, 15, 15, 15, 5, 5, 15, 15, 5, 15, 30];
const WEEKEND = [60, 60, 60, 60, 60, 60, 60, 15, 15, 15, 15, 15, 15, 15, 15, 15, 15, 15, 15, 15, 15, 15, 15, 60];

/* ── 输出 ───────────────────────────────────────────────────────── */

const pad = (v, n) => String(v).padStart(n);

function judge(r) {
  const flags = [];
  if (r.peak60s > INCIDENT_PER_MIN) flags.push(`🔴 分钟峰值 ${r.peak60s} > 事故线 ${INCIDENT_PER_MIN}`);
  else if (r.peak60s > INCIDENT_PER_MIN * 0.7) flags.push(`⚠️ 分钟峰值 ${r.peak60s} 已达事故线 ${Math.round(r.peak60s / INCIDENT_PER_MIN * 100)}%`);
  if (r.peakReqPerSec > CONCURRENCY_KNEE) flags.push(`🔴 瞬时 ${r.peakReqPerSec} 个请求 > 拐点 ${CONCURRENCY_KNEE}`);
  if (r.duplicates > 0) flags.push(`⚠️ 节流窗口内重复打 ${r.duplicates} 台次`);
  /* 停摆判定：速率合格但数据早就烂了，是最容易漏掉的一种坏法。 */
  if (r.blindPct >= 40) {
    if (r.recoverLatencyS !== null) {
      /* 上游恢复过 —— 那么「多久恢复」才是判据。超过 20 分钟说明退避退过头。 */
      if (r.recoverLatencyS > 1200) flags.push(`🔴 退避过久：上游恢复后 ${Math.round(r.recoverLatencyS / 60)} 分钟才重新更新`);
      else if (r.recoverLatencyS > 600) flags.push(`⚠️ 恢复偏慢：${Math.round(r.recoverLatencyS / 60)} 分钟`);
    } else if (r.mode === 'forbidden' || r.mode === 'timeout') {
      flags.push(`停摆 ${r.blindPct}%（上游整期不可用，属预期行为）`);
    } else {
      flags.push(`🔴 停摆：${r.blindPct}% 的时间四区全超龄（最久 ${Math.round(r.worstAgeS / 60)} 分钟）`);
    }
  } else if (r.blindPct >= 10) {
    flags.push(`⚠️ 长时间无有效数据：${r.blindPct}% 的采样全超龄`);
  }
  return flags.length ? flags.join('；') : 'OK';
}

function show(r) {
  console.log(`\n── ${r.name}`);
  console.log(
    `   上游 ${pad(r.totalIds, 6)} 台/期   请求 ${pad(r.calls, 5)} 次   均值 ${r.avgPerMin.toFixed(1)} 台/分`,
  );
  console.log(
    `   峰值   1 秒 ${pad(r.peak1s, 4)}   10 秒 ${pad(r.peak10s, 4)}   60 秒 ${pad(r.peak60s, 4)} 台   ` +
      `（事故线 ${INCIDENT_PER_MIN}/分）`,
  );
  console.log(
    `   瞬时并发 ${pad(r.peakReqPerSec, 3)} 个请求/秒   节流内重复 ${pad(r.duplicates, 5)} 台次` +
      `   最老快照 ${Math.round(r.worstAgeS / 60)} 分钟   全超龄占比 ${r.blindPct}%` +
      (r.recoverLatencyS !== null ? `   恢复用时 ${Math.round(r.recoverLatencyS / 60)} 分钟` : ''),
  );
  const j = judge(r);
  console.log(`   判定   ${j}`);
  return r;
}

/* ── 主流程 ─────────────────────────────────────────────────────── */

const only = process.argv[2];

const scenarios = [
  {
    key: 's1',
    name: 'S1 基准：只有 cron，没人访问',
    opts: { hours: 24, visitHours: [] },
  },
  {
    key: 's2',
    name: 'S2 有人访问（每小时 20 次）',
    opts: { hours: 24, visitHours: null, visitsPerHour: 20 },
  },
  {
    key: 's3',
    name: 'S3 高峰期 4 人同时打开 4 个区',
    opts: { hours: 6, visitHours: [8, 12, 17, 18, 21, 22], visitsPerHour: 60, concPerVisit: 4 },
  },
  {
    key: 's4',
    name: 'S4 cron 传播延迟 90 秒（模拟平台抖动）',
    opts: { hours: 12, visitHours: [], cronDelayS: 90 },
  },
  {
    key: 's5',
    name: 'S5 上游一半失败（失败不缓存 → 会重打吗）',
    opts: { hours: 12, mode: 'fail-half', visitHours: [8, 12, 17, 18], visitsPerHour: 60 },
  },
  {
    key: 's6',
    name: 'S6 上游一直 403（限流伪装成凭证失效）',
    opts: { hours: 24, mode: 'forbidden', visitHours: null, visitsPerHour: 20 },
  },
  {
    key: 's8',
    name: 'S8 403 持续 3 分钟后自己好了',
    /* 恢复点故意错开退避到期时刻（600 秒），否则测到的是「刚好到期」，
       看不出退避到底拖了多久。 */
    opts: { hours: 12, mode: 'forbidden', recoverAfterS: 180, visitHours: null, visitsPerHour: 20 },
  },
  {
    key: 's7',
    name: 'S7 重复部署两份（锁不共享）',
    opts: { hours: 12, visitHours: null, visitsPerHour: 20, instances: 2 },
  },
];

console.log('速率与风控审计：峰值以「台/分钟」和「请求/秒」两个口径衡量');
console.log(`事故线 ${INCIDENT_PER_MIN} 台/分；并发拐点 ${CONCURRENCY_KNEE} 请求/秒`);

const results = [];
for (const s of scenarios) {
  if (only && s.key !== only) continue;
  results.push(show(await scenario(s.name, s.opts)));
}

/* 汇总 */
console.log('\n════════ 汇总 ════════');
console.log('场景                                     60秒峰值  1秒并发  节流内重复  停摆%   判定');
for (const r of results) {
  const bad = judge(r) !== 'OK' ? '⚠️' : '  ';
  console.log(
    `${bad} ${r.name.padEnd(36)} ${pad(r.peak60s, 7)} ${pad(r.peakReqPerSec, 8)} ${pad(r.duplicates, 11)} ${pad(r.blindPct, 6)}   ${judge(r)}`,
  );
}

/**
 * 快照站核心逻辑（纯函数，不依赖 Cloudflare 运行时）。
 *
 * 依赖注入的三样东西：
 *   bucket    —— R2 绑定（只用到 get / put，put 支持 onlyIf）
 *   scanBatch —— 扫一批桩，返回 [{ id, ports } | { id, error, auth }]（一次请求一批）
 *   now       —— 取当前秒数，测试里可控
 *
 * 设计上刻意不 import 任何 Cloudflare API，这样 selftest.mjs 能用内存 mock
 * 把「锁的原子性 / 固定 key / 节流 / 统计 null」全部跑一遍，不需要账号。
 */

import { TUNING, intervalFor } from './config.mjs';

/* ── key 布局：固定的 5 个业务对象 + 自动过期的锁对象 ─────────────── */

export const KEYS = {
  snap: (areaKey) => `snap/${areaKey}.json`,
  stats: () => 'stats/hourly.json',
  /** 时间片做 key：片号一变 key 就变，旧锁自然失效（R2 没有 TTL，这是替代品）。 */
  lock: (areaKey, slice) => `lock/${areaKey}/${slice}`,
  /** 全站锁：一个时间片内只允许一个分区碰上游（分区锁防不住「四区叠加」）。 */
  gmin: (slice) => `lock/_global/${slice}`,
};

export function sliceOf(ts, tuning = TUNING) {
  return Math.floor(ts / tuning.LOCK_SLICE_S);
}

const r1 = (n) => Math.round(n * 10) / 10;

/**
 * 连续失败后等多久再试。
 *
 * 审计发现的反面案例：凭证过期时快照的 `at` 不再前进，年龄永远超龄，
 * 于是「每次打开页面都补刷一次」全天不停 —— 实测一天白打 29,832 台，
 * 比正常运行时（26,885 台）还多。退避就是给这件事踩刹车。
 */
export function backoffFor(streak, code, tuning = TUNING) {
  if (code === 'auth') {
    /* 阶梯：第一次只退 10 分钟。
     * 原因见 config.AUTH_BACKOFF_S 的注释 —— 403（限流）被标成 auth 时，
     * 一步退到 6 小时会让一次几分钟的限流变成半天停更。 */
    if (streak < tuning.AUTH_CONFIRM_STREAK) return tuning.AUTH_PROBE_BACKOFF_S;
    return tuning.AUTH_BACKOFF_S;
  }
  /* 预算耗尽是我们自己的并发上限，60 秒后自动恢复 —— 别按平台故障退避。 */
  if (code === 'busy') return tuning.BUSY_BACKOFF_S;
  /* partial（部分台失败）**不累加** streak，见 refreshArea 里 failStreak 的算法：
   * 一半失败时数据仍然可用，退到 60 分钟是浪费 —— 审计实测会让 85% 的时间
   * 四区全超龄。所以 partial 只按固定基数短退，5 分钟后再试。 */
  return Math.min(streak * tuning.BACKOFF_BASE_S, tuning.BACKOFF_MAX_S);
}

/* ── 小工具 ─────────────────────────────────────────────────────── */

export async function mapLimit(items, limit, fn) {
  const out = new Array(items.length);
  let cursor = 0;
  const workers = Array.from({ length: Math.min(limit, items.length) }, async () => {
    while (cursor < items.length) {
      const i = cursor++;
      out[i] = await fn(items[i], i);
    }
  });
  await Promise.all(workers);
  return out;
}

/**
 * 给一个 Promise 加超时。
 *
 * 为什么需要：Cloudflare 不会因为某个 I/O 一直不返回就立刻掐断 Worker，
 * 它会等到 wall-clock 上限（cron 30 秒 / 请求 30 秒）才失败。如果没有这一层，
 * 一次 R2 抖动就会让「打开页面」卡满 30 秒然后白屏 —— 而这本来是可以
 * 3 秒内降级返回旧快照的。悬挂的 Promise 在响应发出后由运行时回收。
 */
export function withTimeout(promise, ms, label = 'io') {
  if (!ms || ms <= 0) return promise;
  let timer = null;
  const guard = new Promise((_, reject) => {
    timer = setTimeout(() => {
      const e = new Error(`${label} 超时（${ms}ms）`);
      e.timeout = true;
      reject(e);
    }, ms);
  });
  return Promise.race([promise, guard]).finally(() => clearTimeout(timer));
}

/** R2 读失败要能和「对象不存在」区分开：前者是故障，后者是首次部署。 */
function r2Error(what, cause) {
  const inner = String((cause && cause.message) || cause);
  /* withTimeout 抛出来的消息里已经带了一次描述，别拼成「R2 get 失败：R2 get 超时」。 */
  const e = new Error(inner.startsWith('R2 ') ? inner : 'R2 ' + what + ' 失败：' + inner);
  e.r2 = true;
  e.cause = cause;
  return e;
}

/**
 * @returns {Promise<object|null>} 对象不存在或内容坏掉 → null；
 *          R2 本身失败 → 抛 e.r2 = true 的错误（由调用方决定怎么降级）。
 */
async function readJson(bucket, key, tuning = TUNING) {
  let obj;
  try {
    obj = await withTimeout(bucket.get(key), tuning.IO_TIMEOUT_MS, 'R2 get');
  } catch (err) {
    if (err && err.r2) throw err;
    throw r2Error('get', err);
  }
  if (!obj) return null;
  try {
    return JSON.parse(await obj.text());
  } catch {
    /* 内容坏掉（写了一半 / 版本升级残留）当没有，不要连带整站挂掉 */
    return null;
  }
}

/**
 * 把上游的失败信息归类。
 *
 * 🔴 绝不把上游原文写进快照：`/api/snap` 是公开接口，而上游的报错里
 * 出现过 `JWT token is missing`、trace id、内部地址这类东西。原文只留在
 * Worker 日志（不对外），快照里只放归类码。
 */
export function classifyError(msg) {
  const s = String(msg || '');
  /* 限流/拥塞类：除了精确的 throttled / 限流，还覆盖上游常见的兜底措辞。
     注意「稍后再试」「频繁」「rate limit」「too many」这些词 —— 真实站点
     可能不带 throttled 标志、只在文案里透出信号（见 refreshArea 里
     「结构化信号优先」的注释，标志在的时候根本走不到这里）。 */
  if (/throttl|限流|太多|频繁|稍后再试|稍后重试|忙碌|拥挤|queue|rate.?limit|too many|busy/i.test(s)) {
    return 'throttled';
  }
  if (/超时|timeout|abort|没响应|超时|timed.?out|etimedout/i.test(s)) return 'timeout';
  if (/认证|凭证|授权|token|jwt|unauthor|401|expired/i.test(s)) return 'auth';
  if (/没拿到|没返回|缺|missing/i.test(s)) return 'missing';
  if (/HTTP 5\d\d/.test(s)) return 'http5xx';
  return 'other';
}

/* ── 写入闸门 ───────────────────────────────────────────────────── */

/**
 * 写闸门：把「注定失败的写入」挡在 R2 之前。
 *
 * 为什么需要（前几轮审计漏掉的一半）：R2 的 `If-None-Match: *` 抢锁失败
 * 返回 412，而 **412 也记一次 Class A 写**。所以一片里第 2、3、4…… 个来
 * 抢锁的请求，每一次都花掉一个写额度，却什么都换不来。
 *
 * 什么时候最密集？快照超龄的那段时间 —— 上游挂了、退避刚到期、凭证过期。
 * 那时每个打开页面的人都来抢一次。100 个并发的尖峰 = 100 次白写。
 * 免费额度 100 万次/月，这种尖峰一天几十次就见底了。
 *
 * 判断依据只有一条：`lock/<area>/<slice>` 保证「一片一区最多一轮」，
 * 所以同片同区的第 2 次尝试必然 412 → 直接拒绝，**零 I/O**。
 * 它不限制任何有效刷新，只砍掉确定会失败的写入。
 *
 * 状态放在模块级（isolate 内），跨 isolate 不共享。这不是妥协：
 * 它用 O(1) 的本地判断换掉 O(n) 的无用写入，把「并发风暴」压成常数次写；
 * 跨 isolate 的上界 = 片数 × 用途数 × isolate 数，量级远低于额度。
 */
export class WriteGuard {
  constructor(tuning = TUNING) {
    this.tuning = tuning;
    /** slice -> Map<tag, 本片已放行次数>。Map 保序且片号单调递增，淘汰最老的键即可。 */
    this.slices = new Map();
    this.attempts = 0;
    this.blocked = 0;
  }

  /**
   * @param slice 时间片（sliceOf(ts)）
   * @param tag   用途。调用方传 `${用途}:${区}`，例如 `u:beimen` / `cron:beimen`。
   * @returns {{ok:true} | {ok:false, reason:'slice'}}
   */
  allow(slice, tag) {
    if (!this.tuning.WRITE_GUARD_ENABLED) return { ok: true, bypassed: true };

    let used = this.slices.get(slice);
    if (!used) {
      used = new Map();
      this.slices.set(slice, used);
      /* isolate 可能活几个小时，不清理就是慢速泄漏。片号单调递增，
         所以第一个键就是最早的片。 */
      while (this.slices.size > this.tuning.WRITE_GUARD_MAX_SLICES) {
        this.slices.delete(this.slices.keys().next().value);
      }
    }

    const limit = Math.max(1, this.tuning.WRITE_GUARD_PER_SLICE);
    const seen = used.get(tag) || 0;
    if (seen >= limit) {
      this.blocked += 1;
      return { ok: false, reason: 'slice' };
    }

    used.set(tag, seen + 1);
    this.attempts += 1;
    return { ok: true };
  }

  /** 给 /api/health 看的自检数据。`est_put` 是估算，不是账本。 */
  stats() {
    return {
      enabled: !!this.tuning.WRITE_GUARD_ENABLED,
      per_slice: this.tuning.WRITE_GUARD_PER_SLICE,
      tracked_slices: this.slices.size,
      attempts: this.attempts,
      blocked: this.blocked,
      est_put: this.attempts * this.tuning.WRITE_COST_PER_ATTEMPT,
    };
  }
}

/* ── 原子锁 ─────────────────────────────────────────────────────── */

/**
 * 抢锁。true = 抢到了，这一轮由我跑；false = 别人正在跑，直接复用旧数据。
 *
 * R2 的 `If-None-Match: *` 是原子创建语义：并发请求里最多一个成功，其余拿到
 * null。这是整套方案里唯一不可替代的原语 —— KV 做不到，KV 只能「先读后写」，
 * 两个人会同时读到「没锁」，于是对上游发出双倍请求。
 */
export async function tryLock(bucket, areaKey, ts, tuning = TUNING) {
  const key = KEYS.lock(areaKey, sliceOf(ts, tuning));
  let res;
  try {
    res = await withTimeout(
      bucket.put(key, String(ts), { onlyIf: new Headers({ 'If-None-Match': '*' }) }),
      tuning.IO_TIMEOUT_MS,
      'R2 put(lock)',
    );
  } catch (err) {
    throw r2Error('put(lock)', err);
  }
  return !!res;
}

/**
 * 全站分钟锁：同一时间片内只允许一个分区去碰上游。
 *
 * 为什么分区锁不够：四个区的锁彼此独立。四个人在同一分钟里打开四个不同
 * 分区，四把分区锁全都会成功，于是同时打出 36+37+24+12 = 109 台 ——
 * 正好是历史事故（整片 TCP 超时）那个量级。分区锁防「同区重复」，
 * 防不住「四区叠加」，所以要在外面再套一层。
 *
 * 片宽用 LOCK_SLICE_S（120 秒）而不是 60 秒：审计实测 60 秒片宽下
 * cron 的 37 台 + 用户补刷的 36 台会叠成 73 台/分，仍逼近事故线。
 * 120 秒片宽把上界压到 37 + 37/2 ≈ 55 台/分。
 *
 * 代价：每次补刷多 1 次 Class A。审计实测日 1000 访问时总额度占用
 * 从 6% 涨到 7.4%，仍然安全 —— 用这点额度换掉一个已知事故形态，划算。
 */
export async function tryGlobalLock(bucket, ts, tuning = TUNING) {
  if (!tuning.GLOBAL_LOCK_ENABLED) return true;
  const key = KEYS.gmin(Math.floor(ts / tuning.LOCK_SLICE_S));
  let res;
  try {
    res = await withTimeout(
      bucket.put(key, String(ts), { onlyIf: new Headers({ 'If-None-Match': '*' }) }),
      tuning.IO_TIMEOUT_MS,
      'R2 put(global lock)',
    );
  } catch (err) {
    throw r2Error('put(global lock)', err);
  }
  return !!res;
}

/* ── 读快照 ─────────────────────────────────────────────────────── */

/**
 * 上一轮是不是还在飞。
 *
 * 为什么必须要这一道：锁的 key 带时间片，而扫描会跨片。片宽 120 秒、
 * 一轮 5–18 秒 —— 一轮从第 119 秒开始、第 127 秒结束时，第 120 秒落进新片的
 * 请求会抢到另一个锁，两轮同时打同一个区。时间序审计实测：三个请求跨三片，
 * 能叠成 3 轮并发扫描（上游瞬时 3 倍），而且第二个请求的响应里
 * `refreshed/throttled/refreshing` 全是 false —— 前端完全不知道发生了什么。
 *
 * 实现上不引入新的写入：锁对象里存的内容本来就是那一轮的起始时间戳。
 * 读一次上片的锁，看它离现在多近就够了。
 *
 * 读失败一律**放行**：一次 R2 抖动不该让整个区停更。
 *
 * @returns {Promise<boolean>} true = 上一轮还没跑完，这一轮跳过
 */
export async function inflightRecently(bucket, areaKey, ts, tuning = TUNING) {
  const prevSlice = sliceOf(ts, tuning) - 1;
  let obj;
  try {
    obj = await withTimeout(bucket.get(KEYS.lock(areaKey, prevSlice)), tuning.IO_TIMEOUT_MS, 'R2 get(inflight)');
  } catch {
    return false;
  }
  if (!obj) return false;

  let startedAt;
  try {
    startedAt = Number(await obj.text());
  } catch {
    return false;
  }
  if (!Number.isFinite(startedAt)) return false;

  const age = ts - startedAt;
  /* age < 0 说明锁里的时间戳在未来（时钟回拨），当作异常值放行。 */
  return age >= 0 && age < tuning.INFLIGHT_S;
}

export async function readSnap(bucket, areaKey, tuning = TUNING) {
  return readJson(bucket, KEYS.snap(areaKey), tuning);
}

/* ── 跑一轮：扫一个区，写一个对象 ───────────────────────────────── */

/**
 * @param prevHint 调用方已经读到的上一份快照。传 null 表示「确实没有」，
 *        传 undefined 表示「没读过，你自己读」。让 snapFor 把它读到的
 *        那份传进来，可以省掉一次重复读（审计实测日 1000 访问时省 979 次/天）。
 * @param useGlobalLock 是否参与全站分钟锁。cron 已经用 0/1/2/3 分钟偏移
 *        错峰了，但用户补刷会撞上来，所以默认 true；单测里按需关掉。
 * @param guard 写入闸门（WriteGuard 实例）。传 null 表示不设闸门 ——
 *        只给 force / 单测用；线上两条入口（cron、用户补刷）都必须传。
 * @param guardTag 闸门用途前缀，实际 tag 是 `${guardTag}:${area.key}`。
 * @returns {{locked:false, reason:'global'|'area'|'rate_limited'|'lock_error'}}
 *        | {{locked:true, snap:object, scanned:number, failed:number}}
 */
export async function refreshArea({
  bucket,
  area,
  now,
  scanBatch,
  tuning = TUNING,
  prevHint,
  useGlobalLock = true,
  ignoreBackoff = false,
  /* 绕过「数据够新就别扫」。只有 force 运维动作会用到 —— 见 snapFor。 */
  ignoreFreshness = false,
  /* 绕过分区锁（时间片锁）。force 专用：
   * 运维推完新凭证后要「立刻看到结果」，但很可能正好落在刚扫过的那个
   * 时间片里 —— 那时候被分区锁挡回去，人只会以为 force 没生效。 */
  skipAreaLock = false,
  guard = null,
  guardTag = 'u',
}) {
  const started = now();

  /* 🔴 写闸门必须是第一道，在任何一个 put 之前。
   *
   * 位置很关键：放在抢锁之后等于没放 —— 抢锁本身就是写入（412 也记账），
   * 而这一层要挡的正是「抢锁这个动作被重复太多遍」。
   *
   * 被挡时返回 locked:false + reason:'rate_limited'，和「别人正在刷」同形，
   * 但上层必须区分：这种情况**不能**让前端 3 秒后重拉 —— 重拉还是被挡，
   * 只会把请求量放大三倍。 */
  if (guard) {
    const permit = guard.allow(sliceOf(started, tuning), `${guardTag}:${area.key}`);
    if (!permit.ok) {
      return { locked: false, reason: 'rate_limited', guard: permit };
    }
  }

  /* 第二道：先把上一份快照读出来（**纯读，不写**）。
   *
   * 顺序在这里很关键，比看起来重要：读快照放在抢锁之前，意味着
   * 「退避期」和「数据够新」这两种**最常见的跳过**都发生在任何一次 put 之前。
   * 原来锁在前、读在后，cron 每一跳都要先写两把锁，再发现「哦，数据才 30 秒新」
   * 然后空手而归 —— 额度审计里 A0 场景一天 456 次锁写入，有一半是这么白花的。
   *
   * 读失败不阻止这一轮：最多丢了「全军覆没时沿用旧数据」的能力。 */
  let prev;
  try {
    prev = prevHint === undefined ? await readSnap(bucket, area.key, tuning) : prevHint;
  } catch {
    prev = null;
  }

  /* 退避期：凭证过期或连续失败后，**故意不去打上游**，连锁都不抢。 */
  if (!ignoreBackoff && prev && prev.retryAfter && started < prev.retryAfter) {
    return { locked: true, snap: prev, skipped: 'backoff', scanned: 0, failed: 0 };
  }

  /* 数据够新就别扫。
   *
   * 为什么需要这一道：cron 只检查锁、不看快照年龄。于是「用户在第 4 分钟
   * 补刷过某个区、第 5 分钟的 cron 恰好落到下一个时间片」会连续扫同一个区
   * 两次 —— 速率审计实测间隔只有 60 秒，一天累计 540 台次纯浪费。
   *
   * 充电桩状态在 60 秒内几乎不会变，这两份数据对用户是同一个答案。
   * force=1（推完新凭证立刻验一次）时用 ignoreFreshness 绕过。 */
  if (!ignoreFreshness) {
    const prevAge = prev && Number.isFinite(prev.at) ? started - prev.at : Infinity;
    if (prevAge < tuning.THROTTLE_S) {
      return { locked: true, snap: prev, skipped: 'fresh', prevAge, scanned: 0, failed: 0 };
    }
  }

  /* 第三道：上一轮是不是还在飞（跨时间片的重叠）。
   *
   * 放在「够新」之后是有原因的：锁对象在扫描结束后**不会清除**（R2 没有 TTL，
   * 清了反而要多一次写），所以「刚跑完 15 秒」和「还在跑」在锁上看是同一个样子。
   * 靠「够新」先挡掉前者（快照 age < THROTTLE_S 时根本没有跨片重叠的可能），
   * 这里就只剩下真正还在跑的那一种。见 audit_overlap.mjs。 */
  if (!ignoreFreshness && (await inflightRecently(bucket, area.key, started, tuning))) {
    return { locked: false, reason: 'inflight' };
  }

  /* 锁写失败 ≠ 抢不到锁。前者是 R2 坏了，这时候**绝不能继续扫** ——
     没有锁就扫，等于把「同一时间片只跑一轮」这条唯一的防重保证丢掉。
     所以降级成「这一轮跳过」，由上层决定要不要告诉用户。 */
  try {
    if (useGlobalLock && !(await tryGlobalLock(bucket, started, tuning))) {
      return { locked: false, reason: 'global' };
    }
    if (!skipAreaLock && !(await tryLock(bucket, area.key, started, tuning))) {
      return { locked: false, reason: 'area' };
    }
  } catch (err) {
    return { locked: false, reason: 'lock_error', detail: String((err && err.message) || err) };
  }

  /* scanBatch 直接把现有 /api/pile 的返回透传进来（一次请求扫一整批），
     所以这里不做 per-id 的请求，只在本地归一化。整批失败也不能让
     cron 抛错，否则快照连「失败」都记不下。 */
  let raw = [];
  try {
    raw = await withTimeout(
      /* 第三个参数带数据源（v2.65）：住宅区那 8 台在驴充充平台，站点
         `/api/pile` 要看到 `src: 'lvcc'` 才走那条无鉴权分支。其余分区
         不写 src，等价于原来的两参调用。 */
      scanBatch(area.ids, tuning.SCAN_CONCURRENCY, { src: area.src || 'zm' }),
      tuning.SCAN_TIMEOUT_MS,
      '站点扫描接口',
    );
  } catch (err) {
    const msg = String((err && err.message) || err);
    raw = area.ids.map((id) => ({ id, error: msg, timeout: !!(err && err.timeout) }));
  }

  const byId = new Map();
  for (const r of raw || []) if (r && r.id) byId.set(r.id, r);

  const rows = area.ids.map((id) => {
    const r = byId.get(id);
    if (!r) return { id, ok: false, auth: false, msg: '没拿到结果' };
    if (r.error) {
      return { id, ok: false, auth: !!r.auth, throttled: !!r.throttled, msg: String(r.error) };
    }
    const ports = Array.isArray(r.ports) ? r.ports : [];
    if (!ports.length) return { id, ok: false, auth: false, msg: '平台没返回插座数据' };
    return {
      id,
      ok: true,
      // 0 = 空闲，其余一律记 1 —— 与小程序里「只有 0 才能选」的判定一致
      p: ports.map((x) => (x.state === 0 ? '0' : '1')).join(''),
      f: ports.filter((x) => x.state === 0).length,
      n: ports.length,
    };
  });

  const okRows = rows.filter((r) => r.ok);
  const failed = rows.length - okRows.length;
  const allFailed = okRows.length === 0;
  const anyAuth = rows.some((r) => !r.ok && r.auth);

  const devices = {};
  for (const r of okRows) devices[r.id] = { p: r.p, f: r.f, n: r.n, t: started };

  /**
   * 全军覆没时**不写空数据**：把上一份 devices 原样带上，但 `at` 保持不变。
   * 这样前端算出的年龄会继续变大，能老老实实说「这是 40 分钟前的数据，
   * 因为平台没响应」，而不是把空表当成新的。
   */
  const carry = allFailed && prev && prev.devices ? prev.devices : devices;
  const at = allFailed && prev ? prev.at : started;

  const piles = Object.keys(carry).length;
  const total = Object.values(carry).reduce((s, d) => s + (d.n || 0), 0);
  const free = Object.values(carry).reduce((s, d) => s + (d.f || 0), 0);

  let error = null;
  if (failed > 0) {
    /* 🔴 只记归类码，不记上游原文。
       审计发现：把 `/api/pile` 的 message 原样放进 sample 后，
       `/api/snap` 的公开响应里出现了 `JWT token is missing; trace=abc123`。
       快照是公开可读的，上游报错可能带 token 提示、trace id、内部地址。 */
    const kinds = [
      ...new Set(
        rows
          .filter((r) => !r.ok)
          .map((r) =>
            /* 🔴 结构化信号优先于文案正则。
             *
             * 站点 `/api/pile` 预算耗尽时返回 `{ throttled: true, error: '刚才
             * 查询的人太多了…' }`。如果只靠 classifyError 去正则匹配文案里的
             * 「太多」两个字，一旦站点改了文案（改成「请稍后再试」「排队中」），
             * 分类就静默失效 —— allBusy 判错，把 60 秒的限流当 upstream 退避 5 分钟。
             *
             * 这里既然拿到了明确的 throttled 布尔标志，就该优先信它，文案正则
             * 只当兜底（用于那些不返回标志、只在文案里透出信号的上游）。 */
            r.throttled ? 'throttled' : classifyError(r.msg),
          ),
      ),
    ].sort();
    /* 整批都被我们自己人的流量挤掉（/api/pile 的 240 台/分预算），
       和「平台挂了」完全是两件事：前者 60 秒后自动恢复，后者要退避。 */
    const allBusy = allFailed && kinds.length === 1 && kinds[0] === 'throttled';
    error = {
      // auth = 凭证过期，重试无意义；upstream = 平台没响应，可以退避再试
      code: anyAuth ? 'auth' : allBusy ? 'busy' : allFailed ? 'upstream' : 'partial',
      since: prev && prev.error ? prev.error.since : started,
      failed,
      kinds,
    };
    /* 🔴 日志里也只打印归类码，不打印 msg 原文。
     *
     * 上一版这里还带一个「样例」，本意是排障。但 `rec.error` 是上游原文，
     * 可能带 trace id、内部地址、token 提示 —— 这些本就不该有任何一份
     * 副本，哪怕只留在「运维可见」的日志里。审计发现快照已经只存 kinds，
     * 唯独日志这一环还漏着原文。排障看 kinds 足够：auth / timeout /
     * throttled 已经把「凭证过期 / 平台慢 / 被限流」区分开了。 */
    console.warn(
      `[snap] area=${area.key} ${failed}/${rows.length} 台失败 kinds=${kinds.join(',')}`,
    );
  }

  const interval = intervalFor(started, tuning.schedule);

  /* 连续失败计数与退避时刻。成功一次就清零 —— 退避只为「一直坏」服务，
     偶尔抖一下不该把下一次刷新推到一小时以后。

     partial（有成功也有失败）**不累加**：数据本身仍然可用，按 5 分钟重试
     就够了。累加的后果是「一半台失败」这种常见抖动会一路退到 60 分钟，
     速率审计实测那是 85% 的时间四区全超龄 —— 为了保护一半的数据，
     把另一半也一起停掉，不划算。 */
  const partialOnly = failed > 0 && !allFailed;
  /* busy（被自己人的预算挤掉）同样不累加：那是 60 秒就过去的拥塞，
     跟「平台一直坏」不是一回事，累加会把它升级成几分钟的停更。 */
  const busyOnly = !!error && error.code === 'busy';
  const prevStreak = (prev && prev.failStreak) || 0;
  const failStreak = failed > 0 ? (partialOnly || busyOnly ? prevStreak : prevStreak + 1) : 0;
  /* partial 用固定的 1 倍基数退避，不随 streak 增长。 */
  const backoffCode = error ? error.code : 'upstream';
  /* busy 单独处理：它不累加 streak，所以走不到下面的分支，
     但「60 秒后预算重置再试」这个意图必须显式表达出来。 */
  let retryAfter = 0;
  if (busyOnly) {
    retryAfter = started + tuning.BUSY_BACKOFF_S;
  } else if (failStreak > 0) {
    retryAfter = started + (partialOnly
      ? tuning.BACKOFF_BASE_S
      : backoffFor(failStreak, backoffCode, tuning));
  }

  const snap = {
    v: 1,
    area: area.key,
    name: area.name,
    location: area.location,
    at,
    started,
    elapsed: now() - started,
    interval,
    next: started + interval,
    piles,
    total,
    free,
    used_pct: total ? r1(((total - free) / total) * 100) : null,
    checked: okRows.length,
    failed,
    failStreak,
    retryAfter,
    /**
     * 这份快照是否代表一次**成功的观测**。
     *
     * 首次部署时如果上游正好挂了，会写出一份 piles=0 的快照 —— 前端只数
     * 台数就会显示「本校共 0 台充电桩」。有了这个字段，页面就能区分
     * 「真的没有桩」和「这一轮没取到」。
     */
    valid: !allFailed && piles > 0,
    error,
    devices: carry,
  };

  /* 快照写失败**不能抛**：写失败只影响「下一次能不能省一次扫描」，
     而抛出去会让 /api/snap 直接 500 —— 用户连上一份数据都看不到。
     cron 里也不需要抛，返回 writeFailed 让日志记一笔就够了。 */
  let writeFailed = false;
  try {
    await withTimeout(
      bucket.put(KEYS.snap(area.key), JSON.stringify(snap), {
        httpMetadata: { contentType: 'application/json; charset=utf-8' },
      }),
      tuning.IO_TIMEOUT_MS,
      'R2 put(snap)',
    );
  } catch (err) {
    writeFailed = true;
    console.error(
      `[snap] area=${area.key} 快照写入失败（本轮数据仍在内存里，但没落盘）：` +
        String((err && err.message) || err),
    );
  }

  return { locked: true, snap, scanned: rows.length, failed, writeFailed };
}

/* ── 读路径：给 /api/snap 用 ────────────────────────────────────── */

/**
 * @param wantRefresh 用户这次打开是否希望「尽量新」（前端首屏都传 true，
 *        真正的节流判断在服务端，不信任客户端）。
 * @param guard 写入闸门。omit / null = 不设闸门（单测与 force 用）。
 */
export async function snapFor({
  bucket,
  area,
  now,
  wantRefresh,
  scanBatch,
  tuning = TUNING,
  force = false,
  guard = null,
}) {
  const ts = now();
  let snap = null;
  /**
   * 降级原因。有值时页面显示「暂时取不到」，而不是白屏。
   * 审计发现：R2 读或锁写抛异常时，整个 /api/snap 会 500 —— 用户连上一份
   * 快照都看不到，而这份快照本来就在存储里、完全可用。所以读路径必须
   * 自己兜住所有 I/O 异常。
   */
  let degraded = null;

  try {
    snap = await readSnap(bucket, area.key, tuning);
  } catch (err) {
    degraded = 'r2_read_failed';
    console.error(`[snap] 读快照失败 area=${area.key}：${String((err && err.message) || err)}`);
  }

  let attempted = false;
  let gotLock = false;
  /**
   * 'global' 别的分区正在刷 / 'area' 本区正在刷 /
   * 'inflight' 本区上一轮还没跑完（跨时间片）/
   * 'backoff' 平台一直没响应 / 'rate_limited' 本片本区已经试过（写入闸门）
   */
  let blockedBy = null;

  /* 读都失败了就别再尝试补刷：写大概率也失败，只会拖长首屏时间。 */
  if (wantRefresh && !degraded) {
    const age = snap ? ts - snap.at : Infinity;
    /* 退避期内**连锁都不抢**：抢了也只是拿到锁再空手而归，
       白白消耗一次 Class A。force=1 用于「刚推完新凭证，立刻解除」。 */
    const inBackoff = !force && !!snap && !!snap.retryAfter && ts < snap.retryAfter;

    if (inBackoff) {
      blockedBy = 'backoff';
    } else if (force || age > tuning.THROTTLE_S) {
      /* force=1 连节流一起绕过：它的用途就是「刚推完新凭证，立刻验一次」，
         这时候等 120 秒是没意义的。 */
      attempted = true;
      try {
        const r = await refreshArea({
          bucket,
          area,
          now,
          scanBatch,
          tuning,
          prevHint: snap,
          useGlobalLock: !force,
          ignoreBackoff: force,
          /* force 连「够新」也一起绕过：它的语义就是「别管现在多新，立刻扫一次」。 */
          ignoreFreshness: force,
          /* 也绕过分区锁：运维等不了 120 秒的时间片。 */
          skipAreaLock: force,
          /* force 同样不受写入闸门约束：它本来就要「连点四个区」，
             而且已经要求 `x-snap-key`，不是公开入口。
             用户补刷这一条路必须过闸门 —— 它是唯一会被并发风暴打到的路径。 */
          guard: force ? null : guard,
          guardTag: 'u',
        });
        gotLock = r.locked && r.skipped !== 'backoff';
        if (r.locked) snap = r.snap;
        /* lock_error 只说明「这次没能补刷」，快照本身是好的 ——
           不要因此把整个响应标成 ok:false，那会让页面把已有数据也扔掉。 */
        if (!gotLock) blockedBy = r.reason || 'area';
      } catch (err) {
        /* refreshArea 内部已经兜了绝大多数异常，走到这里说明是意料之外的
           编程错误 —— 记下来，但仍然返回旧数据，不要 500。 */
        degraded = 'refresh_crashed';
        console.error(`[snap] 补刷异常 area=${area.key}：${String((err && err.stack) || err)}`);
      }
    }
  }

  const age = snap && Number.isFinite(snap.at) ? Math.max(0, ts - snap.at) : null;

  return {
    /**
     * ⚠️ 降级时 `ok` 也是 false，但 HTTP 状态码仍然是 200。
     *
     * 这样前端一句 `if (!data.ok)` 就能走「暂时取不到，稍后重试」，
     * 不需要额外处理 5xx —— 而 5xx 在很多前端框架里会直接抛异常、
     * 把已经渲染好的界面换成白屏。
     */
    ok: !degraded,
    error: degraded,
    area: { key: area.key, name: area.name, location: area.location, count: area.ids.length },
    snapshot: snap,
    age,
    /**
     * true = 这次压根没去打上游，直接给你旧数据。
     * 三种来由：数据够新（节流）、本片本区已经试过（写入闸门）、平台还在退避。
     * 后两种由 `rate_limited` / `blocked_by` 细分。
     */
    throttled:
      wantRefresh &&
      blockedBy !== 'backoff' &&
      (!attempted || blockedBy === 'rate_limited'),
    /** true = 这次没能补刷（别人在刷），前端 3 秒后重拉即可。
     *  ⚠️ `lock_error`（R2 写锁失败）**不置 true**：那种情况下重拉
     *  同样会失败，3 秒一次的重拉只会变成一次小型请求风暴。
     *  ⚠️ `rate_limited` 也必须排除：重拉还是同一片，还是被挡。
     *  这一类已经是 `throttled: true`，前端照旧数据展示即可。
     *  `inflight`（上一轮还在飞）**要置 true**：那份数据几秒后就会落地，
     *  重拉正好能拿到，这正是「等别人刷完」的标准语义。 */
    refreshing:
      attempted &&
      !gotLock &&
      (blockedBy === 'global' || blockedBy === 'area' || blockedBy === 'inflight'),
    /**
     * true = 被写入闸门挡下：本片本区已经尝试过一轮。
     * 与 `refreshing` 互斥 —— 收到它别重试，等下个时间片（≤120 秒）。
     * 单独列出来是为了让日志和「正在刷」分开：前者是我们省钱，后者是等别人。
     */
    rate_limited: blockedBy === 'rate_limited',
    /** 具体被哪一层拦下：global / area / backoff / rate_limited / lock_error。 */
    blocked_by: blockedBy,
    /** 退避到期时刻（秒）。有值就说明「平台坏了，别催」。 */
    next_retry:
      snap && snap.retryAfter && snap.retryAfter > ts && snap.retryAfter < ts + 86400
        ? snap.retryAfter
        : null,
    /** true = 这一请求自己跑完了一轮。 */
    refreshed: gotLock,
    tuning: {
      throttle_s: tuning.THROTTLE_S,
      stale_hard_s: tuning.STALE_HARD_S,
      cache_s: tuning.SNAP_CACHE_S,
    },
    server_time: ts,
  };
}

/* ── 每小时统计 ─────────────────────────────────────────────────── */

export async function readStats(bucket, tuning = TUNING) {
  return readJson(bucket, KEYS.stats(), tuning);
}

/**
 * 采一个点。**不触发上游请求** —— 每小时全量 109 台会超单次 50 子请求上限，
 * 而且会把「统计」和「刷新」两件事耦合死。改成：只读，超龄就记 null。
 *
 * 想让点更密，就把统计 cron 的分钟数挪到某条分区 cron 刚刷完之后。
 */
export async function appendStats({ bucket, areas, now, tuning = TUNING }) {
  const ts = now();
  const hourStart = Math.floor(ts / 3600) * 3600;

  /* 按时段表算阈值，而不是写死 1800 秒：
     深夜是 60 分钟档，快照年龄本来就会到 3600 秒，写死就会让每晚 6 小时
     的统计点全变成 null，曲线断成锯齿 —— 那是「宁可空着」用错了地方。 */
  const interval = intervalFor(ts, tuning.schedule);
  const maxAge = Math.max(tuning.STATS_MAX_AGE_S, interval * 1.2 + 120);

  /* ⚠️ 用 allSettled 而不是 all：四个区里只要一个读失败，all 会让整个
     统计 cron 抛异常，连其他三个区本可以记下的点也一起丢掉。
     审计实测这是「一处小故障放大成整条曲线断档」的典型写法。 */
  const settled = await Promise.allSettled(areas.map((a) => readSnap(bucket, a.key, tuning)));
  const snaps = settled.map((r) => (r.status === 'fulfilled' ? r.value : null));

  const per = {};
  let freeSum = 0;
  let totalSum = 0;
  /* 参与了 all 计算的区数。缺区时 all 的分母会变小 —— 数值可能只是轻微
     跳动，但含义已经从「全站」缩成「部分区」。前端必须据此标注，
     否则会被误读成「全站占用率突然波动」。 */
  let coverage = 0;

  areas.forEach((a, i) => {
    if (settled[i].status === 'rejected') {
      per[a.key] = { pct: null, age: null, reason: 'r2_error' };
      return;
    }
    const s = snaps[i];
    if (!s) {
      per[a.key] = { pct: null, age: null, reason: 'missing' };
      return;
    }
    const age = ts - s.at;
    if (age > maxAge) {
      per[a.key] = { pct: null, age, reason: 'stale' };
      return;
    }
    /* 🔴 有 error 就一律不算进 all，不止 upstream。
     *
     * `error.code` 有四种：auth / busy / upstream / partial。
     * 原来只拦 upstream 是个漏洞：
     *   · partial（有成功也有失败）—— 快照的 used_pct/total/free 是按
     *     carry（只含成功那批桩）算的**残缺口径**。它不代表全区，记进
     *     all 会让「所有地址」这条线里混进一个口径不完整的分量，而
     *     coverage 还显示满格，用户看不出。
     *   · auth / busy —— 一般因为 carry 沿用了旧数据、at 停在旧时间戳，
     *     会被上面的 age>maxAge 拦成 stale；但那是「碰巧被拦」，不是
     *     「本该放行」。统一「有 error 就不参与」语义更清晰，也更稳。
     */
    if (s.error) {
      per[a.key] = { pct: null, age, reason: s.error.code || 'upstream' };
      return;
    }
    per[a.key] = { pct: s.used_pct, free: s.free, total: s.total, age };
    freeSum += s.free;
    totalSum += s.total;
    coverage += 1;
  });

  const point = {
    h: hourStart,
    at: ts,
    areas: per,
    all: totalSum ? r1(((totalSum - freeSum) / totalSum) * 100) : null,
    coverage,
  };

  let prev;
  try {
    prev = (await readStats(bucket, tuning)) || { v: 1, points: [] };
  } catch {
    /* 读不到历史就重开一段，总比整条统计 cron 挂掉好 */
    prev = { v: 1, points: [] };
  }
  /* 🔴 窗口按**北京自然日**对齐，不是「往前 168 小时」。
   *
   * 滚动小时窗的问题：今天 20 点打开，窗口起点是 6 天前的 21 点。用户点
   * 「筛某一天」时，最早那天只剩 21:00–23:00 三根柱子 —— 看起来像数据坏了，
   * 其实是窗口没对齐。按自然日对齐后，「周一…周日」每天严格 24 格，
   * 只有今天例外（只到当前小时）。
   *
   * `(hourStart + 8h) % 86400` = 北京时间当日的秒偏移，减掉它就从「北京 0 点」
   * 开始算，不受 UTC 整点影响。
   */
  const BJ_OFFSET = 8 * 3600;
  const bjDayStart = hourStart - ((hourStart + BJ_OFFSET) % 86400);
  const dayCount = Math.max(1, Math.round(tuning.STATS_KEEP / 24));
  const windowStart = bjDayStart - (dayCount - 1) * 86400;
  const windowEnd = bjDayStart + 86400;

  const allPrev = Array.isArray(prev.points) ? prev.points : [];
  const fresh = allPrev.filter((p) => p && p.h !== hourStart);
  const points = fresh.filter((p) => p.h >= windowStart && p.h < windowEnd);
  const dropped = fresh.length - points.length;
  points.push(point);
  points.sort((a, b) => a.h - b.h);
  const kept = points.slice(-tuning.STATS_KEEP);
  /* 缺口 = 「窗口起点到现在」本该有多少小时 - 实际有多少。
     今天还没走到的时段不算缺口，所以上限截到 hourStart。 */
  const expectedHours = Math.min(
    tuning.STATS_KEEP,
    Math.floor((hourStart - windowStart) / 3600) + 1,
  );
  const gaps = Math.max(0, expectedHours - kept.length);

  let writeFailed = false;
  try {
    await withTimeout(
      bucket.put(
        KEYS.stats(),
        JSON.stringify({ v: 1, updated: ts, keep: tuning.STATS_KEEP, points: kept }),
        { httpMetadata: { contentType: 'application/json; charset=utf-8' } },
      ),
      tuning.IO_TIMEOUT_MS,
      'R2 put(stats)',
    );
  } catch (err) {
    writeFailed = true;
    console.error(`[snap] 统计写入失败：${String((err && err.message) || err)}`);
  }

  return { point, kept: kept.length, dropped, gaps, writeFailed };
}

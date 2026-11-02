/**
 * 快照站 · 调度 Worker
 *
 * 职责只有两件：① 按 cron 刷新分区快照；② 把快照和统计只读地发给页面。
 * **不持有凭证** —— 扫桩仍然走站点现有的 `/api/pile`（那里有 token、
 * 有 90 秒 fresh 门槛、有 240 台/分全站预算）。这样凭证只有一处，
 * 也不用把 pileScan 复制第二份。
 *
 * 部署与验收见同目录 README.md。
 */

import {
  TUNING,
  AREA_CRON_MINUTES,
  AREA_CRON_GROUPS,
  shouldRunAt,
  beijingHour,
  intervalFor,
  catchupNeeded,
} from './config.mjs';
import { refreshArea, snapFor, appendStats, readStats, readSnap, WriteGuard } from './core.mjs';
import { createD1Store } from './store-d1.mjs';
import { PARTITIONS } from './partitions.mjs';

/* cron 表达式 → 分区偏移。四条分区 cron 都是 `N-59/5 * * * *`，
   统计 cron 是 `N,M,K * * * *`（v2.65 起每小时三跳，见 config.STATS_CRON_MINUTES），
   靠这个正则区分。
   ⚠️ 统计那条必须允许逗号列表：只写 `^\d{1,2} \* \* \* \*$` 的话，
   `9,29,49 * * * *` 不匹配 → 掉进下面的分区分支 → 被当成「未知 cron」记一条
   warn 然后**什么都不做**，统计从此静默停摆，而且日志里只有一行 warning。 */
const AREA_CRON_RE = /^(\d{1,2})-59\/\d{1,2}\b/;
const STATS_CRON_RE = /^\d{1,2}(,\d{1,2})* \* \* \* \*$/;

const DEFAULT_PILE_ORIGIN = 'https://chd-charge.pages.dev';

/** 允许跨源读取快照的页面。新增域名（含换域名）时这里要跟着改。 */
const ALLOWED_ORIGINS = [
  'https://chd-charge.pages.dev',
  'https://chd-charge.app.workbuddy.host',
  'http://localhost:8907',
  'http://127.0.0.1:8907',
];

const AREA_KEYS = PARTITIONS.areas.map((a) => a.key);
const AREA_BY_KEY = new Map(PARTITIONS.areas.map((a) => [a.key, a]));

/**
 * 内部密钥有没有配。
 *
 * 🔴 这看起来是个多余的检查，其实是在防一次**静默的半天停更**：
 * 部署时忘了 `wrangler secret put SNAP_KEY`，站点 `/api/pile` 就会把我们的
 * 请求当成外站访问拒掉（403）。而 403 在 `refreshArea` 里会被归类成 `auth`
 * —— 也就是「凭证过期」。连续 3 次之后写 6 小时退避，整站停更半天，
 * 日志还写着「凭证失效」，运维会去白抓一次凭证。
 *
 * 所以缺密钥时**干脆不跑**：不写快照、不写退避，日志里一句话说清楚。
 */
const hasSnapKey = (env) => !!String((env && env.SNAP_KEY) || '');

/**
 * 把 D1 binding 包成 core.mjs 期望的「bucket」接口（get/put）。
 *
 * core.mjs 里所有存储调用都走 `bucket.get` / `bucket.put`，所以只要这里
 * 返回一个和 R2 同形的对象，core.mjs 一行都不用改。D1 的差异（原子锁用
 * `INSERT ON CONFLICT DO NOTHING`、锁要显式清理）全部被 store-d1.mjs 藏住。
 *
 * ⚠️ 兼容两种输入：
 *   - 线上：env.SNAP 是 D1 binding（有 prepare/batch），包成 store。
 *   - 测试：审计脚本直接塞一个「已经是 store」或 R2 mock 的对象进来，
 *     它已经有 get/put，就原样返回，不再包一层。
 * 判断依据是有没有 `prepare`（D1 binding 的特征）。store 和 R2 mock 都没有
 * prepare，但有 get/put，属于「已就绪」，直接返回。
 */
const getStore = (env) => {
  const snap = env.SNAP;
  if (!snap) return null;
  if (typeof snap.prepare === 'function') return createD1Store(snap);
  /* 已经是 store（有 get/put 且无 prepare）或测试塞的 R2 mock —— 直接用 */
  return snap;
};

/**
 * 写入闸门，**模块级单例** —— cron 和 fetch 共用同一份状态。
 *
 * 共用是关键：如果各建一份，cron 在 :00 扫过 beimen、用户在 :01 又来补刷，
 * 两边都以为「本片还没试过」，闸门就等于没有。共用之后，同片同区只放行一次。
 *
 * 它只活在 isolate 内存里，跨 isolate 不共享 —— 这是刻意的：R2 里没有任何
 * 便宜的原子自增原语，为了一个近似计数去多读写一次存储，比它要省的钱还贵。
 * 见 core.mjs 里 WriteGuard 的注释。
 */
const GUARD = new WriteGuard(TUNING);

/**
 * 扫一批桩：调站点现有的 /api/pile（一次请求一批，最多 40 个编号）。
 *
 * 为什么不用自己的 token 直连上游：一是凭证明文会多存一份，二是会绕过
 * 站点已有的 90 秒 fresh 门槛和全站预算 —— 两套限流互相不知道对方存在，
 * 等于把历史那次「109 台/分 → 整片 TCP 超时」的概率翻倍。
 *
 * why `x-snap-key`：站点 Worker 从 v2.25 起要求同源（挡掉「当免费代理刷
 * 平台」），服务端对服务端本来没有 Origin，而 Origin/Referer 在 Workers
 * 的 fetch 里属于受限头，设了也可能被剥掉。所以走一条显式密钥通道，
 * 需要在 `_worker.js` 里加 3 行（README「第 0 步」给了原样补丁）。
 */
function makeScanBatch(env) {
  const base = String(env.PILE_ORIGIN || DEFAULT_PILE_ORIGIN).replace(/\/+$/, '');
  const key = String(env.SNAP_KEY || '');
  const CHUNK = Math.max(1, Number(TUNING.SCAN_CHUNK) || 14);
  const LANES = Math.max(1, Number(TUNING.SCAN_LANES) || 2);

  /* 留 1.5 秒给「把结果摊回每台、交给上层归类」这两步，让下面这层**先于**
     core.mjs 外面的 withTimeout(18s) 收手 —— 否则超时会把已经拿到手的批次
     一起丢掉，白扫一遍还占着平台额度。 */
  const BUDGET_MS = Math.max(2000, TUNING.SCAN_TIMEOUT_MS - 1500);

  /** 打一批。抛错 = 这一批整体失败，由调用方摊到这一批的每台身上。
   *
   * `src` 是数据源（v2.65）：`zm` = 住芒（默认，站点 Worker 用服务端凭证去查），
   * `lvcc` = 驴充充（住宅区那 8 台，无鉴权）。一个批次只能有一个源 ——
   * 站点 `/api/pile` 就是按这个开关分流的，混着发会把一半 id 打到错的平台。 */
  async function callChunk(ids, deadline, src = 'zm') {
    const headers = { 'content-type': 'application/json' };
    if (key) headers['x-snap-key'] = key;

    /* core.mjs 外面还有一层 withTimeout，但那一层只是「不再等」，
       并不会真的取消请求。这里给 fetch 一个自己的 signal，让连接能释放。
       剩余时间不足时按剩余时间设，避免最后一批拖过截止点。 */
    const remain = Math.max(1000, Math.min(TUNING.SCAN_TIMEOUT_MS, deadline - Date.now()));
    const signal =
      typeof AbortSignal !== 'undefined' && AbortSignal.timeout
        ? AbortSignal.timeout(remain)
        : undefined;

    const res = await fetch(base + '/api/pile', {
      method: 'POST',
      headers,
      body: JSON.stringify(src === 'lvcc' ? { ids, fresh: true, src } : { ids, fresh: true }),
      signal,
    });
    if (!res.ok) throw new Error('站点扫描接口 HTTP ' + res.status);

    let data;
    try {
      data = await res.json();
    } catch {
      throw new Error('站点扫描接口返回的不是 JSON');
    }
    if (!data || data.ok !== true) {
      /* 🔴 不拼上游原文。审计发现这里漏了一条泄漏路径：
       *
       *  站点 `/api/pile` 的 `error` 字段可能带 trace id、内部地址、token
       *  提示（实测见过 `JWT token is missing; trace=abc123`）。如果照抄进
       *  throw 的 message，它会被 refreshArea 兜住后写进 `console.warn` 的
       *  「样例」，永久留在 Cloudflare 日志里。
       *
       *  上一次审计只堵了「快照里不泄漏」（core.classifyError 只存归类码），
       *  但**日志里**这条漏网了 —— 日志虽不公开，可 trace/内部地址这类东西
       *  本来就不该有任何一份副本。
       *
       *  所以这里只抛一个稳定的、不含原文的标记。`classifyError` 会把它
       *  归成 `other`，退避逻辑照常；真要排障，去站点 Worker 自己的日志看。 */
      throw new Error('站点扫描接口 ok=false');
    }

    return ids.map((id) => {
      const rec = data.results ? data.results[id] : null;
      if (!rec) return { id, error: '站点扫描接口没返回这台' };
      if (rec.error) return { id, error: rec.error, auth: !!rec.auth, throttled: !!rec.throttled };
      return { id, ports: rec.ports || [] };
    });
  }

  return async (ids, _concurrency, opts) => {
    /* 数据源由调用方（core.refreshArea）按分区带进来。缺省住芒 ——
       所有既有分区都不写 src，行为与加这个参数之前完全一致。 */
    const src = (opts && opts.src) || 'zm';
    const deadline = Date.now() + BUDGET_MS;
    const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
    const STAGGER = Math.max(0, Number(TUNING.SCAN_STAGGER_MS) || 0);
    const RETRY_GAP = Math.max(0, Number(TUNING.SCAN_RETRY_GAP_MS) || 0);

    /** 打一批并兜住异常：抛错只代表这一批整体失败，摊到这批每台身上。 */
    const one = async (chunk) => {
      try {
        return await callChunk(chunk, deadline, src);
      } catch (err) {
        const msg = String((err && err.name === 'TimeoutError') ? '站点扫描接口 超时' : (err && err.message) || err);
        return chunk.map((id) => ({ id, error: msg }));
      }
    };

    /* 把一批结果里失败的那些台补扫一遍（2026-10-30 新增，见 config 的
       SCAN_RETRY_GAP_MS 注释）。只补失败且非 auth 的台；时间不够就不补。
       补扫的台也可能超过 CHUNK（两个批各挂一半）→ 仍按 CHUNK 切开发。 */
    const heal = async (rows) => {
      const bad = rows
        .filter((r) => r && r.error && !r.auth)
        .map((r) => r.id);
      if (!bad.length || RETRY_GAP <= 0) return rows;
      if (deadline - Date.now() < RETRY_GAP + 1500) return rows;
      await sleep(RETRY_GAP);
      const got = new Map();
      for (let i = 0; i < bad.length; i += CHUNK) {
        if (deadline - Date.now() < 1500) break;
        try {
          const res = await callChunk(bad.slice(i, i + CHUNK), deadline, src);
          for (const r of res) if (r && r.id) got.set(r.id, r);
        } catch {
          /* 这一批补扫失败 → 保持原结果，别把成功台弄丢 */
        }
      }
      if (!got.size) return rows;
      return rows.map((r) => (r && r.error && !r.auth && got.get(r.id)) || r);
    };

    if (ids.length <= CHUNK) {
      /* 单批（物业 12 台这种）：失败照样补扫 —— 05:00 那次 partial 就是它。 */
      return heal(await one(ids));
    }

    /* 🔴 必须分批。整区一把梭会撞站点 Worker 的子请求额度：
     * 每台要花 3 个子请求（cache.match + fetch + cache.put）+ 2 个预算桶读写，
     * 免费版上限 50，所以一批最多 16 台。北门 37 台整批发出去的结果是
     * **前 11 台成功、第 12 台起全部「8 秒超时」**（39 个额度花在 match 和
     * 预算上，只剩 11 个 fetch 名额）—— 而且返回体里看不出任何异常，
     * 只会被当成「平台挂了」。见 config.mjs 的 SCAN_CHUNK 注释。 */
    const chunks = [];
    for (let i = 0; i < ids.length; i += CHUNK) chunks.push(ids.slice(i, i + CHUNK));

    const out = new Array(chunks.length);
    let cursor = 0;
    /* 🔴 全局发车间隔门（2026-10-30）：下一批允许起步的时刻。
       所有批的**起步时刻**全局错开 ≥ STAGGER，不管它落在哪条 lane ——
       原来 LANES=2 且零间隔，开扫瞬间就是 2×14=28 台并发；只错峰各 lane
       自己的批次还不够，两条 lane 的后续批次仍可能撞到同一毫秒。
       峰值在飞批数仍是 LANES（前一批没完，后一批到点也照样起步），
       但「同时起步」的尖峰彻底没了。 */
    let nextSlot = 0;
    const lane = async () => {
      while (cursor < chunks.length) {
        const k = cursor++;
        if (deadline - Date.now() < 600) {
          out[k] = chunks[k].map((id) => ({ id, error: '站点扫描接口 时间不够，这批没发' }));
          continue;
        }
        /* 先占位再睡：第二条 lane 到达时看到的是已被第一条推后的时刻，
           否则两条各读各的、会在同一毫秒一起醒来（实测踩过）。 */
        const now0 = Date.now();
        const startAt = Math.max(now0, nextSlot);
        nextSlot = startAt + STAGGER;
        if (startAt > now0) await sleep(Math.min(startAt - now0, deadline - Date.now()));
        if (deadline - Date.now() < 600) {
          out[k] = chunks[k].map((id) => ({ id, error: '站点扫描接口 时间不够，这批没发' }));
          continue;
        }
        out[k] = await one(chunks[k]);
      }
    };
    await Promise.all(Array.from({ length: Math.min(LANES, chunks.length) }, lane));

    /* 首轮结束后统一补扫失败的台（只补一次、只睡一次）。partial 快照按
       口径进不了统计点 —— 与其等 5 分钟后的下一跳（深夜是 1 小时后），
       不如当场救。 */
    return heal(out.flat());
  };
}

function corsHeaders(request) {
  const origin = request.headers.get('origin') || '';
  const h = new Headers({
    'access-control-allow-methods': 'GET, OPTIONS',
    'access-control-allow-headers': 'content-type',
    vary: 'Origin',
    /**
     * ⚠️ 暴露 `Age` 不是可选项，是修一个会让页面显示错误新鲜度的坑。
     *
     * `/api/snap` 带 `Cache-Control: max-age=60`，响应里的 `age` 是
     * **生成那一刻**的年龄。命中缓存时前端拿到的可能是 55 秒前的副本，
     * 但它看到的 `age` 还是 0 —— 页面会写「刚刚更新」，而数据其实快过期了。
     *
     * 真实年龄 = 响应里的 `age` + 响应头 `Age`。可 `Age` 不在 CORS 的
     * 安全列表里，**不显式暴露的话浏览器根本读不到它**，前端就算想算也算不了。
     */
    'access-control-expose-headers': 'Age, Date',
  });
  if (ALLOWED_ORIGINS.includes(origin)) h.set('access-control-allow-origin', origin);
  return h;
}

function json(data, { status = 200, cache = 0, request } = {}) {
  const headers = new Headers({
    'content-type': 'application/json; charset=utf-8',
    'cache-control': cache > 0 ? `public, max-age=${cache}` : 'no-store',
  });
  if (request) for (const [k, v] of corsHeaders(request)) headers.set(k, v);
  return new Response(JSON.stringify(data), { status, headers });
}


/**
 * 真正的请求处理。被下面的 `fetch` 包在一层 try/catch 里 ——
 * 任何意料之外的编程错误（字段改名、数组越界、undefined 取值）都不该
 * 变成 500 白屏，而应该让页面显示「暂时取不到」。
 */
async function handleRequest(request, env) {
  const url = new URL(request.url);
  if (request.method === 'OPTIONS') {
    return new Response(null, { status: 204, headers: corsHeaders(request) });
  }

  if (!env.SNAP) {
    return json({ ok: false, error: 'd1_not_bound' }, { status: 501, request });
  }

  /* GET /api/snap?area=chaohui&refresh=1
     refresh=1 时由服务端判断节流：快照够新就直接返回（throttled），
     抢不到锁就返回 refreshing=true 让前端 3 秒后重拉。 */
  if (url.pathname === '/api/snap') {
    /* ⚠️ 默认 **不补刷**，必须显式 `refresh=1`。
       原来写的是 `!== '0'`（默认补刷），后果是任何人不带参数 curl 一下、
       搜索引擎爬虫抓一次、甚至 Cloudflare 的健康检查，都会触发一轮
       真实的上游扫描。读和写分不开的接口，等于把「打上游」这件事
       交给所有路过的人。现在只读是默认行为。 */
    const wantRefresh = url.searchParams.get('refresh') === '1';
    const now = () => Math.floor(Date.now() / 1000);
    const areaParam = url.searchParams.get('area') || '';

    if (areaParam === 'all') {
      /* 用 allSettled：Promise.all 下只要一个区读失败，整个请求就 500 ——
         而另外三个区的数据本来是好的。审计实测这是「一处小故障
         放大成整页白屏」的写法。 */
      const settled = await Promise.allSettled(
        PARTITIONS.areas.map(async (area) => {
          const snap = await readSnap(getStore(env), area.key);
          const ts = now();
          return {
            key: area.key,
            name: area.name,
            count: area.ids.length,
            age: snap && Number.isFinite(snap.at) ? Math.max(0, ts - snap.at) : null,
            snapshot: snap,
            degraded: false,
          };
        }),
      );
      const list = settled.map((r, i) =>
        r.status === 'fulfilled'
          ? r.value
          : {
              key: PARTITIONS.areas[i].key,
              name: PARTITIONS.areas[i].name,
              count: PARTITIONS.areas[i].ids.length,
              age: null,
              snapshot: null,
              degraded: 'r2_read_failed',
            },
      );
      const ts = now();
      const valid = list.filter((x) => !x.degraded && x.snapshot && x.snapshot.total);
      const total = valid.reduce((s, x) => s + x.snapshot.total, 0);
      const free = valid.reduce((s, x) => s + x.snapshot.free, 0);
      const failedCount = list.filter((x) => x.degraded).length;

      /* 最旧的那个区。总览页要「补刷」时只能挑一个区单独发 —— 这里给它。
         挑最旧的而不是固定某个区，是为了让六个区被轮流推进。 */
      const oldest = valid.length
        ? valid.reduce((m, x) => ((x.age ?? 0) > (m.age ?? 0) ? x : m), valid[0])
        : null;

      /* ⚠️ `area=all` **不支持 refresh=1**，而这里原来会静默忽略它。
         原因：六个区串行扫描，最坏 6 × 18 秒 = 108 秒 —— 这是 HTTP 请求
         （不是 cron），没人会为一个总览页等两分钟，站点 Worker 的反代也早断了。
         所以总览页必须自己挑一个区单独补刷（用下面这个 oldest_key）。
         显式回一个字段，好过让前端以为「传了 refresh 就会刷新」。 */
      const refreshAsked = url.searchParams.get('refresh') === '1';

      return json(
        {
          /* 只要还有一个区拿不到，就整体标降级 —— 但数据照发，
             让前端能显示「西区暂时取不到」而不是整页空掉。 */
          ok: failedCount === 0,
          error: failedCount ? 'partial_r2_error' : null,
          areas: list,
          /* 传了 refresh=1 才会出现：告诉前端「这次没刷，下次请指定区」 */
          refresh_ignored: refreshAsked ? 'area=all_not_supported' : null,
          oldest_key: oldest ? oldest.key : null,
          summary: {
            areas: valid.length,
            total,
            free,
            used_pct: total ? Math.round(((total - free) / total) * 1000) / 10 : null,
            /* ⚠️ 这里原来写的是 `x.age ?? 0`：所有区都没数据时会返回 0，
               页面读成「0 秒前刚更新」—— 与事实相反。没有数据就是 null。 */
            oldest_age: valid.length
              ? valid.reduce((m, x) => Math.max(m, x.age ?? 0), 0)
              : null,
            degraded_areas: failedCount,
          },
          tuning: {
            throttle_s: TUNING.THROTTLE_S,
            stale_hard_s: TUNING.STALE_HARD_S,
            cache_s: TUNING.SNAP_CACHE_S,
          },
          server_time: ts,
        },
        /* 有区降级时不要缓存：否则「暂时取不到」会被钉住 60 秒。 */
        { cache: failedCount === 0 ? TUNING.SNAP_CACHE_S : 0, request },
      );
    }

    const area = AREA_BY_KEY.get(areaParam);
    if (!area) {
      return json(
        { ok: false, error: 'unknown_area', areas: AREA_KEYS },
        { status: 400, request },
      );
    }

    /* ⚠️ force=1 必须带内部密钥才生效。
       force 会绕过节流、全站锁和退避 —— 如果公开可调，等于给所有人
       一个「把上游打爆」的按钮。浏览器永远拿不到这个 key，只有
       `wrangler` / curl 这类运维动作能带。 */
    const wantsForce = url.searchParams.get('force') === '1';
    const force =
      wantsForce &&
      !!env.SNAP_KEY &&
      request.headers.get('x-snap-key') === env.SNAP_KEY;

    /* 没配 SNAP_KEY 时不要尝试补刷，理由同 cron 里那段：站点会回 403，
       而 403 会被写成 auth 退避 6 小时 —— 用户看到的是「凭证过期」，
       实际只是部署漏了一步。这里保留只读能力，只是不补刷。 */
    const keyReady = hasSnapKey(env);

    const out = await snapFor({
      bucket: getStore(env),
      area,
      now,
      wantRefresh: wantRefresh && keyReady,
      scanBatch: makeScanBatch(env),
      force,
      /* 写入闸门。force（持密钥的运维动作）在 snapFor 内部自行豁免。 */
      guard: GUARD,
    });
    return json(
      {
        ...out,
        forced: force,
        /* 非 null 说明这一处部署缺密钥 —— 页面照常显示旧数据，
           但运维一眼能看出「不是平台挂了，是配置没配」。 */
        config_error: keyReady ? null : 'snap_key_missing',
      },
      {
        /* ⚠️ 「正在刷 / 退避中」这两种状态绝不能缓存 60 秒。
           前端收到 refreshing 后 3 秒会重拉，如果 CDN 把这只回执缓存住，
           它重拉到的还是同一条 refreshing，页面就会一直转圈。
           数据够新（throttled）和刚刷完（refreshed）才是可以缓存的。
           `inflight` 也属于「正在刷」，同样不缓存。 */
        cache: out.refreshed || out.throttled ? TUNING.SNAP_CACHE_S : 0,
        request,
      },
    );
  }

  /* GET /api/stats —— 一周的每小时占有率 */
  if (url.pathname === '/api/stats') {
    const stats = (await readStats(getStore(env))) || { v: 1, points: [] };
    return json({ ok: true, ...stats }, { cache: 300, request });
  }

  if (url.pathname === '/api/health') {
    const now = Math.floor(Date.now() / 1000);
    const settled = await Promise.allSettled(
      PARTITIONS.areas.map((a) => readSnap(getStore(env), a.key)),
    );
    const areas = PARTITIONS.areas.map((a, i) => {
      const r = settled[i];
      if (r.status === 'rejected') {
        return { key: a.key, at: null, age: null, err: { code: 'r2_error' } };
      }
      const s = r.value;
      const interval = intervalFor(now);
      const age = s && Number.isFinite(s.at) ? Math.max(0, now - s.at) : null;
      return {
        key: a.key,
        at: s && Number.isFinite(s.at) ? s.at : null,
        age,
        /* 让「该跑却没跑」这件事能被一眼看出来：
           age 超过 interval + GRACE 就说明上一次刷新没跟上，巡检或外部
           探活只要盯这一个布尔量即可（CF 对丢跳不告警，只能自己算）。 */
        interval,
        overdue: age !== null && catchupNeeded(age, interval),
        /* 只回归类码。`error` 里已经没有上游原文（见 core.classifyError）。 */
        err: s ? s.error : { code: 'missing' },
        valid: s ? !!s.valid : false,
        piles: s ? s.piles : null,
      };
    });
    /* 自检用：这几个 false 说明部署漏了一步，比看日志快得多。 */
    const config = {
      d1_bound: !!env.SNAP,
      snap_key_set: !!env.SNAP_KEY,
      pile_origin: String(env.PILE_ORIGIN || DEFAULT_PILE_ORIGIN),
      global_lock: TUNING.GLOBAL_LOCK_ENABLED,
      cron_uses_global_lock: TUNING.CRON_USES_GLOBAL_LOCK,
      /* true = 这一处不参与扫描（灰度/测试部署应设 DISABLE_CRON=1）。 */
      cron_disabled: String(env.DISABLE_CRON || '') === '1',
    };
    /* 写入闸门的运行状态。`est_put` 是「今天的估算写次数」，用来对照
       D1 免费额度（10 万行写/天）判断是否需要收紧。
       注意它是 isolate 级的、重启归零，只能当趋势看，不能当账本。 */
    const write_guard = GUARD.stats();
    /* ⚠️ 这个接口每次都读 4 个对象，而它没有任何缓存的话，被轮询就是
       纯 Class B 放大（曾经是唯一一个无缓存的读接口）。
       给 60 秒缓存；要立刻看最新值就加 `?fresh=1`。 */
    const cache = url.searchParams.get('fresh') === '1' ? 0 : 60;
    return json({ ok: true, areas, config, write_guard, server_time: now }, { cache, request });
  }

  return json({ ok: false, error: 'not_found' }, { status: 404, request });
}

/* 具名导出只为单测（scratch 里验错峰/补扫逻辑用）；运行时走下面的 default。 */
export { makeScanBatch };

export default {
  /* ── 定时任务 ─────────────────────────────────────────────── */
  async scheduled(event, env, ctx) {
    /* 最后一层防线。任何未捕获异常都会让这次触发**彻底没有记录**：
       没有日志、没有快照、cron 面板只显示一次失败 —— 而「坏了但看不出
       坏在哪」正是历史那次「页面一直转」的成因。所以这里兜住一切。 */
    try {
      const now = () => Math.floor(Date.now() / 1000);
      const ts = now();
      const bucket = getStore(env);
      if (!env.SNAP) {
        console.error('[snap] 缺少 D1 绑定 SNAP，cron 空转');
        return;
      }

      /* 🔴 多部署互斥开关。
       *
       * 速率审计实测：同一份代码部署两处、cron 都开着，两边锁在各自的桶里、
       * 互相看不见 —— 峰值从 73 台/分变成 109 台/分，节流内重复 8,720 台次，
       * 正好回到历史事故那个量级，而且**全程不报任何错**。
       *
       * 所以做灰度/测试部署时，必须在那个部署里设 DISABLE_CRON=1。
       * 这比「记得删 wrangler.toml 里的 crons」可靠：忘记删是静默事故，
       * 忘记设这个开关只是那一处不刷新，一眼能从 /api/health 看出来。 */
      if (String(env.DISABLE_CRON || '') === '1') {
        console.log('[snap] DISABLE_CRON=1，这一处不参与扫描');
        return;
      }

      /* 缺 SNAP_KEY 就别跑：站点必然 403，而 403 → auth → 6 小时退避。
         那是一条「部署漏了一步」被记成「凭证过期」的假故障。 */
      if (!hasSnapKey(env)) {
        console.error(
          '[snap] 缺少 SNAP_KEY，这一轮不跑。' +
            '站点 /api/pile 会返回 403，而 403 会被记成 auth 退避 6 小时 —— ' +
            '那是假故障，别去重抓凭证。先 `npx wrangler secret put SNAP_KEY`。',
        );
        return;
      }

      const cron = event.cron || '';

      /* 每小时统计：只读快照，不打上游（全量 109 台会超单次子请求上限，
         而且统计和刷新耦合在一起后，一处慢就两处都慢）。 */
      if (STATS_CRON_RE.test(cron)) {
        const r = await appendStats({ bucket, areas: PARTITIONS.areas, now });
        console.log(
          `[snap] stats h=${r.point.h} all=${r.point.all} kept=${r.kept} gaps=${r.gaps} dropped=${r.dropped}`,
        );
        /* 顺带清一次过期锁。D1 没有 TTL，锁表一天长 3600 行、一个月 10.8 万行，
           不清的话 inflight 检查的 SELECT 会从点查退化成扫表，行读额度爆炸。
           每小时清一次，成本 1 条 DELETE（按行计费 < 几十行），换来「锁表恒有界」。
           只在 D1 store 上有这个方法（R2 靠 lifecycle 删，测试 mock 没有）——
           R2/测试下这里静默跳过，不报错。 */
        if (typeof bucket.purgeLocks === 'function') {
          try {
            const purged = await bucket.purgeLocks();
            if (purged > 0) console.log(`[snap] purgeLocks 清掉 ${purged} 行过期锁`);
          } catch (err) {
            /* 清理失败不是故障：锁表多几行，下个小时再清。别让一条 DELETE
               把整个统计 cron 拖垮（统计点已经写完了）。 */
            console.error(`[snap] purgeLocks 失败：${String((err && err.message) || err)}`);
          }
        }
        return;
      }

      const m = AREA_CRON_RE.exec(cron);
      if (!m) {
        console.warn('[snap] 未知 cron：' + cron);
        return;
      }

      const offset = Number(m[1]);
      /* 一跳可以带多个分区（v2.65 起「住宅」并进 :03 和物业一起刷）。
         按 key 取，不按下标 —— 见 config.mjs 的 AREA_CRON_GROUPS。 */
      const group = AREA_CRON_GROUPS[AREA_CRON_MINUTES.indexOf(offset)] || [];
      const areas = group.map((k) => AREA_BY_KEY.get(k)).filter(Boolean);
      if (!areas.length) {
        console.warn(`[snap] cron 偏移 ${offset} 没有对应的分区（wrangler.toml 与 config.mjs 不一致？）`);
        return;
      }
      if (areas.length < group.length) {
        /* 只警告不中断：剩下的区照常刷，缺的那个由 selftest / /api/health 抓 */
        console.warn(
          `[snap] 分区组里有 key 在 partitions.mjs 里不存在：` +
            group.filter((k) => !AREA_BY_KEY.get(k)).join('、'),
        );
      }

      /* ⚠️ 下面这段原本是「一个区走完」，现在包在循环里 ——
         原来那些 `return` 表示「这一跳不跑这个区」，进循环后必须改成
         `continue`，否则住宅会被物业的跳过顺带吞掉。 */
      for (const area of areas) {

      /* 🔴 判定用「计划时刻」而不是「实际醒来的时刻」。
       *
       * CF 只保证在那一分钟内投递，不保证第 0 秒送达。`event.scheduledTime`
       * 是**排定的那个整分钟**，而 `ts` 是实际开始跑的时刻。原来拿 `ts`
       * 去做 `shouldRunAt` 的分钟取模，于是「迟了几秒、跨过分钟边界」
       * 就会被判成「不该我跑」—— 整跳静默跳过。深夜 60 分钟档每区
       * 每小时只有一次机会，丢一次就是数据老化到 2 小时。
       *
       * 测试里 `scheduled({ cron })` 不带 scheduledTime，回落到 Date.now()。 */
      const scheduledSec = Number.isFinite(event.scheduledTime)
        ? Math.floor(event.scheduledTime / 1000)
        : ts;
      const driftSec = ts - scheduledSec;
      if (driftSec > TUNING.CRON_DRIFT_LOG_S) {
        console.warn(
          `[snap] cron 投递迟到 ${driftSec}s cron=${cron}` +
            `（仍按计划时刻 ${scheduledSec} 判定，不影响这一跳）`,
        );
      }

      /* 补跑：日历说不该我跑时，看一眼实际年龄是不是明显过期了。
         详见 config.CRON_CATCHUP_ENABLED 的注释 —— CF 不重试，丢跳必须自己补。 */
      let runAsCatchup = false;
      if (!shouldRunAt(scheduledSec, offset)) {
        if (!TUNING.CRON_CATCHUP_ENABLED) {
          console.log(`[snap] skip area=${area.key} hour=${beijingHour(scheduledSec)}`);
          continue;
        }
        const prev = await readSnap(bucket, area.key).catch(() => null);
        const age = prev && Number.isFinite(prev.at) ? Math.max(0, scheduledSec - prev.at) : Infinity;
        const interval = intervalFor(scheduledSec);
        if (!catchupNeeded(age, interval)) {
          console.log(`[snap] skip area=${area.key} hour=${beijingHour(scheduledSec)}`);
          continue;
        }
        /* 补跑强制占全站锁：outage 之后四区会同时超龄，不占锁就是
           四区同分钟一起跑 = 109 台/分，正是历史事故那个量级。 */
        runAsCatchup = true;
        console.warn(
          `[snap] catch-up area=${area.key} age=${Math.round(age)}s interval=${interval}s` +
            ` （上一跳没跑成，本次补跑并占全站锁）`,
        );
      }

      /* cron 是否也占全站锁，见 config.mjs 的 CRON_USES_GLOBAL_LOCK 注释：
         默认不占 —— 四条 cron 已经用 0/1/2/3 分钟偏移严格错峰，一分钟只有
         一个区在跑；如果它也占锁，用户在 0–3 分钟里补刷任何区都会拿到
         refreshing，白等了 4 分钟才轮到自己，体验不能接受。 */
      const r = await refreshArea({
        bucket,
        area,
        now,
        scanBatch: makeScanBatch(env),
        /* 补跑那一轮占全站锁；正常那一跳保持「四条 cron 严格错峰、一分钟
           只有一个区在跑」的现状，用户在同一分钟内补刷不必等。 */
        useGlobalLock: runAsCatchup || TUNING.CRON_USES_GLOBAL_LOCK,
        /* ⚠️ cron **不过写入闸门**，这是想清楚之后的决定，不是遗漏。
         *
         * 闸门的价值全在用户路径上（那里才可能出现几十个并发同时抢锁）。
         * cron 一天只有约 288 轮，替它省掉一次 412 顶多省 288 次写/天，
         * 而代价是「万一被判成重复，这一跳就静默不刷」—— 数据白白晚 5 分钟。
         * 崩溃审计（audit_crash）里就是因为给 cron 加了闸门，同一时间片内
         * 连跑几个场景后快照不再落盘，7 条断言直接变红。
         *
         * 所以：花小钱买大风险的事不做。cron 只受「分区锁 + 够新就跳过」约束。 */
      });
      if (!r.locked) {
        /* reason=global 说明同一分钟别的区正在跑（全站分钟锁生效），
           reason=area 说明本区上一轮还没跑完。两者都不是故障，下一跳再来。 */
        console.log(`[snap] skip area=${area.key} reason=${r.reason}`);
        continue;
      }
      if (r.skipped === 'backoff') {
        console.log(`[snap] skip area=${area.key} backoff until ${r.snap.retryAfter}`);
        continue;
      }
      /* 数据够新（用户刚补刷过），这一跳是多余的。
         这类跳过说明节流在起作用，不是故障 —— 但它值得记下来：
         如果连续多跳都是 fresh，说明 cron 频率比实际需要高，
         可以把时段表的间隔调大，省上游额度。 */
      if (r.skipped === 'fresh') {
        console.log(`[snap] skip area=${area.key} fresh age=${Math.round(r.prevAge)}s`);
        continue;
      }
      console.log(
        `[snap] area=${area.key} piles=${r.snap.piles} free=${r.snap.free} ` +
          `used=${r.snap.used_pct}% failed=${r.failed} elapsed=${r.snap.elapsed}s ` +
          `err=${r.snap.error ? r.snap.error.code : '-'}`,
      );
      }
    } catch (err) {
      console.error(
        `[snap] cron 未捕获异常 cron=${event && event.cron}：` +
          String((err && err.stack) || err),
      );
    }
  },

  /* ── 只读接口 ─────────────────────────────────────────────── */
  async fetch(request, env) {
    try {
      return await handleRequest(request, env);
    } catch (err) {
      /* ⚠️ 仍然返回 200：前端只要判断 `ok === false` 就够了。
         5xx 会让很多前端代码直接抛异常，把已渲染的界面换成白屏 ——
         数据已经取不到了，不该连「上一次的界面」也一起丢掉。 */
      console.error(`[snap] 请求未捕获异常 url=${request.url}：` + String((err && err.stack) || err));
      return json({ ok: false, error: 'internal' }, { request });
    }
  },
};

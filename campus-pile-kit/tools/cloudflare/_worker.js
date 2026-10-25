/**
 * Cloudflare Pages 高级模式 Worker —— 只处理 /api/*
 *
 * 由同目录 _routes.json 限定：只有 /api/* 会进入这个 Worker，其余路径由
 * Pages 静态资源服务器直接返回。这样做的好处：
 *   1. 静态请求不消耗 Functions 额度（免费 10 万次/天只算 API 调用）
 *   2. _headers 对静态文件照常生效（Worker 不接管 sw.js / index.html）
 *   3. 站点本身零改动，即使 Worker 挂了页面也能开
 *
 * 需要的两个配置（Cloudflare 控制台 → 项目 → Settings）：
 *   Bindings    → KV namespace，变量名 CHD_CRED
 *   Variables   → ADMIN_TOKEN（类型选 Secret/加密）
 *
 * 约定：KV 里只存**密文**。加密/解密都在浏览器端（AES-GCM + PBKDF2 20 万轮），
 * 所以即便有人把 /api/cred 直接拉走，没有共享口令也解不开。
 * 本 Worker 只是一个「带写口令的公共信箱」，不做任何加解密。
 */

const KEY = 'cred';           // KV 里的键名
const MAX_BODY = 64 * 1024;   // 密文上限 64 KB，够放巨长的凭证串
const MAX_FAILS = 10;         // 每窗口最多失败次数
const FAIL_WINDOW_MS = 10 * 60 * 1000;

/* ---------------- 平台查询代理（/api/pile） ----------------
 *
 * 为什么必须走这里：平台对**出口 IP** 有风控。
 * 浏览器直连 = 每个用户用自己的 IP 一口气打 109 个请求，很容易被拖黑 ——
 * 2026-10-23 实测：整片请求 8 秒超时、换电脑换手机都一样，只有换网络才恢复，
 * 而页面还表现为「一直转、记录停在几个小时前」。
 *
 * 走 Worker 之后：
 *   · 出口换成 Cloudflare 边缘节点，不再消耗用户自己的 IP 信誉；
 *   · 结果按单台缓存 5 分钟（与页面自动刷新间隔对齐），同一时间多人看同一个桩，
 *     只有一个请求真正回源平台；
 *   · 浏览器只发 3 个批量请求（109 台 ÷ 40），而不是 109 个。
 *
 * ⚠️ 免费版单次调用子请求上限 50，所以 PILE_MAX_IDS 卡在 40（留余量）。
 */
const PILE_API = 'https://union.zhumanggroup.com';
const PILE_SCAN = '/api/rent/scan-code';
const PILE_TTL = 300;            // 边缘缓存秒数（普通请求的上界）
const PILE_MAX_IDS = 40;
const PILE_RATE = 30;            // 单 IP 每分钟最多几次批量请求

/* ---------------- 「用户点了刷新」时怎么兼顾实时性与风控 ----------------
 *
 * 🔴 2026-10-25 线上问题：用户点「刷新」后卡片仍写「更新于 3 分钟前」，
 *    再点一次也不变，偶尔才变成「几秒前」。
 *
 *    根因不在页面 —— 页面早就把 `force` 传下来了，但 `force` 只作用于
 *    **浏览器本地缓存**（loadDevice 的 THROTTLE_MS）；真正的数据来自这个 Worker，
 *    而 Worker 一律 `cache.match` 命中就返回，`at` 用的是**缓存写入那一刻**的时间。
 *    于是「刷新」实际是「把 5 分钟前那份结果又显示了一遍」，时间戳当然不动。
 *
 * 现在支持 body 里的 `fresh: true`（页面手动/自动刷新都会带）：
 *   · 命中缓存时先算年龄，`age <= PILE_FRESH_MIN` 才直接用 —— 数据本来就新，
 *     没必要再打平台；
 *   · 超过门槛才回源，拿到的新结果照旧写缓存（别人还能受益）。
 *
 * 🔴 门槛为什么是 90 秒（不是 0，也不是 300）：
 *    平台对**同一出口 IP 的请求量**有硬上限，实测 109 台/分钟就会整片 TCP 超时。
 *    一轮全量 = 109 台 ÷ PILE_CONCURRENCY 6 ≈ 18 秒。
 *    · 门槛 0    → 每次打开/手点都全量回源，多人同时用就是 200+ 台/分钟 → 必被限流；
 *    · 门槛 90 秒 → 最坏 109 台/90 秒 ≈ 72 台/分钟，安全区；
 *      而且用户看到的最差时间就是「1 分钟前」（真有人在 90 秒内刚查过，数据确实新）。
 *
 * 🔴 再加一道「全站回源预算」防雪崩，但**不能用锁**：
 *    页面把 109 台切成 12 台一批、两条流水线，一轮会发 9~10 个批次到同一个 Worker。
 *    第一版我用「一把全局锁 + 20 秒 TTL」→ 第一批回源时占锁，**后面 9 批全被自己的锁挡住**
 *    （实测日志：`fetched=12` 之后连着 7 行 `locked`，那一轮只有 12 台真的变新）。
 *    教训：锁的粒度与请求的粒度不一致时，锁会挡住自己人。
 *
 *    改成**按分钟桶计数**：全站每分钟最多回源 PILE_FRESH_BUDGET 台，
 *    预算没用完就正常回源（同一轮的 10 批都能跑完），用完了才降级。
 *    计数放 Cache API（`pileHits` 那种内存 Map 跨 isolate 不共享）。
 *    读-改-写有极小竞态，但这里要的是「总量别失控」，不是精确配额。
 *    预算被用完时**不返回 error**：给 `throttled: true` 让页面沿用本地缓存并说明原因，
 *    返回 error 会被页面当成「平台没响应」，连续几台就整轮放弃。 */
const PILE_FRESH_MIN = 90;       // fresh 请求：缓存比这新就直接用（秒）
const PILE_FRESH_BUDGET = 240;   // 全站每分钟最多回源多少台（一轮全量 109 台 ≈ 2.2 轮）

/* 🔴 平台对**同一出口 IP 的并发**有硬上限，实测（2026-10-24）：
 *     单批 20 台并发 → 1857ms，20/20 成功
 *     30 并发       → 约 1/3 报「8 秒超时」
 *     40 并发       → 只有 3 台成功，37 台超时
 * 所以下面**不能**用 Promise.all 一把梭：那等于把「出口 IP 被限流」原封不动
 * 搬到 Cloudflare 出口上重演一遍 —— 页面会看到「连续 3 台没响应」然后整轮放弃。 */
const PILE_CONCURRENCY = 6;
const PILE_HEADERS = {
  'content-type': 'application/json',
  'sd-version': '127',
  'sd-env': 'production',
  'app-source': 'jd',
  'zm-origin': '1',
};

const pileHits = new Map();
function pileTooMany(ip) {
  const now = Date.now();
  const rec = pileHits.get(ip) || { n: 0, t: now };
  if (now - rec.t > 60000) { rec.n = 0; rec.t = now; }
  rec.n += 1;
  pileHits.set(ip, rec);
  return rec.n > PILE_RATE;
}

/** 按并发上限跑异步任务，结果与 items 同序。用来替代「一次性全并发」。 */
async function mapLimit(items, limit, fn) {
  const out = new Array(items.length);
  let cursor = 0;
  const worker = async () => {
    while (cursor < items.length) {
      const k = cursor++;
      out[k] = await fn(items[k], k);
    }
  };
  const n = Math.max(1, Math.min(limit, items.length));
  await Promise.all(Array.from({ length: n }, worker));
  return out;
}

/** 单台真打平台。只返回结构化结果，不抛异常。 */
async function pileScan(id, token) {
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), 8000);
  try {
    const res = await fetch(PILE_API + PILE_SCAN, {
      method: 'POST',
      headers: { ...PILE_HEADERS, authorization: 'Bearer ' + token },
      body: JSON.stringify({ out_number: id }),
      signal: ctrl.signal,
    });
    if (res.status === 401 || res.status === 403) return { error: '凭证已失效', auth: true };
    if (!res.ok) return { error: '平台没响应（HTTP ' + res.status + '）' };
    let data;
    try { data = await res.json(); } catch (e) { return { error: '平台没响应（返回格式异常）' }; }
    if (data.code === 401 || data.code === 403) return { error: '凭证已失效', auth: true };
    if (data.code !== 200) return { error: data.message || ('平台返回 ' + data.code) };
    const slots = data && data.data && data.data.slotsData;
    if (!Array.isArray(slots) || !slots.length) return { error: '平台没返回插座数据' };
    return {
      ports: slots
        .map((s) => ({ num: Number(s.slotId), state: Number(s.status) }))
        .filter((s) => Number.isFinite(s.num))
        .sort((a, b) => a.num - b.num),
    };
  } catch (e) {
    return { error: '平台没响应（8 秒超时）' };
  } finally {
    clearTimeout(timer);
  }
}

function pileCacheKey(origin, id) {
  return origin + '/__pile/' + encodeURIComponent(id);
}

async function handlePile(request, url) {
  if (request.method !== 'POST') return json({ ok: false, error: 'method_not_allowed' }, 405);

  /* 只接受本站页面发来的请求。挡掉「拿这个端点当免费代理刷平台」的用法 ——
   * 那种用法会把 Cloudflare 出口也搞进风控，把所有人一起拖下水。 */
  const origin = request.headers.get('origin') || '';
  if (origin && origin !== url.origin) return json({ ok: false, error: 'bad_origin' }, 403);

  let body;
  try { body = await request.json(); } catch (e) { return json({ ok: false, error: 'bad_json' }, 400); }

  const token = body && typeof body.token === 'string' ? body.token : '';
  if (!token || token.length < 20 || token.length > 4096) return json({ ok: false, error: 'no_token' }, 400);

  const ids = Array.isArray(body.ids)
    ? body.ids.filter((x) => typeof x === 'string' && /^[A-Za-z0-9_-]{4,32}$/.test(x))
    : [];
  if (!ids.length) return json({ ok: false, error: 'no_ids' }, 400);
  if (ids.length > PILE_MAX_IDS) return json({ ok: false, error: 'too_many_ids', max: PILE_MAX_IDS }, 400);

  const ip = clientIp(request);
  if (pileTooMany(ip)) return json({ ok: false, error: 'rate_limited' }, 429);

  /* `fresh` = 用户明确要「现在这一刻」。缺省 false → 与旧版页面完全一致的行为。 */
  const wantFresh = body && body.fresh === true;

  const cache = caches.default;
  const results = {};
  const missIds = [];
  let usedCache = 0;             // 本次直接沿用了多少台缓存（供页面判断「是不是真更新了」）
  let oldestAge = 0;             // 沿用缓存里最旧的那台的年龄（秒）

  for (const id of ids) {
    let hit = null;
    try { hit = await cache.match(new Request(pileCacheKey(url.origin, id))); } catch (e) { hit = null; }
    if (hit) {
      try {
        const rec = await hit.json();
        const at = Number(rec && rec.at) || 0;
        const age = at ? (Date.now() - at) / 1000 : PILE_TTL + 1;
        /* 普通请求：命中就用（老行为）。
         * fresh 请求：只有「本来就够新」才用 —— 否则归到 miss 去回源。 */
        if (!wantFresh || age <= PILE_FRESH_MIN) {
          results[id] = rec;
          usedCache += 1;
          if (age > oldestAge) oldestAge = age;
          continue;
        }
      } catch (e) { /* 缓存坏了就当作没命中，重新取 */ }
    }
    missIds.push(id);
  }

  /* 全站回源预算：每分钟一个桶，跨 isolate 用 Cache API 计数。
   * 预算够 → 正常回源；不够 → 只回源补得上的那几台，其余沿用现有结果。 */
  let throttled = false;
  if (wantFresh && missIds.length) {
    const bucket = Math.floor(Date.now() / 60000);
    const bkey = new Request(url.origin + '/__pile_budget/' + bucket);
    let used = 0;
    try {
      const r = await cache.match(bkey);
      if (r) used = Number(await r.text()) || 0;
    } catch (e) { used = 0; }
    const allow = Math.max(0, PILE_FRESH_BUDGET - used);
    if (missIds.length > allow) {
      throttled = true;
      /* 前 allow 台照常回源，剩下的降级（splice 返回被切掉的尾部） */
      const demoted = missIds.splice(allow);
      for (const id of demoted) {
        let keep = null;
        try {
          const h = await cache.match(new Request(pileCacheKey(url.origin, id)));
          if (h) keep = await h.json();
        } catch (e) { keep = null; }
        if (keep) { results[id] = keep; usedCache += 1; }
        else results[id] = { at: 0, throttled: true, error: '刚才查询的人太多了，几秒后再点一次刷新' };
      }
    }
    /* 先占预算（含被切掉之前的那部分）—— 宁可多算，别让并发的另一轮也冲进来 */
    try {
      await cache.put(bkey, new Response(String(used + Math.min(missIds.length, allow)), {
        headers: { 'cache-control': 'public, max-age=90' },
      }));
    } catch (e) { /* 预算写失败不影响本次请求 */ }
  }

  const rows = await mapLimit(missIds, PILE_CONCURRENCY, async (id) => [id, await pileScan(id, token)]);
  let fetched = 0;
  let authFail = 0;

  for (const [id, rec] of rows) {
    if (rec && rec.ports) {
      fetched += 1;
      const payload = { at: Date.now(), ports: rec.ports };
      results[id] = payload;
      try {
        await cache.put(
          new Request(pileCacheKey(url.origin, id)),
          new Response(JSON.stringify(payload), {
            headers: { 'content-type': 'application/json', 'cache-control': 'public, max-age=' + PILE_TTL },
          }),
        );
      } catch (e) { /* 缓存写失败不影响返回 */ }
    } else {
      if (rec && rec.auth) authFail += 1;
      /* ⚠️ 失败**不写缓存**：平台抖一下就该立刻重试，不能把失败钉死 5 分钟。 */
      results[id] = { at: 0, error: (rec && rec.error) || '平台没响应', auth: !!(rec && rec.auth) };
    }
  }

  return json({
    ok: true,
    results,
    hit: usedCache,
    fetched,
    authFail,
    fresh: wantFresh,
    throttled,
    oldestAge: Math.round(oldestAge),
  });
}


/* ---------------- 站点汇总代理（/api/shop） ----------------
 *
 * 页面自动刷新只打这一个接口，拿到「全校实时空闲口数」。
 * 比逐台查便宜两个数量级：1 个请求 vs 109 个，再加 5 分钟边缘缓存 →
 * 全校所有人在同一时段看到的其实是**同一份结果**，回源平台最多每 5 分钟 1 次。
 *
 * 平台接口：POST /api/shop/info {"shopId":"SDXA241610027"}
 *   → data.available = 实时空闲口数（可信）
 *   → data.total 恒为 "0"，**不能用**，所以这里不返回 total
 */
const SHOP_PATH = '/api/shop/info';
const SHOP_TTL = 300;            // 边缘缓存秒数，与逐台缓存对齐
const SHOP_RATE = 30;            // 单 IP 每分钟最多几次

/* fresh（用户点刷新）时的年龄门槛。
 * 这个接口只回源**一个**请求，成本远低于逐台，所以门槛可以比 PILE_FRESH_MIN 小：
 * 20 秒内刚有人查过，那份结果就是「此刻」，没必要再打一次。
 * 超过 20 秒就真回源 —— 用户点刷新后那条「全站实时空闲」细条的时间戳必须真的变新。 */
const SHOP_FRESH_MIN = 20;

const shopHits = new Map();
function shopTooMany(ip) {
  const now = Date.now();
  const rec = shopHits.get(ip) || { n: 0, t: now };
  if (now - rec.t > 60000) { rec.n = 0; rec.t = now; }
  rec.n += 1;
  shopHits.set(ip, rec);
  return rec.n > SHOP_RATE;
}

async function shopFetch(shopId, token) {
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), 8000);
  try {
    const res = await fetch(PILE_API + SHOP_PATH, {
      method: 'POST',
      headers: { ...PILE_HEADERS, authorization: 'Bearer ' + token },
      body: JSON.stringify({ shopId }),
      signal: ctrl.signal,
    });
    if (res.status === 401 || res.status === 403) return { error: '凭证已失效', auth: true };
    if (!res.ok) return { error: '平台没响应（HTTP ' + res.status + '）' };
    let data;
    try { data = await res.json(); } catch (e) { return { error: '平台没响应（返回格式异常）' }; }
    if (data.code === 401 || data.code === 403) return { error: '凭证已失效', auth: true };
    if (data.code !== 200) return { error: data.message || ('平台返回 ' + data.code) };
    const n = data && data.data ? Number(data.data.available) : NaN;
    if (!Number.isFinite(n)) return { error: '平台没返回空闲数' };
    return { available: n };
  } catch (e) {
    return { error: '平台没响应（8 秒超时）' };
  } finally {
    clearTimeout(timer);
  }
}

async function handleShop(request, url) {
  if (request.method !== 'POST') return json({ ok: false, error: 'method_not_allowed' }, 405);

  const origin = request.headers.get('origin') || '';
  if (origin && origin !== url.origin) return json({ ok: false, error: 'bad_origin' }, 403);

  let body;
  try { body = await request.json(); } catch (e) { return json({ ok: false, error: 'bad_json' }, 400); }

  const token = body && typeof body.token === 'string' ? body.token : '';
  if (!token || token.length < 20 || token.length > 4096) return json({ ok: false, error: 'no_token' }, 400);

  const shopId = body && typeof body.shopId === 'string' ? body.shopId : '';
  if (!/^[A-Za-z0-9_-]{4,32}$/.test(shopId)) return json({ ok: false, error: 'bad_shop' }, 400);

  if (shopTooMany(clientIp(request))) return json({ ok: false, error: 'rate_limited' }, 429);

  const wantFresh = body && body.fresh === true;
  const cache = caches.default;
  const key = new Request(url.origin + '/__shop/' + encodeURIComponent(shopId));
  try {
    const hit = await cache.match(key);
    if (hit) {
      const cached = await hit.json();
      if (cached && Number.isFinite(Number(cached.available))) {
        /* 缓存年龄。旧的缓存 payload 可能没有 at → 当成过期，让它回源一次。 */
        const age = cached.at ? (Date.now() - Number(cached.at)) / 1000 : SHOP_TTL + 1;
        if (!wantFresh || age <= SHOP_FRESH_MIN) {
          return json({
            ok: true, available: Number(cached.available), at: cached.at,
            cached: true, age: Math.round(age),
          });
        }
      }
    }
  } catch (e) { /* 缓存读失败就当没命中 */ }

  const rec = await shopFetch(shopId, token);
  if (rec && Number.isFinite(rec.available)) {
    const payload = { at: Date.now(), available: rec.available };
    try {
      await cache.put(key, new Response(JSON.stringify(payload), {
        headers: { 'content-type': 'application/json', 'cache-control': 'public, max-age=' + SHOP_TTL },
      }));
    } catch (e) { /* 缓存写失败不影响返回 */ }
    return json({ ok: true, available: payload.available, at: payload.at, cached: false, age: 0 });
  }

  /* 失败不写缓存（同 /api/pile 的理由），并把 auth 透给页面，好触发换凭证那条路。 */
  return json({ ok: false, error: (rec && rec.error) || '平台没响应', auth: !!(rec && rec.auth) }, 502);
}


// 失败计数只在单个 isolate 内存里，属于「顺手挡一下暴力猜口令」，不是安全边界
const fails = new Map();

function json(obj, status = 200) {
  return new Response(JSON.stringify(obj), {
    status,
    headers: {
      'content-type': 'application/json; charset=utf-8',
      'cache-control': 'no-store, max-age=0',
      'x-content-type-options': 'nosniff',
    },
  });
}

/** 定长比较：先各自 SHA-256，再逐字节异或，避免长度/前缀泄漏 */
async function safeEqual(a, b) {
  if (typeof a !== 'string' || typeof b !== 'string' || !a || !b) return false;
  const enc = new TextEncoder();
  const [x, y] = await Promise.all([
    crypto.subtle.digest('SHA-256', enc.encode(a)),
    crypto.subtle.digest('SHA-256', enc.encode(b)),
  ]);
  const xa = new Uint8Array(x);
  const ya = new Uint8Array(y);
  let diff = 0;
  for (let i = 0; i < xa.length; i += 1) diff |= xa[i] ^ ya[i];
  return diff === 0;
}

function clientIp(request) {
  return request.headers.get('cf-connecting-ip') || 'unknown';
}

function tooMany(ip) {
  const rec = fails.get(ip);
  if (!rec) return false;
  if (Date.now() - rec.at > FAIL_WINDOW_MS) {
    fails.delete(ip);
    return false;
  }
  return rec.n >= MAX_FAILS;
}

function bumpFail(ip) {
  const rec = fails.get(ip);
  if (!rec || Date.now() - rec.at > FAIL_WINDOW_MS) fails.set(ip, { n: 1, at: Date.now() });
  else rec.n += 1;
}

export default {
  async fetch(request, env) {
    const url = new URL(request.url);
    const path = url.pathname.replace(/\/+$/, '') || '/';

    // ---- 自检端点：配完绑定后打开这个 URL 就能确认通没通 ----
    if (path === '/api/ping') {
      // 只回「变量名」，不回值：能区分「名字拼错」和「这个环境里压根没有」
      const hints = Object.keys(env || {}).filter((k) => /admin|token|pass|secret/i.test(k));
      return json({
        ok: true,
        kv: !!env.CHD_CRED,          // false = KV 绑定没加或没生效（需重新部署）
        token: !!env.ADMIN_TOKEN,    // false = ADMIN_TOKEN 没设
        hints,                       // 形如 ["ADMIN_TOKEN"]；空数组 = 当前环境没有这个变量
        ts: Date.now(),
      });
    }

    // ---- 平台查询代理：批量代打 + 边缘缓存（见文件上方注释） ----
    if (path === '/api/pile') return handlePile(request, url);
    if (path === '/api/shop') return handleShop(request, url);

    if (path !== '/api/cred') return json({ ok: false, error: 'not_found' }, 404);

    if (!env.CHD_CRED) return json({ ok: false, error: 'kv_not_bound' }, 501);

    // ---- 读：任何人都能读，但读到的是密文 ----
    if (request.method === 'GET' || request.method === 'HEAD') {
      const raw = await env.CHD_CRED.get(KEY);
      if (!raw) return json({ ok: true, exists: false });
      let parsed;
      try {
        parsed = JSON.parse(raw);
      } catch (e) {
        return json({ ok: false, error: 'corrupt' }, 500);
      }
      return json({
        ok: true,
        exists: true,
        updatedAt: parsed.updatedAt || 0,
        note: parsed.note || '',
        data: parsed.data,
      });
    }

    // ---- 写：必须带写口令 ----
    if (request.method === 'POST') {
      if (!env.ADMIN_TOKEN) return json({ ok: false, error: 'token_not_set' }, 501);

      const ip = clientIp(request);
      if (tooMany(ip)) return json({ ok: false, error: 'too_many_attempts' }, 429);

      const given = request.headers.get('x-admin-token') || '';
      if (!(await safeEqual(given, env.ADMIN_TOKEN))) {
        bumpFail(ip);
        return json({ ok: false, error: 'bad_token' }, 401);
      }
      fails.delete(ip);

      let body;
      try {
        body = await request.json();
      } catch (e) {
        return json({ ok: false, error: 'bad_json' }, 400);
      }
      const data = body && body.data;
      if (typeof data !== 'string' || !data.trim()) {
        return json({ ok: false, error: 'empty_data' }, 400);
      }
      if (data.length > MAX_BODY) return json({ ok: false, error: 'too_large' }, 413);

      const payload = {
        v: 1,
        updatedAt: Date.now(),
        note: typeof body.note === 'string' ? body.note.slice(0, 200) : '',
        data,
      };
      await env.CHD_CRED.put(KEY, JSON.stringify(payload));
      return json({ ok: true, updatedAt: payload.updatedAt });
    }

    return json({ ok: false, error: 'method_not_allowed' }, 405);
  },
};

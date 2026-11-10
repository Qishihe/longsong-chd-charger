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
 * 🔴 2026-10-27 改版：**凭证不再下发给浏览器**。
 *
 *    改之前：KV 存密文 → `/api/cred` 把密文给浏览器 → 浏览器用自己的 key 解 → 直连平台。
 *            问题在于解密 key 是硬编码在 index.html 里的，等于公开；加上浏览器必须
 *            把 `Authorization: Bearer <token>` 发出去，F12 一眼就能抄走。
 *
 *    改之后：KV 里多存一份**明文**（独立键 `cred_tok`，只有本文件读，任何路由都不返回）；
 *            `/api/pile` 缺 `body.token` 时自己取、自己转发 → 凭证一次都不进浏览器。
 *            `/api/cred` 只回 `{updatedAt, expiresAt}` 这类元数据。
 *
 *    密文那份（`cred`）继续双写：留给旧页面做回退，也留一条「浏览器端解密」的后路。
 *    两份的键分开存是有意的 —— 万一同一个值里塞字段，哪天改返回体就会顺手带出去。
 */

const KEY = 'cred';           // KV 里的键名（元数据 + 密文，可公开读）
const KEY_TOK = 'cred_tok';   // 明文凭证，**只在 Worker 内部读**，绝不出现在任何响应里
/* 自动续期的**运行结果**（2026-11-06 v3.05）。单独一个键，不塞进 `cred`：
 *   · `cred` 每次换证整体覆盖，续期结果夹在里面会被顺手抹掉；
 *   · 这个键要让页面读得到（区分「过期了但续期正在处理」和「过期了、续期一直失败」），
 *     一旦混进 `cred`，改返回体时很容易连密文一起带出去。
 * 写入频率很低：未过期时 cred_autorenew 静默退出、根本不上报，只有真过期那几天才写。 */
const KEY_RENEW = 'cred_renew';
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
 *   · 浏览器只发 9~10 个批量请求（109 台 ÷ 12），而不是 109 个。
 *
 * 🔴 单次调用的「子请求」怎么记账（2026-10-29 实测纠正，之前算错过一次）：
 *
 *    免费版上限 50 个。以前只把「每台一次 fetch」算进去，于是 PILE_MAX_IDS
 *    定成 40 —— 漏了 **Cache API 的每一次 match/put 也各算 1 个**。
 *
 *    一次 fresh 批量请求的真实开销（N = 本批台数）：
 *        N    次 cache.match  ← 逐台查「这份缓存还新吗」
 *      + 2    次预算桶读写    ← 读已用量 + 写回已用量
 *      + N    次 fetch        ← 真打平台
 *      + N    次 cache.put    ← 写回结果
 *    = 3N + 2
 *
 *    （撞预算被降级时不会 fetch/put，但那几台在「降级时读一次」和「跑完再读
 *     一次」各多出 1 次 match，加起来仍然是 3N + 2 —— 这个式子没有分支。）
 *
 * 事故现场（就是算错这个数导致的）：北门 37 台 → 37 + 2 = 39 个子请求，
 * 只剩 11 个 fetch 名额，**前 11 台成功、第 12 台起全部拿「8 秒超时」**；
 * 30 台一批则恰好 18 台成功（50 − 32），两次都精确对上。
 * 页面一直没事，是因为它本来就按 12 台一批发（38 < 50）。
 *
 * 所以上限取 **14**（3×14+2 = 44，留 6 个余量）。超了直接 400 报错，
 * 别让调用方拿到一份「缺一半且看起来正常」的结果 —— 静默残缺比报错难查得多。
 */
const PILE_API = 'https://union.zhumanggroup.com';
const PILE_SCAN = '/api/rent/scan-code';
const PILE_TTL = 300;            // 边缘缓存秒数（普通请求的上界）
const PILE_MAX_IDS = 14;         // = 3N+2 ≤ 50 解出来的安全上界（见上），别再按「台数」放宽
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
 * 🔴 门槛 2026-10-29 从 90 秒降到 60 秒（产品要求：「数据满 1 分钟就允许手动刷」）。
 *    平台对**同一出口 IP 的请求量**有硬上限，实测 109 台/分钟就会整片 TCP 超时。
 *    一轮全量 = 109 台 ÷ PILE_CONCURRENCY 6 ≈ 18 秒。
 *    · 门槛 0    → 每次打开/手点都全量回源，多人同时用就是 200+ 台/分钟 → 必被限流；
 *    · 门槛 90 秒 → 最坏 109 台/90 秒 ≈ 72 台/分钟，很安全，但用户要等 1 分半；
 *    · 门槛 60 秒 → 单用户最坏 109 台/分钟，**正好压在那条限流线上**。
 *      所以必须三个改动一起上，少一个都不安全：
 *        ① 预算从 240 收紧到 160（1.5 轮全量）→ 第二个人同时刷会被 throttled；
 *        ② 页面侧加 60 秒手动刷新间隔（MIN_MANUAL_GAP_MS）→ 挡住连点；
 *        ③ 门槛本身只作用于 `fresh:true`，自动刷新/补查走的还是老路径。
 *    只降门槛、不动预算，等于把风控口子敞开 —— 别拆开单独改。
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
const PILE_FRESH_MIN = 60;       // fresh 请求：缓存比这新就直接用（秒）
const PILE_FRESH_BUDGET = 160;   // 全站每分钟最多回源多少台（一轮全量 109 台 ≈ 1.5 轮）
/* 🔴 v2.68：内部调度（快照站整点采样，带 x-snap-key）走**自己的桶**，不跟访客抢。
 *
 * 以前共用 160/分：人多的时候快照这边整批被降级成 `throttled`，快照记成 `busy` →
 * 那一格没入账 → 一周回顾缺格。2026-10-31 修的「某区某时段没记录」有两条入口，
 * 这是第二条 —— 采样被自家访客饿死。
 *
 * 采样量是固定的（5 个区，每区一轮 40 台上下的设备，分散在 :00~:05 几条 cron），
 * 320 有足够余量；上限不是「为了省平台额度」，纯粹是防「快照自己跑飞」，
 * 真正的红线在 `PILE_CONCURRENCY` 与每批台数那两处。 */
const PILE_FRESH_BUDGET_INTERNAL = 320;

/* 🔴 平台对**同一出口 IP 的并发**有硬上限，实测（2026-10-24）：
 *     单批 20 台并发 → 1857ms，20/20 成功
 *     30 并发       → 约 1/3 报「8 秒超时」
 *     40 并发       → 只有 3 台成功，37 台超时
 * 所以下面**不能**用 Promise.all 一把梭：那等于把「出口 IP 被限流」原封不动
 * 搬到 Cloudflare 出口上重演一遍 —— 页面会看到「连续 3 台没响应」然后整轮放弃。 */
/* ---------------- 第二个数据源：驴充充（渭水校区住宅区 8 台） ----------------
 *
 * 2026-10-31 v2.63 新增。住宅区那 8 台桩**不在住芒平台上**，是「驴充充」自己的机器，
 * 接口完全两套：
 *     POST https://appapi.lvcchong.com/portDetail?channelMessage=LVCC-WP-PH_15.0.1_Tencent-G9
 *     body: simId=<15 位 simId>&mapType=2&chargeTypeTag=0&appEntrance=2&entrance=2&version=new
 *     → data.device：portNumber / freePortCount / lat / lng / address / online …
 *     → data.ports：**下标 0 是占位符**，真实插座从下标 1 开始；
 *                    0 = 空闲，1 = 占用，-1 = 异常
 *
 * 为什么也走这个 Worker、而不是让浏览器直连：
 *   · 它的响应确实带 `Access-Control-Allow-Origin: *`（浏览器能直连），
 *     但那样每个访客都得自己打一次平台 —— 吃各自出口 IP 的信誉，也没有共享缓存；
 *   · 走这里 = 出口换成 Cloudflare 边缘 + 5 分钟缓存，全校共享同一份结果。
 *
 * 🔴 **它不需要任何凭证**（接口本身无鉴权），所以 `src === 'lvcc'` 的请求要跳过
 *    `serverToken()` 那一段 —— 否则「凭证没接上」会被误栽到这批桩身上：
 *    那时候页面会把 8 台住宅区桩全部标红，看着像桩坏了，其实跟凭证毫无关系。
 */
const LVCC_API = 'https://appapi.lvcchong.com/portDetail?channelMessage=LVCC-WP-PH_15.0.1_Tencent-G9';

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
/* ---------------- 服务端凭证读取 ----------------
 *
 * 只给 `/api/pile` 和 `/api/shop` 用。**不存在任何把它吐出去的路由** —— 这是本轮改版的
 * 全部意义所在，以后加路由时不要读 KEY_TOK。
 *
 * 过期就当作没有：宁可让页面拿到 `no_token` 去提示站长换证，也别拿一串死 token 打平台 ——
 * 那会把「凭证过期」伪装成「平台抽风」，排查起来要多绕好几圈。
 */
async function serverToken(env) {
  if (!env || !env.CHD_CRED) return '';
  try {
    const raw = await env.CHD_CRED.get(KEY_TOK);
    if (!raw) return '';
    const rec = JSON.parse(raw);
    const tok = typeof rec.token === 'string' ? rec.token.trim() : '';
    if (!tok) return '';
    const exp = Number(rec.exp) || 0;
    if (exp && Date.now() / 1000 > exp) return '';
    return tok;
  } catch (e) {
    return '';
  }
}

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

function pileCacheKey(origin, id, src) {
  /* 两个源的 id 空间不重叠（住芒是 XLA… / 驴充充是 15 位数字），但仍然分键存 ——
     万一同一个 id 将来两边都有，共用一条缓存会互相覆盖，而且 `at` 戳一混就查不出来。 */
  return origin + (src === 'lvcc' ? '/__pile_lvcc/' : '/__pile/') + encodeURIComponent(id);
}

/** 单台驴充充设备。返回结构与 `pileScan()` 完全一致（失败也不抛异常）。
 *
 *  口径转换（页面只认 `{num, state}`，`state === 0` 才算空闲）：
 *     驴充充 0  → 0（空闲）
 *     驴充充 1  → 1（占用）
 *     驴充充 -1 → 2（异常）：**不原样透传 -1** —— 负值在下游看起来像「未知状态」，
 *                而这里的事实是「这口坏了/被禁用」，按占用处理才对（不能让人以为能充）。 */
async function lvccScan(simId) {
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), 8000);
  try {
    const body = new URLSearchParams({
      simId,
      mapType: '2',
      chargeTypeTag: '0',
      appEntrance: '2',
      entrance: '2',
      version: 'new',
    }).toString();
    const res = await fetch(LVCC_API, {
      method: 'POST',
      headers: { 'content-type': 'application/x-www-form-urlencoded' },
      body,
      signal: ctrl.signal,
    });
    if (!res.ok) return { error: '平台没响应（HTTP ' + res.status + '）' };
    let data;
    try { data = await res.json(); } catch (e) { return { error: '平台没响应（返回格式异常）' }; }
    if (Number(data.code) !== 200) return { error: data.message || ('平台返回 ' + data.code) };
    const d = data.data || {};
    const dev = d.device || {};
    const raw = Array.isArray(d.ports) ? d.ports : [];
    if (!raw.length) return { error: '平台没返回插座数据' };
    const declare = Number(dev.portNumber) || 0;
    /* 取两者较大值：`ports` 是实际下发的（20 口机就是 21 个元素），
       `portNumber` 是平台登记的口数。任一缺失都不该让格子凭空少一行。 */
    const total = Math.max(declare, raw.length - 1);
    const ports = [];
    for (let n = 1; n <= total; n++) {
      const v = Number(raw[n]);
      ports.push({ num: n, state: v === 0 ? 0 : (v === 1 ? 1 : 2) });
    }
    return { ports };
  } catch (e) {
    return { error: '平台没响应（8 秒超时）' };
  } finally {
    clearTimeout(timer);
  }
}

/* ---------------- 来源校验 ----------------
 * 只接受本站页面发来的请求。挡掉「拿这个端点当免费代理刷平台」的用法 ——
 * 那种用法会把 Cloudflare 出口也搞进风控，把所有人一起拖下水。
 *
 * 🔴 2026-10-27 晚收紧：以前写的是 `if (origin && origin !== url.origin) 拒`，
 * 等于**没带 Origin 的一律放行** —— curl、Python、任何脚本都能直接 POST。
 * 后果不是凭证泄漏（凭证在服务端），是平台对**同一个出口 IP** 的风控被刷爆：
 * 实测每分钟 109 台就会整片 TCP 超时，全站一起挂，页面只表现为「一直转」。
 *
 * 现在的判定：Origin 优先；缺了退到 Referer 的 origin 部分；两者都没有 = 不是浏览器，拒。
 * 同源 POST 一定带 Origin（我们的请求是 JSON body，属非简单请求），所以站点自身不受影响。
 *
 * 放行 localhost：本地预览要经 `serve_gzip.py` 反代到这里，origin 是 127.0.0.1，
 * 与线上同源检查天然不符；这个口子只对站长本机有效，不构成外泄面。
 */
const LOCAL_ORIGIN_RE = /^https?:\/\/(127\.0\.0\.1|localhost)(:\d+)?$/;

function requestOrigin(request) {
  const direct = request.headers.get('origin') || '';
  if (direct) return direct;
  const ref = request.headers.get('referer') || request.headers.get('referrer') || '';
  if (!ref) return '';
  try { return new URL(ref).origin; } catch (e) { return ''; }
}

function sameSiteRequest(request, url) {
  const origin = requestOrigin(request);
  if (!origin) return false;                 // 非浏览器调用（curl / 脚本 / 服务端对服务端）
  if (LOCAL_ORIGIN_RE.test(origin)) return true;
  return origin === url.origin;
}

async function handlePile(request, url, env) {
  if (request.method !== 'POST') return json({ ok: false, error: 'method_not_allowed' }, 405);

  /* 内部调度器（chd-snap Worker）：带对了密钥就放行，绕过同源检查。
   * 服务器到服务器没有 Origin/Referer，而 Workers 的 fetch 里这两个头属于
   * 受限头，设了也可能被剥掉 —— 所以走显式密钥通道。
   * 没设 SNAP_KEY 时这段等于不存在，行为与之前完全一致。 */
  const snapKey = request.headers.get('x-snap-key') || '';
  const internal = !!(env && env.SNAP_KEY && snapKey && snapKey === env.SNAP_KEY);
  if (!internal && !sameSiteRequest(request, url)) return json({ ok: false, error: 'bad_origin' }, 403);

  let body;
  try { body = await request.json(); } catch (e) { return json({ ok: false, error: 'bad_json' }, 400); }

  /* 数据源（v2.63）：`zm` = 住芒（默认，要凭证）/ `lvcc` = 驴充充（无鉴权）。
     页面按设备所属平台**分会话**发送，一批里不会混两个源，
     所以这里只要一个开关，不用逐个 id 判。 */
  const src = body && body.src === 'lvcc' ? 'lvcc' : 'zm';

  /* 优先用请求里带的（站长粘贴 / 本机覆盖），没带就取服务端的。
   * 访客走的永远是后一条 —— 浏览器从头到尾不知道 token 长什么样。
   * 🔴 驴充充那条路直接跳过整段：它没有鉴权，拿「凭证没接上」拦它只会
   *    让住宅区 8 台全变红，而原因完全无关。 */
  let token = body && typeof body.token === 'string' ? body.token.trim() : '';
  let fromServer = false;
  if (src !== 'lvcc') {
    if (!token) { token = await serverToken(env); fromServer = true; }
    if (!token || token.length < 20 || token.length > 4096) {
      return json({
        ok: false,
        error: 'no_token',
        hint: fromServer ? 'server_token_missing' : 'bad_client_token',
      }, 400);
    }
  }

  const ids = Array.isArray(body.ids)
    ? body.ids.filter((x) => typeof x === 'string' && /^[A-Za-z0-9_-]{4,32}$/.test(x))
    : [];
  if (!ids.length) return json({ ok: false, error: 'no_ids' }, 400);
  /* 超上限就当场拒绝，**绝不悄悄截断**：截断后的结果看起来完全正常，
   * 调用方会把「只拿到一半」当成「另一半的平台挂了」，然后写进统计里。
   * 2026-10-29 之前上限是 40，北门 37 台就是被子请求额度悄悄截掉的。 */
  if (ids.length > PILE_MAX_IDS) {
    return json({
      ok: false,
      error: 'too_many_ids',
      max: PILE_MAX_IDS,
      hint: 'free plan allows 50 subrequests per invocation; each id costs 3 (cache.match + fetch + cache.put) plus 2 for the budget bucket — split into batches of <= ' + PILE_MAX_IDS,
    }, 400);
  }

  const ip = clientIp(request);
  /* 内部调度不吃这道闸（v2.68）：它的出口是 Cloudflare 自己的 IP，跟「人当代理刷」
   * 无关；更实际的是，快照站一轮要连发 5~8 批，碰上有人刷就一起被挡，
   * 结果是一周回顾掉格子（见 PILE_FRESH_BUDGET_INTERNAL 上方注释）。 */
  if (!internal && pileTooMany(ip)) return json({ ok: false, error: 'rate_limited' }, 429);

  /* `fresh` = 用户明确要「现在这一刻」。缺省 false → 与旧版页面完全一致的行为。 */
  const wantFresh = body && body.fresh === true;

  const cache = caches.default;
  const results = {};
  const missIds = [];
  let usedCache = 0;             // 本次直接沿用了多少台缓存（供页面判断「是不是真更新了」）
  let oldestAge = 0;             // 沿用缓存里最旧的那台的年龄（秒）

  for (const id of ids) {
    let hit = null;
    try { hit = await cache.match(new Request(pileCacheKey(url.origin, id, src))); } catch (e) { hit = null; }
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
   * 预算够 → 正常回源；不够 → 只回源补得上的那几台，其余沿用现有结果。
   * 🔴 只有住芒要走这道闸（v2.63）：预算是为「住芒对同一出口 IP 的请求量有硬上限」设的，
   *    驴充充没有这层约束，把它的台数也算进去只会白白占掉住芒的额度。 */
  let throttled = false;
  /* 因预算不足被降级的台（2026-10-29 加）。这些 id 在本轮回源跑完之后要**再读一次
   * 缓存**，原因见下面 `recovered` 那段。 */
  const demotedIds = [];
  if (wantFresh && missIds.length && src !== 'lvcc') {
    const bucket = Math.floor(Date.now() / 60000);
    /* 内部调度单独一个桶（v2.68）：`/__pile_budget/snap/<分钟>`。
     * 键分开之后两边的读写互不相干 —— 访客刷得再猛，快照的整点采样照样有额度。 */
    const bkey = new Request(url.origin + '/__pile_budget/' + (internal ? 'snap/' : '') + bucket);
    let used = 0;
    try {
      const r = await cache.match(bkey);
      if (r) used = Number(await r.text()) || 0;
    } catch (e) { used = 0; }
    const cap = internal ? PILE_FRESH_BUDGET_INTERNAL : PILE_FRESH_BUDGET;
    const allow = Math.max(0, cap - used);
    if (missIds.length > allow) {
      throttled = true;
      /* 前 allow 台照常回源，剩下的降级（splice 返回被切掉的尾部） */
      const demoted = missIds.splice(allow);
      for (const id of demoted) {
        demotedIds.push(id);
        let keep = null;
        try {
          const h = await cache.match(new Request(pileCacheKey(url.origin, id, src)));
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

  /* 按数据源派发（v2.63）。两个扫描器返回结构一致，下游一行都不用改。 */
  const scanOne = src === 'lvcc' ? (id) => lvccScan(id) : (id) => pileScan(id, token);
  const rows = await mapLimit(missIds, PILE_CONCURRENCY, async (id) => [id, await scanOne(id)]);
  let fetched = 0;
  let authFail = 0;

  /* 被降级的那几台再读一次缓存（2026-10-29 加）。
   *
   * 为什么值得单独做一次：撞预算的**典型场面是「同一分钟里另一个人也点了刷新」**。
   * 他那一轮正在把结果陆续写进 Cache API，而我们刚刚花掉的那 ~18 秒（跑自己那份
   * 份额）正好给了他时间写完。所以跑完回头看，被降级的那几台多半已经是**几秒前
   * 的新数据**了 —— 只是我们进入函数时读到的是旧的。
   *
   * 这一步是纯本地操作：一次 `cache.match`，**零上游请求、零风控风险、不占预算**。
   * 效果就是把「只能退回旧数据」变成「直接引用同一分钟内别人刚查到的结果」。
   *
   * 判据用 `at` 戳的先后（缓存里那份比手上这份新），**不比 ports 内容** ——
   * 两台都满、或两台都空是很合法的相同内容，比内容会白替换一遍还漏计 recovered。
   */
  let recovered = 0;
  for (const id of demotedIds) {
    const prevAt = Number(results[id] && results[id].at) || 0;
    let rec = null;
    try {
      const h = await cache.match(new Request(pileCacheKey(url.origin, id, src)));
      if (h) rec = await h.json();
    } catch (e) { rec = null; }
    const at = Number(rec && rec.at) || 0;
    if (rec && Array.isArray(rec.ports) && rec.ports.length && at > prevAt) {
      results[id] = rec;
      recovered += 1;
    }
  }

  for (const [id, rec] of rows) {
    if (rec && rec.ports) {
      fetched += 1;
      const payload = { at: Date.now(), ports: rec.ports };
      results[id] = payload;
      try {
        await cache.put(
          new Request(pileCacheKey(url.origin, id, src)),
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
    recovered,
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

async function handleShop(request, url, env) {
  if (request.method !== 'POST') return json({ ok: false, error: 'method_not_allowed' }, 405);

  if (!sameSiteRequest(request, url)) return json({ ok: false, error: 'bad_origin' }, 403);

  let body;
  try { body = await request.json(); } catch (e) { return json({ ok: false, error: 'bad_json' }, 400); }

  /* 与 handlePile 同一套：客户端带了就用客户端的，没带用服务端的。 */
  let token = body && typeof body.token === 'string' ? body.token.trim() : '';
  let fromServer = false;
  if (!token) { token = await serverToken(env); fromServer = true; }
  if (!token || token.length < 20 || token.length > 4096) {
    return json({
      ok: false,
      error: 'no_token',
      hint: fromServer ? 'server_token_missing' : 'bad_client_token',
    }, 400);
  }

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

/* ---------------- 快照数据反代（/api/stats、/api/snap） ----------------
 *
 * 一周回顾的数据在快照 Worker（chd-snap）里，而它挂在 *.workers.dev。
 * 不在前端直连的原因有两条：
 *   1. 跨域。要多一轮 preflight，还要给对方 Worker 加 CORS 头。
 *   2. 实测本机走代理时 workers.dev 直接 502、直连 21 秒超时 ——
 *      用户的网络环境（校园网 / 公司代理）未必都能到 workers.dev。
 * 站点 Worker 转发是「边缘到边缘」，不受用户侧网络策略影响，还天然同源。
 *
 * 转发两类：
 *   /api/stats —— 七天统计（每小时一个点，只读）
 *   /api/snap  —— 单区快照（读；带 `?refresh=1` 时可触发一次补刷）
 *
 * ⚠️ 反代 `/api/snap` 等于把它对公网开放（原先 workers.dev 基本没人到得了）。
 *    滥用上限仍受快照站自己的两道锁约束：分区锁 + 全站分钟锁，
 *    最坏是「每 120 秒一个区 37 台」—— 正是它本来就按此设计的量级。
 *
 * 🔴 快照站没部署、或 D1 还没攒到数据时必须**软失败**：
 *    回 200 + 空 points + degraded 标记。前端据此画「数据还在攒」，
 *    而不是弹红框 —— 「还没攒够七天」和「坏了」是两件完全不同的事。
 */
const SNAP_ORIGIN = 'https://chd-snap.203147001.workers.dev';

async function proxySnap(path, url, env) {
  const base = String(env.SNAP_ORIGIN || SNAP_ORIGIN).replace(/\/+$/, '');
  /* 统计点每小时才一个，5 分钟缓存足够新；快照是分钟级，60 秒。 */
  const ttl = path === '/api/stats' ? 300 : 60;
  const headers = (cache) => ({
    'content-type': 'application/json; charset=utf-8',
    'cache-control': cache,
    'x-content-type-options': 'nosniff',
  });

  try {
    /* 🔴 `refresh=1` 的请求要**真的扫上游**（5–18 秒），8 秒会把一次正常刷新
       掐断在半路：反代超时返回了，Worker 那边也随之中止，快照写不进去。
       只读请求 8 秒足够（读 1 行 D1）。22 秒 = SCAN_TIMEOUT_MS(18) + 余量。 */
    const timeoutMs =
      path === '/api/snap' && url.searchParams.get('refresh') === '1' ? 22000 : 8000;
    const res = await fetch(base + path + url.search, {
      headers: { accept: 'application/json' },
      signal:
        typeof AbortSignal !== 'undefined' && AbortSignal.timeout
          ? AbortSignal.timeout(timeoutMs)
          : undefined,
    });
    if (!res.ok) throw new Error('HTTP ' + res.status);
    const body = await res.text();
    /* 透传上游的 JSON，但缓存策略由这里定。 */
    return new Response(body, { status: 200, headers: headers(`public, max-age=${ttl}`) });
  } catch (err) {
    console.error(`[stats] 反代快照失败 ${path}：${String((err && err.message) || err)}`);
    /* 形状对齐上游，少一个字段前端就得多写一个分支。 */
    const fallback =
      path === '/api/stats'
        ? { ok: true, v: 1, points: [], degraded: 'snapshot_unavailable' }
        : { ok: false, error: 'snapshot_unavailable', degraded: 'snapshot_unavailable' };
    return new Response(JSON.stringify(fallback), {
      status: 200,
      headers: headers('public, max-age=60'),
    });
  }
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

/* ---------------- /api/cred 的**读**频控 ----------------
 *
 * 读接口原来完全不限流：写个循环就能把密文拉走存档，慢慢猜。
 * 密文本身解不开（PBKDF2 20 万轮 + AES-GCM），所以这不是「防解密」，
 * 只是把「随便拿」抬成「要费点劲拿」。
 *
 * ⚠️ 两条局限必须说清楚：
 *   1. Map 只在**单个 isolate** 的内存里，换边缘节点就是新的一份 —— 这是抬高门槛，不是硬闸门。
 *      要真闸门得上 Durable Object 或 KV 计数，但 KV 免费额度 1000 写/天，一开就爆。
 *   2. 阈值不能太低：校园网是 NAT，一大片学生共用一个出口 IP。设 20/分钟会误伤
 *      「下课时几十个人同时刷新」。60 够个人用，也够挡住无脑循环。
 */
const CRED_HITS = new Map();
const CRED_RATE = 60;              // 单 IP 每分钟最多读几次
const CRED_WINDOW_MS = 60000;

function credTooMany(ip) {
  const now = Date.now();
  const rec = CRED_HITS.get(ip) || { n: 0, t: now };
  if (now - rec.t > CRED_WINDOW_MS) { rec.n = 0; rec.t = now; }
  rec.n += 1;
  CRED_HITS.set(ip, rec);
  /* isolate 活得很久时 Map 会一直长，顺手把过期窗口清掉 */
  if (CRED_HITS.size > 4000) {
    for (const [key, val] of CRED_HITS) {
      if (now - val.t > CRED_WINDOW_MS) CRED_HITS.delete(key);
    }
  }
  return rec.n > CRED_RATE;
}

/* ---- 已退役的页面（2026-10-29 v2.38 起，2026-11-04 v2.87 补齐）----
 *
 * `preview.html` / `preview-banner.js` / `map-amap-preview.js` 已从站点目录删除，
 * 但 Cloudflare Pages 是**增量覆盖**：本地删了，云端旧文件还在，直链照样 200
 * （2026-10-25 在 preview-v3.html 上实测过，平台没有「删除远端文件」的接口）。
 * 一个带密码门禁的半成品页对外可达，比删不掉更难看，所以在这层挡死。
 *
 * 🔴 为什么 `/x` 和 `/x.html` **两种写法都要挡**：Pages 的 Pretty URLs 会把
 *    `/x.html` 308 到 `/x`，而 **`/x` 本身会直接返回 `x.html` 的静态内容** ——
 *    只登记 `.html` 那个写法，等于门只锁了一半。
 *    2026-11-04 v2.87 实测：`/help`、`/admin`、`/preview-v3`、`/redesign-v2`、
 *    `/redesign-mockup` 线上**全部 200**，只有带 `.html` 的那侧是 410/308。
 * 🔴 这些路径必须同时写进 `_routes.json` 的 `include` —— 不进去的话
 *    请求根本到不了 Worker，会被静态层直接发出去。
 */
/* 2026-11-03 v2.85：`/help`（「怎么抓一串凭证」教程页）进名单 —— 页面本体还在
   `chd-charge/` 里（随时能从 git 恢复），但不再对外提供。
   2026-11-04 v2.87 A4：`/admin`（凭证上传占位页）也下线，文件已删；顺带把
   `EXCLUDE_FILES` 里那几个历史样张（preview-v3 / redesign-*）一起挡住 ——
   它们从来没进过 RETIRED，打包层早就不发了，线上旧文件却一直是 200。 */
const RETIRED = new Set([
  '/preview', '/preview.html', '/preview-banner.js', '/map-amap-preview.js',
  '/help', '/help.html',
  '/admin', '/admin.html',
  '/preview-v3', '/preview-v3.html',
  '/redesign', '/redesign-mockup', '/redesign-mockup.html',
  '/redesign-v2', '/redesign-v2.html',
  /* 2026-11-08 v3.17：使用说明里的赞助二维码撤掉了，文件也已从站点目录删除。
     Pages 增量覆盖 + CDN 一周缓存，旧图还会挂在那个 URL 上，登记成退役资源挡住。 */
  '/sponsor-qr.png',
]);
/* 目录级：`/redesign/*` 整个都是内部样张，一条前缀挡完比逐个列省心 */
const RETIRED_PREFIX = ['/redesign/'];

/* ---------------- 违规车牌登记（v3.20，2026-11-10）----------------
 *
 * 三套时间口径别混：
 *   PLATE_WINDOW_DAYS = 明细能留多久（过期惰性清理）；
 *   PLATE_QUERY_DAYS  = 普通查询数哪一段（滚动窗口）；
 *   ym               = 排行榜按哪个自然月切（管理员可筛选月份 + 校区）。
 *
 * 存储只放 HMAC 后的车牌哈希和 AES-GCM 密文，明文不落库；查询只读次数。
 * 明细是唯一权威数据：90 天次数、当天已登记几次、按校区分布都由 reports 现算，
 * 没冗余计数列就不会出现「撤销后累计没跟着退」这种对不上的情况。
 * 只有排行榜用预汇总表 —— 18 万行明细上做全表分组会撞 10ms CPU 上限。
 *
 * 🔴 绑定缺失时全部端点优雅降级（不是崩站）：config 回 enabled:false，
 *    其余回 503 plate_disabled。控制台配好 PLATE_DB + 两个 secret 后自动生效，
 *    首次请求用 DDL 惰性建表，不需要手工跑 SQL。
 *
 * 🔴 防刷爆两道硬闸门（免费额度是账号级共享，刷爆会拖死同账号的快照站）：
 *    每日上限 PLATE_GLOBAL_LIMIT —— 全站每天最多登记几条，plate_quota 原子扣次；
 *    全部上限 PLATE_TOTAL_CAP   —— reports 明细总行数硬顶，写之前先判，满了就不写。
 *    总量不能每次 SELECT COUNT(*)：18 万行扫一次就是 18 万行读，2000 次/天
 *    会把 D1 免费版的行读额度直接扫穿。所以用 plate_meta 单行计数器，
 *    登记 +1 / 撤销 -N / 清理 -N；只有触顶时才用真实 COUNT 自校正一次
 *    （计数器若因运维手工删库而虚高，这一次也能自愈，不会误拒）。
 */
const PLATE_WINDOW_DAYS = 180;
const PLATE_QUERY_DAYS = 90;
const PLATE_PER_DAY = 2;          // 每个车牌每天最多被登记几次
const PLATE_REPORT_LIMIT = 5;     // 每个设备每天最多登记几次（挡扫不同车牌刷库）
const PLATE_QUERY_LIMIT = 3;      // 每个设备每天最多查几次（不累计，日切归零）
const PLATE_GLOBAL_LIMIT = 2000;  // 每日上限：全站每天最多登记几条
const PLATE_TOTAL_CAP = 200000;   // 全部上限：明细总行数硬顶（约 20MB，远低于 5GB）
const PLATE_MONTHS_KEEP = 7;      // 月汇总最多保留几个自然月
const PLATE_CAMPUSES = ['weishui', 'beiyuan', 'yanta', 'xiaozhai'];
const PLATE_REASONS = ['pull', 'park', 'other'];
const PLATE_CAMPUS_NAME = { weishui: '渭水', beiyuan: '北院', yanta: '雁塔', xiaozhai: '小寨' };
const PLATE_REASON_NAME = { pull: '拔充电器', park: '乱停', other: '其他' };

const PLATE_DDL = [
  'CREATE TABLE IF NOT EXISTS plates('
    + 'plate_hash TEXT PRIMARY KEY, plate_enc TEXT, first_at INTEGER, last_at INTEGER,'
    + ' total_all INTEGER DEFAULT 0)',
  'CREATE TABLE IF NOT EXISTS reports('
    + 'id INTEGER PRIMARY KEY AUTOINCREMENT, plate_hash TEXT, src_hash TEXT, day TEXT,'
    + ' campus TEXT, reason TEXT, at INTEGER,'
    + ' UNIQUE(plate_hash, src_hash, day))',
  'CREATE INDEX IF NOT EXISTS idx_reports_plate_at ON reports(plate_hash, at)',
  'CREATE INDEX IF NOT EXISTS idx_reports_plate_day ON reports(plate_hash, day)',
  'CREATE INDEX IF NOT EXISTS idx_reports_at ON reports(at)',
  'CREATE TABLE IF NOT EXISTS plate_month('
    + 'plate_hash TEXT, ym TEXT, cnt INTEGER DEFAULT 0, pull INTEGER DEFAULT 0,'
    + ' park INTEGER DEFAULT 0, other INTEGER DEFAULT 0, last_at INTEGER,'
    + ' PRIMARY KEY(plate_hash, ym))',
  'CREATE INDEX IF NOT EXISTS idx_pm_ym_cnt ON plate_month(ym, cnt DESC)',
  'CREATE TABLE IF NOT EXISTS plate_month_campus('
    + 'plate_hash TEXT, ym TEXT, campus TEXT, cnt INTEGER DEFAULT 0,'
    + ' PRIMARY KEY(plate_hash, ym, campus))',
  'CREATE INDEX IF NOT EXISTS idx_pmc ON plate_month_campus(ym, campus, cnt DESC)',
  'CREATE TABLE IF NOT EXISTS plate_quota('
    + 'scope TEXT, key TEXT, day TEXT, used INTEGER DEFAULT 0,'
    + ' PRIMARY KEY(scope, key, day))',
  'CREATE TABLE IF NOT EXISTS plate_meta('
    + 'key TEXT PRIMARY KEY, val INTEGER NOT NULL DEFAULT 0)',
  'CREATE TABLE IF NOT EXISTS plate_audit('
    + 'id INTEGER PRIMARY KEY AUTOINCREMENT, at INTEGER, action TEXT, plate_hash TEXT, who TEXT)',
];
let plateSchemaReady = false;

function plateEnvReady(env) {
  return !!(env && env.PLATE_DB && env.PLATE_HMAC_KEY && env.PLATE_AES_KEY);
}

async function plateInit(db) {
  if (plateSchemaReady) return;
  await db.batch(PLATE_DDL.map((sql) => db.prepare(sql)));
  /* 计数器补种只发生在首次建表 / 新 isolate：老库升级时用真实行数起跳，
     以后全靠登记 +1、撤销 -N、清理 -N 维护，不再全表 COUNT。 */
  await db.prepare(
    'INSERT OR IGNORE INTO plate_meta(key,val) VALUES(?, (SELECT COUNT(*) FROM reports))')
    .bind('rows').run();
  plateSchemaReady = true;
}

/* 日与月都按北京时间 UTC+8 的自然边界算。用 UTC 会在每天早上 8 点重置，
   用户会以为额度凭空回来了。 */
function plateDay(ts) {
  return new Date(ts + 8 * 3600000).toISOString().slice(0, 10).replace(/-/g, '');
}
function plateYm(ts) {
  return new Date(ts + 8 * 3600000).toISOString().slice(0, 7);
}

/* 车牌归一：全角转半角、各类连字符统一、去空白、大写。
   normKey() 被 U+2011 坑过，这里同样先把那些看着一样的横杠收掉。 */
function normPlate(s) {
  let v = String(s == null ? '' : s)
    .replace(/[\u2010-\u2015\u2212]/g, '-')
    .replace(/[\uFF01-\uFF5E]/g, (ch) => String.fromCharCode(ch.charCodeAt(0) - 0xFEE0))
    .replace(/\s+/g, '')
    .toUpperCase();
  return v;
}

function plateB64(bytes) {
  let s = '';
  for (let i = 0; i < bytes.length; i += 1) s += String.fromCharCode(bytes[i]);
  return btoa(s);
}
function plateUnb64(s) {
  const raw = atob(s);
  const out = new Uint8Array(raw.length);
  for (let i = 0; i < raw.length; i += 1) out[i] = raw.charCodeAt(i);
  return out;
}

async function plateHmac(text, secret) {
  const key = await crypto.subtle.importKey(
    'raw', new TextEncoder().encode(secret), { name: 'HMAC', hash: 'SHA-256' }, false, ['sign']);
  const sig = await crypto.subtle.sign('HMAC', key, new TextEncoder().encode(text));
  const arr = new Uint8Array(sig);
  let hex = '';
  for (let i = 0; i < arr.length; i += 1) hex += arr[i].toString(16).padStart(2, '0');
  return hex;
}

async function plateAesKey(secret) {
  const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(secret));
  return crypto.subtle.importKey('raw', digest, { name: 'AES-GCM' }, false, ['encrypt', 'decrypt']);
}

/* 随机 IV 每次都换，所以密文不能当主键，主键始终是 HMAC 后的 plate_hash。 */
async function plateEncrypt(text, secret) {
  const key = await plateAesKey(secret);
  const iv = crypto.getRandomValues(new Uint8Array(12));
  const buf = await crypto.subtle.encrypt(
    { name: 'AES-GCM', iv }, key, new TextEncoder().encode(text));
  return plateB64(iv) + ':' + plateB64(new Uint8Array(buf));
}

async function plateDecrypt(rec, secret) {
  try {
    const [iv64, data64] = String(rec || '').split(':');
    if (!iv64 || !data64) return '';
    const key = await plateAesKey(secret);
    const buf = await crypto.subtle.decrypt(
      { name: 'AES-GCM', iv: plateUnb64(iv64) }, key, plateUnb64(data64));
    return new TextDecoder().decode(buf);
  } catch (e) {
    return '';
  }
}

/* 原子扣次：先占位行，再用带条件的 UPDATE 抢额度，changes===1 才算抢到。
   先读后写在并发下必超发；KV 没有 CAS 且免费 1000 写/天，不能用。 */
async function plateQuota(db, scope, key, day, limit) {
  await db.prepare('INSERT OR IGNORE INTO plate_quota(scope,key,day,used) VALUES(?,?,?,0)')
    .bind(scope, key, day).run();
  const r = await db.prepare(
    'UPDATE plate_quota SET used=used+1 WHERE scope=? AND key=? AND day=? AND used<?')
    .bind(scope, key, day, limit).run();
  return !!(r && r.meta && r.meta.changes === 1);
}

/* 抽样惰性清理：免费版 cron 只有 5 条且已被快照站主时钟占满，加不了定时任务。
   reports 按 180 天分批删，月汇总按整月淘汰；月汇总是登记时累加的、不读明细，
   所以两者各自清理也不会对不上。 */
async function plateCleanup(db, now) {
  const cutoff = now - PLATE_WINDOW_DAYS * 86400000;
  const del = await db.prepare(
    'DELETE FROM reports WHERE id IN (SELECT id FROM reports WHERE at<? LIMIT 200)')
    .bind(cutoff).run();
  const gone = Number(del && del.meta && del.meta.changes) || 0;
  if (gone) {
    await db.prepare("UPDATE plate_meta SET val=MAX(0,val-?) WHERE key='rows'")
      .bind(gone).run();
  }
  const d = new Date(now + 8 * 3600000);
  d.setUTCDate(1);
  d.setUTCMonth(d.getUTCMonth() - (PLATE_MONTHS_KEEP - 1));
  const oldest = d.toISOString().slice(0, 7);
  await db.prepare('DELETE FROM plate_month WHERE ym<?').bind(oldest).run();
  await db.prepare('DELETE FROM plate_month_campus WHERE ym<?').bind(oldest).run();
  await db.prepare('DELETE FROM plate_quota WHERE day<?').bind(plateDay(cutoff)).run();
}

/* 总量闸门：正常路径只读一行计数器，不碰明细表。触顶才做两件贵的事 ——
   强制清一次 180 天前的记录，再用真实 COUNT 复核并自校正
   （计数器虚高时自愈，不会因为运维手工删库就一直误拒）。 */
async function plateRows(db) {
  const v = await db.prepare("SELECT val FROM plate_meta WHERE key='rows'").first('val');
  return Number(v || 0);
}
async function plateCapGuard(db, now) {
  if ((await plateRows(db)) < PLATE_TOTAL_CAP) return true;
  await plateCleanup(db, now);
  const n = Number(await db.prepare('SELECT COUNT(*) AS n FROM reports').first('n') || 0);
  await db.prepare("UPDATE plate_meta SET val=? WHERE key='rows'").bind(n).run();
  return n < PLATE_TOTAL_CAP;
}

function plateConfig(env) {
  return {
    ok: true,
    enabled: plateEnvReady(env),
    windowDays: PLATE_WINDOW_DAYS,
    queryDays: PLATE_QUERY_DAYS,
    maxPerDay: PLATE_PER_DAY,
    queryLimit: PLATE_QUERY_LIMIT,
    dailyCap: PLATE_GLOBAL_LIMIT,
    totalCap: PLATE_TOTAL_CAP,
    campuses: PLATE_CAMPUSES.map((k) => ({ key: k, name: PLATE_CAMPUS_NAME[k] })),
    reasons: PLATE_REASONS.map((k) => ({ key: k, name: PLATE_REASON_NAME[k] })),
  };
}

async function plateSrcHash(request, env, raw) {
  const src = String(raw || '').slice(0, 64);
  return plateHmac(src || clientIp(request), env.PLATE_HMAC_KEY);
}

/* GET /api/plate —— 不带 q 时返回配置常量（前端据此显隐入口）；
   带 q 时返回近 90 天的次数与按校区分布。未命中也扣次，避免额度变成
   「哪些车牌登记过」的枚举探测器。 */
async function plateQuery(request, url, env) {
  const cfg = plateConfig(env);
  const q = url.searchParams.get('q');
  if (!q) return json(cfg);
  if (!cfg.enabled) return json({ ok: false, error: 'plate_disabled' }, 503);
  const norm = normPlate(q);
  if (!/^[\u4e00-\u9fa5][A-Z0-9]{5,8}$/.test(norm)) {
    return json({ ok: false, error: 'bad_plate' }, 400);
  }
  const db = env.PLATE_DB;
  await plateInit(db);
  const day = plateDay(Date.now());
  const sh = await plateSrcHash(request, env, request.headers.get('x-plate-src'));
  if (!(await plateQuota(db, 'query', sh, day, PLATE_QUERY_LIMIT))) {
    return json({ ok: false, error: 'query_limit' }, 429);
  }
  const ph = await plateHmac(norm, env.PLATE_HMAC_KEY);
  const since = Date.now() - PLATE_QUERY_DAYS * 86400000;
  const cnt = await db.prepare(
    'SELECT COUNT(*) AS n FROM reports WHERE plate_hash=? AND at>=?')
    .bind(ph, since).first('n');
  const groups = await db.prepare(
    'SELECT campus, COUNT(*) AS n FROM reports WHERE plate_hash=? AND at>=? GROUP BY campus')
    .bind(ph, since).all();
  const last = await db.prepare('SELECT MAX(at) AS t FROM reports WHERE plate_hash=?')
    .bind(ph).first('t');
  const byCampus = {};
  (groups.results || []).forEach((g) => { byCampus[g.campus] = g.n; });
  return json({
    ok: true, listed: Number(cnt || 0) > 0, count: Number(cnt || 0),
    lastAt: Number(last || 0), byCampus, queryDays: PLATE_QUERY_DAYS,
  });
}

/* POST /api/plate/report —— 车牌 + 事由 + 校区。
   🔴 每日 2 次按 plate_hash + day 全局计，不按校区：否则换个校区就能把额度翻 4 倍。
   🔴 幂等唯一键 (plate_hash, src_hash, day)：同设备同日同车牌重复提交不扣额度。 */
async function plateReport(request, env) {
  if (!plateEnvReady(env)) return json({ ok: false, error: 'plate_disabled' }, 503);
  let body;
  try { body = await request.json(); } catch (e) { return json({ ok: false, error: 'bad_json' }, 400); }
  const plate = normPlate(body && body.plate);
  if (!/^[\u4e00-\u9fa5][A-Z0-9]{5,8}$/.test(plate)) {
    return json({ ok: false, error: 'bad_plate' }, 400);
  }
  const campus = String((body && body.campus) || '');
  const reason = String((body && body.reason) || '');
  if (PLATE_CAMPUSES.indexOf(campus) < 0) return json({ ok: false, error: 'bad_campus' }, 400);
  if (PLATE_REASONS.indexOf(reason) < 0) return json({ ok: false, error: 'bad_reason' }, 400);

  const db = env.PLATE_DB;
  await plateInit(db);
  const now = Date.now();
  const day = plateDay(now);
  const ym = plateYm(now);
  const src = String((body && body.src) || '');
  const sh = await plateSrcHash(request, env, src);
  const ph = await plateHmac(plate, env.PLATE_HMAC_KEY);

  /* 全部上限先判：库满了直接拒，连额度都不扣，更不会往 D1 写一行。 */
  if (!(await plateCapGuard(db, now))) {
    return json({ ok: false, error: 'storage_cap' }, 429);
  }
  if (!(await plateQuota(db, 'global', day, day, PLATE_GLOBAL_LIMIT))) {
    return json({ ok: false, error: 'global_limit' }, 429);
  }
  if (!(await plateQuota(db, 'report', sh, day, PLATE_REPORT_LIMIT))) {
    return json({ ok: false, error: 'report_limit' }, 429);
  }

  /* 一句 SQL 同时做「同设备同日去重」和「当天该车牌未满 2 次」，并发下不会超发。 */
  const ins = await db.prepare(
    'INSERT INTO reports(plate_hash,src_hash,day,campus,reason,at) '
      + 'SELECT ?,?,?,?,?,? WHERE NOT EXISTS('
      + 'SELECT 1 FROM reports WHERE plate_hash=? AND src_hash=? AND day=?) '
      + 'AND (SELECT COUNT(*) FROM reports WHERE plate_hash=? AND day=?) < ?')
    .bind(ph, sh, day, campus, reason, now, ph, sh, day, ph, day, PLATE_PER_DAY).run();
  if (!ins || !ins.meta || ins.meta.changes !== 1) {
    const dup = await db.prepare(
      'SELECT 1 AS x FROM reports WHERE plate_hash=? AND src_hash=? AND day=?')
      .bind(ph, sh, day).first('x');
    return json({ ok: false, error: dup ? 'duplicate' : 'daily_full' }, dup ? 409 : 429);
  }

  const pull = reason === 'pull' ? 1 : 0;
  const park = reason === 'park' ? 1 : 0;
  const other = reason === 'other' ? 1 : 0;
  /* 只在首次见到这个车牌时写密文；后续登记沿用首份，不反复加密。
     随机 IV 不能当主键，主键始终是 plate_hash。 */
  const exists = await db.prepare('SELECT 1 AS x FROM plates WHERE plate_hash=?')
    .bind(ph).first('x');
  const enc = exists ? null : await plateEncrypt(plate, env.PLATE_AES_KEY);
  await db.batch([
    exists
      ? db.prepare('UPDATE plates SET last_at=?, total_all=total_all+1 WHERE plate_hash=?')
        .bind(now, ph)
      : db.prepare('INSERT INTO plates(plate_hash,plate_enc,first_at,last_at,total_all) VALUES(?,?,?,?,1)')
        .bind(ph, enc, now, now),
    db.prepare(
      'INSERT INTO plate_month(plate_hash,ym,cnt,pull,park,other,last_at) VALUES(?,?,1,?,?,?,?) '
        + 'ON CONFLICT(plate_hash,ym) DO UPDATE SET '
        + 'cnt=cnt+1, pull=pull+excluded.pull, park=park+excluded.park, '
        + 'other=other+excluded.other, last_at=excluded.last_at')
      .bind(ph, ym, pull, park, other, now),
    db.prepare(
      'INSERT INTO plate_month_campus(plate_hash,ym,campus,cnt) VALUES(?,?,?,1) '
        + 'ON CONFLICT(plate_hash,ym,campus) DO UPDATE SET cnt=cnt+1')
      .bind(ph, ym, campus),
    db.prepare('INSERT INTO plate_audit(at,action,plate_hash,who) VALUES(?,?,?,?)')
      .bind(now, 'report', ph, sh.slice(0, 16)),
    db.prepare("UPDATE plate_meta SET val=val+1 WHERE key='rows'"),
  ]);

  if (Math.random() < 0.05) await plateCleanup(db, now);

  const since = now - PLATE_QUERY_DAYS * 86400000;
  const total = await db.prepare(
    'SELECT COUNT(*) AS n FROM reports WHERE plate_hash=? AND at>=?')
    .bind(ph, since).first('n');
  return json({ ok: true, total: Number(total || 0), queryDays: PLATE_QUERY_DAYS });
}

/* 🔴 管理员端点只认服务端这把密钥：前端 cpk.unlocked 是 sessionStorage 里的
   UI 开关，HTTP 请求根本不带它，curl 也能绕过页面直接打接口。
   优先用独立的 PLATE_ADMIN_TOKEN；没配才退回全站共用的 ADMIN_TOKEN。 */
async function plateAdminOk(request, url, env) {
  const secret = (env && (env.PLATE_ADMIN_TOKEN || env.ADMIN_TOKEN)) || '';
  if (!secret) return false;
  if (!sameSiteRequest(request, url)) return false;
  const given = request.headers.get('x-admin-token') || '';
  return safeEqual(given, secret);
}

/* GET /api/admin/plate/rank —— 按自然月 + 可选校区出 Top N，并回可筛选的月份列表。
   只走预汇总表的索引，不对 18 万行明细做分组。 */
async function plateRank(request, url, env) {
  if (!(await plateAdminOk(request, url, env))) {
    return json({ ok: false, error: 'bad_token' }, 401);
  }
  if (!plateEnvReady(env)) return json({ ok: false, error: 'plate_disabled' }, 503);
  const db = env.PLATE_DB;
  await plateInit(db);
  const ymRaw = url.searchParams.get('ym') || '';
  const ym = /^\d{4}-\d{2}$/.test(ymRaw) ? ymRaw : plateYm(Date.now());
  const campusRaw = url.searchParams.get('campus') || '';
  const campus = PLATE_CAMPUSES.indexOf(campusRaw) >= 0 ? campusRaw : '';
  const limit = Math.min(50, Math.max(1, Number(url.searchParams.get('limit')) || 20));

  const months = await db.prepare(
    'SELECT DISTINCT ym FROM plate_month ORDER BY ym DESC LIMIT ?')
    .bind(PLATE_MONTHS_KEEP).all();
  const sql = campus
    ? 'SELECT m.plate_hash AS ph, m.cnt AS cnt, p.plate_enc AS enc, p.last_at AS last_at '
      + 'FROM plate_month_campus m JOIN plates p ON p.plate_hash=m.plate_hash '
      + 'WHERE m.ym=? AND m.campus=? ORDER BY m.cnt DESC LIMIT ?'
    : 'SELECT m.plate_hash AS ph, m.cnt AS cnt, m.pull AS pull, m.park AS park, '
      + 'm.other AS other, p.plate_enc AS enc, m.last_at AS last_at '
      + 'FROM plate_month m JOIN plates p ON p.plate_hash=m.plate_hash '
      + 'WHERE m.ym=? ORDER BY m.cnt DESC LIMIT ?';
  const q = db.prepare(sql);
  const res = campus ? await q.bind(ym, campus, limit).all() : await q.bind(ym, limit).all();
  const rows = await Promise.all((res.results || []).map(async (r) => ({
    plate: await plateDecrypt(r.enc, env.PLATE_AES_KEY),
    count: Number(r.cnt || 0),
    pull: Number(r.pull || 0), park: Number(r.park || 0), other: Number(r.other || 0),
    lastAt: Number(r.last_at || 0),
  })));
  await db.prepare('INSERT INTO plate_audit(at,action,plate_hash,who) VALUES(?,?,?,?)')
    .bind(Date.now(), 'rank', ym + (campus ? ':' + campus : ''), 'admin').run();
  return json({
    ok: true, ym, campus,
    months: (months.results || []).map((m) => m.ym),
    currentYm: plateYm(Date.now()),
    windowDays: PLATE_WINDOW_DAYS,
    rows,
  });
}

/* POST /api/admin/plate/revoke —— 撤销某车牌某月（可限定校区）的全部登记。
   明细删掉后 90 天查询次数自动变少；预汇总表按删掉的条数逐项回退。
   这是民法典 1195 通知删除的最低落地形态。 */
async function plateRevoke(request, env) {
  if (!(await plateAdminOk(request, new URL(request.url), env))) {
    return json({ ok: false, error: 'bad_token' }, 401);
  }
  if (!plateEnvReady(env)) return json({ ok: false, error: 'plate_disabled' }, 503);
  let body;
  try { body = await request.json(); } catch (e) { return json({ ok: false, error: 'bad_json' }, 400); }
  const plate = normPlate(body && body.plate);
  if (!/^[\u4e00-\u9fa5][A-Z0-9]{5,8}$/.test(plate)) {
    return json({ ok: false, error: 'bad_plate' }, 400);
  }
  const ymRaw = String((body && body.ym) || '');
  if (!/^\d{4}-\d{2}$/.test(ymRaw)) return json({ ok: false, error: 'bad_ym' }, 400);
  const campus = String((body && body.campus) || '');
  if (campus && PLATE_CAMPUSES.indexOf(campus) < 0) {
    return json({ ok: false, error: 'bad_campus' }, 400);
  }
  const db = env.PLATE_DB;
  await plateInit(db);
  const ph = await plateHmac(plate, env.PLATE_HMAC_KEY);
  const like = ymRaw.replace('-', '') + '%';
  const where = 'plate_hash=? AND day LIKE ?' + (campus ? ' AND campus=?' : '');
  const gq = db.prepare('SELECT campus, reason, COUNT(*) AS n FROM reports WHERE ' + where
    + ' GROUP BY campus, reason');
  const groups = campus ? await gq.bind(ph, like, campus).all() : await gq.bind(ph, like).all();
  const rows = groups.results || [];
  if (!rows.length) return json({ ok: false, error: 'not_found' }, 404);
  const dq = db.prepare('DELETE FROM reports WHERE ' + where);
  const del = campus ? await dq.bind(ph, like, campus).run() : await dq.bind(ph, like).run();
  const removed = Number(del && del.meta && del.meta.changes) || 0;

  let pull = 0, park = 0, other = 0;
  const perCampus = {};
  rows.forEach((r) => {
    const n = Number(r.n) || 0;
    if (r.reason === 'pull') pull += n;
    else if (r.reason === 'park') park += n;
    else other += n;
    perCampus[r.campus] = (perCampus[r.campus] || 0) + n;
  });
  const stmts = [
    db.prepare('UPDATE plate_month SET cnt=MAX(0,cnt-?), pull=MAX(0,pull-?), '
      + 'park=MAX(0,park-?), other=MAX(0,other-?) WHERE plate_hash=? AND ym=?')
      .bind(removed, pull, park, other, ph, ymRaw),
    db.prepare('UPDATE plates SET total_all=MAX(0,total_all-?) WHERE plate_hash=?')
      .bind(removed, ph),
    db.prepare('INSERT INTO plate_audit(at,action,plate_hash,who) VALUES(?,?,?,?)')
      .bind(Date.now(), 'revoke', ph, 'admin'),
    db.prepare("UPDATE plate_meta SET val=MAX(0,val-?) WHERE key='rows'")
      .bind(removed),
  ];
  Object.keys(perCampus).forEach((c) => {
    stmts.push(db.prepare(
      'UPDATE plate_month_campus SET cnt=MAX(0,cnt-?) WHERE plate_hash=? AND ym=? AND campus=?')
      .bind(perCampus[c], ph, ymRaw, c));
  });
  await db.batch(stmts);
  await db.prepare('DELETE FROM plate_month WHERE plate_hash=? AND ym=? AND cnt=0')
    .bind(ph, ymRaw).run();
  return json({ ok: true, removed, ym: ymRaw, campus });
}

export default {
  async fetch(request, env) {
    const url = new URL(request.url);
    const path = url.pathname.replace(/\/+$/, '') || '/';

    if (RETIRED.has(path) || RETIRED_PREFIX.some((p) => path.startsWith(p))) {
      return new Response('410 Gone —— 这个页面已经下线，请回到首页。', {
        status: 410,
        headers: {
          'content-type': 'text/plain; charset=utf-8',
          'cache-control': 'no-store',
          'x-robots-tag': 'noindex',
        },
      });
    }

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
    if (path === '/api/pile') return handlePile(request, url, env);
    if (path === '/api/shop') return handleShop(request, url, env);

    // ---- 一周回顾 / 快照：反代快照 Worker ----
    if (path === '/api/stats' || path === '/api/snap') return proxySnap(path, url, env);

    // ---- 违规车牌登记（v3.20）。🔴 必须在下面 :909 的 404 兜底之前注册 ----
    // 绑定没配好时返回 enabled:false / 503，不影响查桩主功能。
    if (path === '/api/plate') {
      if (request.method === 'GET' || request.method === 'HEAD') {
        return plateQuery(request, url, env);
      }
      return json({ ok: false, error: 'method_not_allowed' }, 405);
    }
    if (path === '/api/plate/report') {
      if (request.method !== 'POST') return json({ ok: false, error: 'method_not_allowed' }, 405);
      return plateReport(request, env);
    }
    if (path === '/api/admin/plate/rank') {
      if (request.method !== 'GET') return json({ ok: false, error: 'method_not_allowed' }, 405);
      return plateRank(request, url, env);
    }
    if (path === '/api/admin/plate/revoke') {
      if (request.method !== 'POST') return json({ ok: false, error: 'method_not_allowed' }, 405);
      return plateRevoke(request, env);
    }

    // ---- 自动续期的运行结果上报（v3.05，只写；读走 GET /api/cred 的 renew 字段） ----
    /* 为什么要有这条：换证是**无人值守**的（见本机 tools/cred_autorenew.py），
       成功了页面靠 exp 变新能看出来，**失败了却只有一个 `expired`**，分不清
       「刚过期、任务还没轮到」和「连续失败三天了」。所以让脚本每跑一次就报一次。 */
    if (path === '/api/cred/renew') {
      if (request.method !== 'POST') return json({ ok: false, error: 'method_not_allowed' }, 405);
      if (!env.CHD_CRED) return json({ ok: false, error: 'kv_not_bound' }, 501);
      if (!env.ADMIN_TOKEN) return json({ ok: false, error: 'token_not_set' }, 501);

      /* 鉴权与 POST /api/cred **逐字一致**（同一口令、同一个失败计数），
         否则这条新入口就是绕开口令的侧门。 */
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
      /* 全部字段先截断再存：这份数据是给页面看的，宁可少显示也不存超长垃圾。
         `err` 只允许是「一句话原因」（Fiddler 没起来 / 等不到新凭证），**不许放凭证串**。 */
      const rec = {
        ts: Date.now(),
        ok: !!(body && body.ok === true),
        phase: typeof body.phase === 'string' ? body.phase.slice(0, 40) : '',
        err: typeof body.err === 'string' ? body.err.slice(0, 240) : '',
        expBefore: Number(body.expBefore) || 0,
        expAfter: Number(body.expAfter) || 0,
      };
      await env.CHD_CRED.put(KEY_RENEW, JSON.stringify(rec));
      return json({ ok: true, rec });
    }

    if (path !== '/api/cred') return json({ ok: false, error: 'not_found' }, 404);

    if (!env.CHD_CRED) return json({ ok: false, error: 'kv_not_bound' }, 501);

    // ---- 读：任何人都能读，但**只读到元数据**（密文自 2026-10-27 起不再下发） ----
    if (request.method === 'GET' || request.method === 'HEAD') {
      if (credTooMany(clientIp(request))) {
        return json({ ok: false, error: 'rate_limited' }, 429);
      }
      const raw = await env.CHD_CRED.get(KEY);
      /* 续期结果是旁路数据：读失败就降级成 null（纯展示用，不该让整个读接口 500）。
         凭证本身没有时也照样带出去 —— 那种情况更需要知道「续期到底在不在跑」。 */
      let renew = null;
      try {
        const rraw = await env.CHD_CRED.get(KEY_RENEW);
        if (rraw) renew = JSON.parse(rraw);
      } catch (e) { renew = null; }
      if (!raw) return json({ ok: true, exists: false, renew });
      let parsed;
      try {
        parsed = JSON.parse(raw);
      } catch (e) {
        return json({ ok: false, error: 'corrupt' }, 500);
      }
      /* ⚠️ 这里**不要**加回 `data`。浏览器已经不需要密文了（解密和转发都在服务端），
       * 而只要它出现在响应里，硬编码在前端的 key 就又能把它解开，等于白改一轮。
       * expiresAt 是秒级时间戳，0 表示这份记录没带过期信息。 */
      return json({
        ok: true,
        exists: true,
        updatedAt: parsed.updatedAt || 0,
        expiresAt: Number(parsed.exp) || 0,
        note: parsed.note || '',
        renew,
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

      /* 明文凭证是可选的第二份。带上它，`/api/pile` 才能自己取、自己发，
       * 浏览器也就永远不用再看见 token；不带也照常写（老客户端兼容），
       * 只是那种情况下只能靠浏览器端解密。
       * 校验上限与 handlePile 对齐，避免这里收下一个根本发不出去的串。 */
      const plain = typeof body.token === 'string' ? body.token.trim() : '';
      if (plain && (plain.length < 20 || plain.length > 4096)) {
        return json({ ok: false, error: 'bad_plain_token' }, 400);
      }
      const exp = Number(body.exp) || 0;

      const payload = {
        v: 1,
        updatedAt: Date.now(),
        note: typeof body.note === 'string' ? body.note.slice(0, 200) : '',
        exp: exp > 0 ? Math.floor(exp) : 0,
        data,
      };
      await env.CHD_CRED.put(KEY, JSON.stringify(payload));
      /* 写两份是两份额度（免费版 1000 写/天），但一天最多换一次凭证，可以忽略。
       * 明文键**不**参与任何读路由，只在 serverToken() 里出现。 */
      let tokenKept = false;
      if (plain) {
        await env.CHD_CRED.put(KEY_TOK, JSON.stringify({
          token: plain,
          updatedAt: payload.updatedAt,
          exp: payload.exp,
        }));
      } else if (body.clearToken === true) {
        /* 真的要清就显式说。给运维留一条「这张凭证作废了」的手动通道。 */
        await env.CHD_CRED.delete(KEY_TOK);
      } else {
        /* 🔴 2026-10-27 晚改：**不再因为「没带明文」就删 cred_tok**。
         *
         * 旧逻辑的动机是「宁报 no_token 也别用旧证」，但代价太大：写口令一泄漏，
         * 攻击者推一个只带密文的包就能让全站查不出数据 —— 变成一条零成本的 DoS。
         * （现实中还真踩过：旧的 admin.html 只推密文，用它上传一次就把全站打空。）
         *
         * 而它想防的问题本来就有人兜：`serverToken()` 取出来会先看 exp，
         * 过期的串等同于没有；没过期的话，新旧两串对平台而言完全等价。
         * 所以这里保留旧值，只在响应里带一个标记，让调用方知道自己没更新明文。 */
        tokenKept = true;
      }
      return json({
        ok: true,
        updatedAt: payload.updatedAt,
        expiresAt: payload.exp,
        ...(tokenKept ? { tokenKept: true } : {}),
      });
    }

    return json({ ok: false, error: 'method_not_allowed' }, 405);
  },
};

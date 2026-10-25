/* 只负责两件事：
   1. 让页面在断网时不至于白屏（壳走缓存）
   2. 让 Android 认定这是一个可安装的应用（有 fetch 处理器是硬条件）
   空位数据一律不缓存 —— 缓存空位等于骗人。
   云端的同步请求同样不能碰：那是同一域名下的接口，一旦被缓存优先命中，
   手机就会永远读到第一份密文，电脑换了凭证它也换不掉。 */

/* ⚠️ 改了预缓存逻辑就必须**同时把这个版本号 +1** ——
   Service Worker 只有「脚本字节变了」才会重新 install；
   只改 install 里的逻辑、不动这个名字，**已装用户的旧壳不会重来一遍** ✗
   v88 → v89（2026-10-22：SHELL 补 map-data.js + addAll 改逐条 add）
   v90 → v91（2026-10-22：fetch 里排除 /api/**，否则凭证信箱会被缓存钉死）
   v91 → v92（2026-10-23：两版都上了首屏预渲染 + 刷新按钮不再禁用，HTML 变了要换壳）
   v99 → v100（v2.10：Worker 并发池）
   v100 → v101（2026-10-25：SHELL 里的 map-data.js 从旧版本号跟到 `?v=164`
                  —— 页面已经升到 164，壳还钉在 163，**Cache API 按完整 URL 匹配**
                  → 断网时那份 map-data.js 命中不了，等于没预缓存 ✗
                  ⚠️ 以后改任何 `?v=` 都要回来搜一遍这个文件）
   v101 → v102（2026-10-25 v2.26：首页删掉「正在充电」「全站实时空闲」两块 DOM，
                  导航走网络优先本可自愈，但离线兜底那份壳还是旧结构 —— 换壳保证一致）
   v102 → v103（2026-10-25 v2.27：副标题「手机直连…」换成「致谢 & 贡献名单」弹窗入口）
   v103 → v104（2026-10-25 v2.16/v2.28：`credBoxAvailable()` 去掉 cloudSupport 短路 ——
                  老域名退回 109 台直连会被平台限流打穿，离线壳里存的是旧逻辑）
   v104 → v105（2026-10-25 v2.17/v2.29：刷新取数改回浏览器直连平台
                  （`PILE_DIRECT_ONLY`），离线的壳必须跟着换）
   v105 → v106（2026-10-25 v2.18/v2.29：内测同步正式版 —— 正式版也加了
                  「致谢 & 贡献名单」弹窗，离线壳里的 index.html 还是旧结构）
   v106 → v107（2026-10-25 v2.19/v2.30：致谢名单「元气少女李方朵」→「元气少女」，
                  两版文案都改了，离线壳里的那份还是旧名字）
   v107 → v108（2026-10-25 v2.20/v2.31：新增「使用说明」弹窗 + 赞助码图片，
                  SHELL 补 ./sponsor-qr.png —— 不加的话断网点开说明会裂图）
   v108 → v109（2026-10-25 v2.21/v2.32：致谢名单「卷不动根本卷不动」→「ditto」，
                  赞助说明去掉「掏钱」并标注支付宝收款码 —— index.html 内容变了，
                  不换壳的话老用户的离线副本还是旧文案）
   v109 → v110（2026-10-25 v2.22/v2.33：下掉「一周数据」入口按钮，
                  按钮区改成「地图 / 使用说明 / 设置」—— DOM 变了必须换壳）*/
const CACHE = 'campus-pile-v110';
const SHELL = [
  './',
  './index.html',
  './help.html',
  './manifest.webmanifest',
  './icons/icon-192.png',
  './icons/icon-512.png',
  /* 「使用说明」弹窗里的赞助码（39KB）。断网时点开说明也得看得见图，
     否则会是一个破图占位符。它不带 query，所以直接写路径即可。 */
  './sponsor-qr.png',
  /* ⚠️ 必须**带 `?v=164`** —— Cache API 按**完整 URL** 匹配：
     存不带 query 的 `./map-data.js`，断网时那个带 `?v=164` 的请求**命中不了**，等于没存 ✗
     ⚠️ 而且这个 `?v=` 要与页面里的**静态标签** `<script src="map-data.js?v=164">`
     和 `loadScriptOnce('map-data.js?v=164')` **保持一致**（升级时要一起改）✗

     为什么非要缓存它：首访那次导航发生在 SW 接管**之前**，所以它平时进不了缓存 ✗
     而断网时它是 `window.CHD_MAP` 的**唯一来源** —— 取不到就会让
     `mapAreaOf()` 与 `arcArea` 落到**同一个兜底值**，判据恒真，
     朝晖弧于是多画 20号楼(E-*) 与物流(W-*) 的桩（74 个点、24 个重合槽）✗
     （修好后应为 38 个节点 = 36 点 + 2 弧线） */
  './map-data.js?v=164',
];

self.addEventListener('install', (event) => {
  event.waitUntil(
    caches.open(CACHE)
      /* 🔴 2026-10-22 改：原来是 `cache.addAll(SHELL)` —— 它是**原子**的，
         SHELL 里**任何一条 404，整个预缓存就全空**；而下面那句 `.catch(() => skipWaiting())`
         又把失败**吞掉**了 → 页面上**零信号**，直到**真断网才表现为白屏** ✗
         （本次就是 `./help.html` 引起的，实测 cache = []、断网 reload = chrome-error 页。）
         改成逐条 add + allSettled：**单条失败不再拖垮整个壳** ✓
         ⚠️ 不要写成 `Promise.all` —— 那样一条失败就整体 reject，等于回到老问题 ✗ */
      .then((cache) => Promise.allSettled(SHELL.map((url) => cache.add(url))))
      .then((results) => {
        // 把失败项**喊出来**：SW 的 console 在 DevTools 里看得到。
        // 这是把「静默失败」变成「可观测」的唯一便宜手段 —— 否则下次还是只能靠断网白屏来发现 ✗
        results.forEach((r, i) => {
          if (r && r.status === 'rejected') {
            console.warn('[sw] 预缓存失败: ' + SHELL[i], r.reason);
          }
        });
        // ⚠️ **无论成败都要 skipWaiting**：若让某条失败把 activate 卡住，
        //    会变成「壳没备好、SW 也没接管」的更糟状态 ✗（旧代码用双 then/catch 表达同一语义）
        return self.skipWaiting();
      })
      .catch(() => self.skipWaiting())
  );
});

self.addEventListener('activate', (event) => {
  event.waitUntil(
    caches.keys()
      .then((keys) => Promise.all(keys.filter((k) => k !== CACHE).map((k) => caches.delete(k))))
      .then(() => self.clients.claim())
  );
});

self.addEventListener('fetch', (event) => {
  const request = event.request;
  if (request.method !== 'GET') return;

  const url = new URL(request.url);

  // 跨域（充电平台接口）一律直连，不介入
  if (url.origin !== self.location.origin) return;

  // 云服务数据面（/.cloud/**）：直连，绝不用缓存兜底
  if (url.pathname.indexOf('/.cloud/') === 0) return;

  /* 凭证信箱（/api/**，由 _worker.js 直出）：**必须排除**。
     这条是同一条原则的第二次踩点 —— 静态资源走的是「缓存优先 + 后台更新」，
     一旦把 /api/cred 也缓存了，手机会**永远读到第一份密文**，
     站长每周换凭证等于白换，而且没有任何报错信号 ✗ */
  if (url.pathname.indexOf('/api/') === 0) return;

  // 导航请求：网络优先，断了才用缓存里的壳
  if (request.mode === 'navigate') {
    event.respondWith(
      fetch(request)
        .then((response) => {
          const copy = response.clone();
          // 按实际路径缓存，避免访问 preview.html 时覆盖 index.html 的离线副本
          const isRoot = url.pathname === '/' || url.pathname === '';
          const cacheKey = isRoot ? './index.html' : '.' + url.pathname;
          caches.open(CACHE).then((cache) => cache.put(cacheKey, copy)).catch(() => {});
          return response;
        })
        .catch(() => {
          const isRoot = url.pathname === '/' || url.pathname === '';
          const cacheKey = isRoot ? './index.html' : '.' + url.pathname;
          return caches.match(cacheKey).then((hit) => hit || caches.match('./index.html') || caches.match('./'));
        })
    );
    return;
  }

  // 静态资源：先用缓存出图，同时后台悄悄拉一份新的存起来
  // （原来纯缓存优先，URL 不变就永远发旧文件，改完自己在手机上看不到效果，
  //   以为是没发布 —— 这套 stale-while-revalidate 就是为这个坑加的）
  event.respondWith(
    caches.match(request).then((hit) => {
      const network = fetch(request).then((response) => {
        if (response.ok && response.type === 'basic') {
          const copy = response.clone();
          caches.open(CACHE).then((cache) => cache.put(request, copy)).catch(() => {});
        }
        return response;
      });
      if (!hit) return network;
      network.catch(() => {});   // 断网时后台请求会失败，别让它变成未处理的 rejection
      return hit;
    })
  );
});

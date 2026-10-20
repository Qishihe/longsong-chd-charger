/* 只负责两件事：
   1. 让页面在断网时不至于白屏（壳走缓存）
   2. 让 Android 认定这是一个可安装的应用（有 fetch 处理器是硬条件）
   空位数据一律不缓存 —— 缓存空位等于骗人。
   云端的同步请求同样不能碰：那是同一域名下的接口，一旦被缓存优先命中，
   手机就会永远读到第一份密文，电脑换了凭证它也换不掉。 */

const CACHE = 'campus-pile-v75';
const SHELL = [
  './',
  './index.html',
  './help.html',
  './manifest.webmanifest',
  './icons/icon-192.png',
  './icons/icon-512.png',
];

self.addEventListener('install', (event) => {
  event.waitUntil(
    caches.open(CACHE)
      .then((cache) => cache.addAll(SHELL))
      .then(() => self.skipWaiting())
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

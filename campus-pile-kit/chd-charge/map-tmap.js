/* 腾讯地图运行时（校园语义层覆盖）
 * 依赖 map-data.js 提供的 window.CHD_MAP（GCJ-02 坐标）
 * 对外接口：CHD_TMAP.mount / setView / setPiles / focusPile / resize / destroy
 *
 * 踩坑记录（改之前务必读）：
 * 1) TMap.MarkerStyle 实例与所属图层同生共死，图层 setMap(null) 后样式即失效；
 * 2) 在相机移动之后新建的标记图层拿不到有效投影 —— 几何体在、画不出来；
 * 3) 按分区建多个标记层、靠 setVisible 切换，跨视图时也不稳定。
 * 结论：标记层只建一个、样式一次建全，切视图只 setGeometries + 移动相机。
 */
(function () {
  'use strict';

  var SDK = 'https://map.qq.com/api/gljs?v=1.exp';
  var D = null;                 // CHD_MAP
  var map = null, host = null;
  var bldLayer = null, venueLayer = null, waterLayer = null, campusLayer = null;
  var badgeLayer = null;        // 总览的分区气泡
  var pinLayer = null;          // 唯一的桩层：样式全量预建，几何体随视图切换
  var PIN_GEOMS = {};           // 分区 -> 该区的几何体数组
  var piles = [];               // [{id, code, location, free, total}]
  var curView = 'campus';
  var ready = false, failed = false;
  var onFailCb = null, onPileCb = null;
  var SVG_CACHE = {};           // key -> {url, w, h}   只缓存 SVG 数据
  var styleSeq = 0;
  var syncTimer = null, syncPending = false;

  function LL(p) { return new TMap.LatLng(p[1], p[0]); }

  function dispose(layer) {
    if (!layer) return;
    try { layer.setMap(null); } catch (e) {}
  }

  /* ---------- key 解析：页面内联 > URL 参数 > localStorage ---------- */
  function resolveKey() {
    if (window.CHD_TMAP_KEY) return String(window.CHD_TMAP_KEY).trim();
    try {
      var qs = new URLSearchParams(location.search).get('tmapkey');
      if (qs) { localStorage.setItem('chd_tmap_key', qs); return qs.trim(); }
      var ls = localStorage.getItem('chd_tmap_key');
      if (ls) return String(ls).trim();
    } catch (e) {}
    return '';
  }

  /* ---------- 桩位：沿分区排布线阶梯排列，避免胶囊互相遮挡 ---------- */
  function posFor(location, i, n) {
    var area = D.areas[location];
    if (!area) return D.campusCenter;
    var a = area.line[0], b = area.line[1];
    var t = n <= 1 ? 0.5 : 0.12 + 0.76 * (i / (n - 1));
    // 沿法线方向做阶梯错位（每级 ≈26m），逐台错开而不是挤在一条直线上
    var off = (i - (n - 1) / 2) * 0.00024;
    return [
      Math.round((a[0] + (b[0] - a[0]) * t) * 1e6) / 1e6,
      Math.round((a[1] + (b[1] - a[1]) * t + off) * 1e6) / 1e6
    ];
  }

  /* ---------- 标记图形（只产出 SVG 数据） ---------- */
  function pillSvg(code, free, total) {
    var off = !total;
    var ok = total > 0 && free > 0;
    var dot = off ? '#A9A79C' : (ok ? '#3E8E52' : '#B5443A');
    var text = code + ' · ' + (off ? '无数据' : (ok ? free + ' 空位' : '已满'));
    var w = 24 + text.length * 11.8, h = 28;
    var svg = '<svg xmlns="http://www.w3.org/2000/svg" width="' + w + '" height="' + h + '">'
      + '<rect x="1" y="1" width="' + (w - 2) + '" height="' + (h - 2) + '" rx="14" fill="#FFFFFF" stroke="' + dot + '" stroke-width="2"/>'
      + '<circle cx="13" cy="14" r="4.8" fill="' + dot + '"/>'
      + '<text x="23" y="18.2" font-family="sans-serif" font-size="11.8" font-weight="700" fill="#2B2F28">' + text + '</text>'
      + '</svg>';
    return { url: 'data:image/svg+xml;charset=utf-8,' + encodeURIComponent(svg), w: w, h: h };
  }

  function pillStyle(code, free, total) {
    var status = !total ? 2 : (free > 0 ? 1 : 0);
    var k = status + '|' + code;
    if (!SVG_CACHE[k]) SVG_CACHE[k] = pillSvg(code, free, total);
    var s = SVG_CACHE[k];
    return new TMap.MarkerStyle({ width: s.w, height: s.h, anchor: { x: s.w / 2, y: s.h }, src: s.url });
  }

  /* ---------- 底图图层（只建一次） ---------- */
  function buildLayers() {
    var LLm = function (ring) { return ring.map(LL); };

    campusLayer = new TMap.MultiPolygon({
      map: map, zIndex: 10,
      styles: { c: new TMap.PolygonStyle({ color: 'rgba(126,166,96,0.16)', borderColor: 'rgba(74,110,52,0.92)', borderWidth: 2.5, borderDashArray: [9, 5] }) },
      geometries: [{ id: 'campus', styleId: 'c', paths: [LLm(D.boundary)] }],
    });

    waterLayer = new TMap.MultiPolygon({
      map: map, zIndex: 11,
      styles: {
        w: new TMap.PolygonStyle({ color: 'rgba(150,188,202,0.35)', borderColor: 'rgba(120,158,172,0.6)', borderWidth: 1 }),
        o: new TMap.PolygonStyle({ color: 'rgba(224,230,206,0.55)', borderColor: 'rgba(196,206,176,0.75)', borderWidth: 1 }),
      },
      geometries: D.water.map(function (x, i) {
        return { id: 'w' + i, styleId: /试验场/.test(x.n) ? 'o' : 'w', paths: [LLm(x.p[0])] };
      }),
    });

    venueLayer = new TMap.MultiPolygon({
      map: map, zIndex: 12,
      styles: {
        track: new TMap.PolygonStyle({ color: 'rgba(198,138,118,0.18)', borderColor: 'rgba(176,114,92,0.45)', borderWidth: 1 }),
        field: new TMap.PolygonStyle({ color: 'rgba(150,180,140,0.18)', borderColor: 'rgba(120,146,110,0.45)', borderWidth: 1 }),
      },
      geometries: D.venues.map(function (x, i) {
        return { id: 'v' + i, styleId: /朝晖|鸿翔/.test(x.n) ? 'track' : 'field', paths: [LLm(x.p[0])] };
      }),
    });

    bldLayer = new TMap.MultiPolygon({
      map: map, zIndex: 13,
      styles: {
        b: new TMap.PolygonStyle({ color: 'rgba(255,254,248,0.46)', borderColor: 'rgba(138,142,118,0.40)', borderWidth: 1 }),
        s: new TMap.PolygonStyle({ color: 'rgba(250,236,208,0.52)', borderColor: 'rgba(186,160,120,0.5)', borderWidth: 1 }),
      },
      geometries: D.buildings.map(function (b, i) {
        return { id: 'b' + i, styleId: /超市|餐厅|商业|咖啡|便利店|商业街/.test(b.n) ? 's' : 'b', paths: [LLm(b.p[0])] };
      }),
    });

    // 建筑层按缩放分级：总览时底图自带楼体，放大后才叠我们的轮廓
    map.on('zoomend', function () {
      if (bldLayer) bldLayer.setVisible(map.getZoom() >= 16.3);
    });
    bldLayer.setVisible(map.getZoom() >= 16.3);

    // 桩层：建一个空壳，样式与几何体随后补
    pinLayer = new TMap.MultiMarker({ map: map, zIndex: 61, styles: {}, geometries: [] });
    pinLayer.on('click', function (ev) {
      var id = ev.geometry && ev.geometry.id;
      if (!id || !onPileCb) return;
      if (D.areas[id]) onPileCb({ type: 'area', id: id });
      else onPileCb({ type: 'pile', id: id });
    });
    pinLayer.setVisible(false);

    // 相机一停就补一次同步，确保几何体落在有效投影上
    map.on('idle', function () {
      if (syncPending) { syncPending = false; syncPinGeoms(); }
    });
  }

  /* ---------- 总览气泡 ---------- */
  function rebuildBadges() {
    dispose(badgeLayer); badgeLayer = null;

    var groups = {};
    piles.forEach(function (p) {
      var a = D.areas[p.location];
      if (!a) return;
      if (!groups[p.location]) groups[p.location] = { free: 0, n: 0, line: a.line, name: a.name };
      groups[p.location].n++;
      if (p.free > 0) groups[p.location].free += p.free;
    });

    var styles = {}, geo = [];
    var NUDGE = { '渭水-北门': 0.0013, '渭水-朝晖体育场南': -0.0029 };
    Object.keys(groups).forEach(function (loc) {
      var g = groups[loc];
      var mid = [(g.line[0][0] + g.line[1][0]) / 2,
        (g.line[0][1] + g.line[1][1]) / 2 + (NUDGE[loc] || 0)];
      var ok = g.free > 0;
      var dot = ok ? '#3E8E52' : '#B5443A';
      var l1 = g.name;
      var l2 = g.n + ' 台' + (ok ? ' · ' + g.free + ' 空位' : ' · 已满');
      var w = Math.round(Math.max(l1.length * 12.6, l2.length * 10.4) + 26), h = 48;
      var svg = '<svg xmlns="http://www.w3.org/2000/svg" width="' + w + '" height="' + h + '">'
        + '<rect x="1" y="1" width="' + (w - 2) + '" height="' + (h - 2) + '" rx="13" fill="#FFFFFF" stroke="' + dot + '" stroke-width="2"/>'
        + '<text x="' + (w / 2) + '" y="20" text-anchor="middle" font-family="sans-serif" font-size="12.6" font-weight="700" fill="#2B2F28">' + l1 + '</text>'
        + '<text x="' + (w / 2) + '" y="36" text-anchor="middle" font-family="sans-serif" font-size="11" fill="#5F665C">' + l2 + '</text>'
        + '</svg>';
      var sid = 'b' + (++styleSeq);
      styles[sid] = new TMap.MarkerStyle({
        width: w, height: h, anchor: { x: w / 2, y: h / 2 },
        src: 'data:image/svg+xml;charset=utf-8,' + encodeURIComponent(svg),
      });
      geo.push({ id: loc, styleId: sid, position: LL(mid) });
    });

    if (!geo.length) return;
    badgeLayer = new TMap.MultiMarker({ map: map, zIndex: 60, styles: styles, geometries: geo });
    badgeLayer.on('click', function (ev) {
      var id = ev.geometry && ev.geometry.id;
      if (id && onPileCb) onPileCb({ type: 'area', id: id });
    });
  }

  /* ---------- 桩层：样式全量预建 + 各视图几何体 ---------- */
  function rebuildPins() {
    if (!pinLayer) return;
    PIN_GEOMS = {};

    var styles = {};
    var MAX_PILLS = 4;      // ≤4 台逐台标注，多了聚合成一枚

    Object.keys(D.areas).forEach(function (area) {
      var list = piles.filter(function (p) { return p.location === area; });
      if (!list.length) { PIN_GEOMS[area] = []; return; }

      var geo = [];
      if (list.length <= MAX_PILLS) {
        list.forEach(function (p, i) {
          var sid = 'p' + (++styleSeq);
          styles[sid] = pillStyle(p.code, p.free, p.total);
          geo.push({ id: p.id, styleId: sid, position: LL(posFor(area, i, list.length)) });
        });
      } else {
        var freeSum = 0;
        list.forEach(function (p) { if (p.free > 0) freeSum += p.free; });
        var a = D.areas[area];
        var mid = [(a.line[0][0] + a.line[1][0]) / 2, (a.line[0][1] + a.line[1][1]) / 2];
        var sid2 = 'p' + (++styleSeq);
        styles[sid2] = pillStyle(a.name, freeSum, freeSum > 0 ? list.length : 0);
        geo.push({ id: area, styleId: sid2, position: LL(mid) });
      }
      PIN_GEOMS[area] = geo;
    });

    // 样式一次给全，切视图只换几何体
    try { pinLayer.setStyles(styles); } catch (e) {}
    syncPinGeoms();
  }

  function syncPinGeoms() {
    if (!pinLayer) return;
    var geo = (curView === 'campus') ? [] : (PIN_GEOMS[curView] || []);
    try { pinLayer.setGeometries(geo); } catch (e) {}
    pinLayer.setVisible(geo.length > 0);
    if (badgeLayer) badgeLayer.setVisible(curView === 'campus');
  }

  /* 相机移动过程中下发的几何体可能不重绘，等它稳定后再同步一次 */
  function scheduleSync(delay) {
    syncPending = true;
    if (syncTimer) clearTimeout(syncTimer);
    syncTimer = setTimeout(function () {
      syncTimer = null;
      if (!syncPending) return;
      syncPending = false;
      syncPinGeoms();
    }, delay || 520);
  }

  /* ---------- 相机 ---------- */
  function fitCampus() {
    var el = host || document.getElementById('tmap-host');
    var w = (el && el.clientWidth) || 360;
    var h = (el && el.clientHeight) || 640;
    var lat = (D.bounds.south + D.bounds.north) / 2;
    var cosLat = Math.cos(lat * Math.PI / 180);
    var res0 = 156543.03392 * cosLat;                       // zoom 0 时每像素米数
    var spanLon = (D.bounds.east - D.bounds.west) * 111320 * cosLat;
    var spanLat = (D.bounds.north - D.bounds.south) * 110540;
    var zx = Math.log2(res0 * (w * 0.86) / spanLon);
    var zy = Math.log2(res0 * (h * 0.80) / spanLat);
    var z = Math.max(12, Math.min(18, Math.min(zx, zy)));
    map.setCenter(new TMap.LatLng(lat, (D.bounds.west + D.bounds.east) / 2));
    map.setZoom(z);
  }

  function applyCamera() {
    if (curView === 'campus') { fitCampus(); return; }
    var a = D.areas[curView];
    if (!a) { fitCampus(); return; }
    map.setCenter(new TMap.LatLng((a.line[0][1] + a.line[1][1]) / 2, (a.line[0][0] + a.line[1][0]) / 2));
    map.setZoom(a.zoom || 17);
  }

  /* ---------- 对外 ---------- */
  var api = {
    hasKey: function () { return !!resolveKey(); },
    available: function () { return !!window.TMap; },
    ready: function () { return ready; },
    failed: function () { return failed; },

    mount: function (hostEl, opts) {
      opts = opts || {};
      host = hostEl;
      onFailCb = opts.onFail || null;
      onPileCb = opts.onPileClick || null;
      if (typeof CHD_MAP === 'undefined') { failed = true; onFailCb && onFailCb('data'); return; }
      D = CHD_MAP;

      function init() {
        try {
          map = new TMap.Map(host, {
            center: LL(D.campusCenter), zoom: 15.2, pitch: 0, viewMode: '2D', showControl: false,
          });
          buildLayers();
          ready = true;
          opts.onReady && opts.onReady();
        } catch (e) {
          failed = true;
          onFailCb && onFailCb('init');
        }
      }

      if (window.TMap) { init(); return; }

      var key = resolveKey();
      if (!key) { failed = true; onFailCb && onFailCb('nokey'); return; }

      var s = document.createElement('script');
      s.src = SDK + '&key=' + encodeURIComponent(key);
      s.onload = function () { if (window.TMap) init(); else { failed = true; onFailCb && onFailCb('load'); } };
      s.onerror = function () { failed = true; onFailCb && onFailCb('load'); };
      document.head.appendChild(s);

      // 超时兜底：8s 内没起来就回落静态图
      setTimeout(function () {
        if (!ready && !failed) { failed = true; onFailCb && onFailCb('timeout'); }
      }, 8000);
    },

    /** 更新桩数据：重建气泡与桩层，随后重新下发相机指令 */
    setPiles: function (list) {
      piles = list || [];
      if (!ready) return;
      rebuildBadges();
      rebuildPins();
      syncPinGeoms();
      applyCamera();
      scheduleSync(600);
    },

    setView: function (view) {
      if (!ready) return;
      curView = view;
      syncPinGeoms();
      applyCamera();
      scheduleSync(600);
    },

    /** 定位到某台桩：必要时切到它的分区，然后只移动相机 */
    focusPile: function (id) {
      if (!ready) return false;
      var target = null;
      piles.forEach(function (q) { if (q.id === id) target = q; });
      if (!target || !D.areas[target.location]) return false;

      if (curView !== target.location) {
        curView = target.location;
        syncPinGeoms();
      }

      var list = piles.filter(function (q) { return q.location === curView; });
      var idx = -1;
      list.forEach(function (q, i) { if (q.id === id) idx = i; });
      if (idx < 0) return false;

      var pos = posFor(curView, idx, list.length);
      map.easeTo({
        center: LL(pos),
        zoom: Math.max(18.2, (D.areas[curView] || {}).zoom || 18),
        duration: 600,
      });
      scheduleSync(700);
      return true;
    },

    resize: function () { if (map && map.resize) try { map.resize(); } catch (e) {} },

    /* 自检用：返回当前图层与标记数量 */
    debug: function () {
      var cnt = function (m) {
        try { return m && m.getGeometries ? m.getGeometries().length : (m ? 1 : 0); } catch (e) { return -1; }
      };
      return {
        view: curView, piles: piles.length, ready: ready, failed: failed,
        badges: cnt(badgeLayer), pins: cnt(pinLayer),
        perView: Object.keys(PIN_GEOMS).reduce(function (o, k) { o[k] = PIN_GEOMS[k].length; return o; }, {}),
        zoom: map ? map.getZoom() : null,
      };
    },

    destroy: function () {
      try {
        dispose(badgeLayer); dispose(pinLayer);
        if (map) map.destroy();
      } catch (e) {}
      badgeLayer = null; pinLayer = null; PIN_GEOMS = {}; map = null; ready = false;
      if (host) host.innerHTML = '';
    },
  };

  window.CHD_TMAP = api;
})();

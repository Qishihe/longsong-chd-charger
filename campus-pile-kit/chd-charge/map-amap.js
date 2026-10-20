/* 高德地图运行时（校园语义层覆盖）
 * 依赖 map-data.js 提供的 window.CHD_MAP（GCJ-02 坐标，腾讯/高德通用）
 * 对外接口：CHD_AMAP.mount / setView / setPiles / focusPile / resize / destroy
 *
 * 与 map-tmap.js（腾讯）平行的一套高德实现。
 * 差异点：
 *   1) 高德 JS API 2.0；Key/securityJsCode 由外部注入（见下方 AMAP_KEY 注释）；
 *   2) limitBounds 限制相机始终留在渭水校区内（拖不出边界）。
 */
(function () {
  'use strict';

  var SDK = 'https://webapi.amap.com/maps?v=2.0';

  /* 高德 Key 不写在本文件里（本仓库公开，写进来等于送人）。
   * 取值顺序：window.CHD_AMAP_KEY / window.CHD_AMAP_SCODE
   *   —— 由同目录的 map-key.local.js 提供，该文件不进仓库（见 .gitignore）。
   * 自己部署时：
   *   1) 去 https://console.amap.com/dev/key 申请「Web端(JS API)」的 Key + 安全密钥
   *   2) 把 map-key.example.js 复制为 map-key.local.js，填进你的两个值
   *   3) 确认页面在加载 map-amap.js 之前先加载了 map-key.local.js
   * 没配置时不会崩，只会回调 onFail('nokey')，页面会提示「未配置高德 Key」。
   */
  var AMAP_KEY = (typeof window !== 'undefined' && window.CHD_AMAP_KEY) || '';
  var AMAP_SCODE = (typeof window !== 'undefined' && window.CHD_AMAP_SCODE) || '';

  var D = null;                 // CHD_MAP
  var map = null, host = null;
  var bldLayer = null, venueLayer = null, waterLayer = null, campusLayer = null;
  var badgeLayer = null;        // 总览的分区气泡
  var pinLayer = null;          // 桩层（点内直接写桩号，不再单独挂文字标签）
  var piles = [];               // [{id, code, location, free, total}]
  var curView = 'campus';
  var ready = false, failed = false;
  var failReason = '', mountCount = 0;
  var onFailCb = null, onPileCb = null;
  var PIN_POS = {};             // id -> [lng, lat]（供 focusPile 用）
  var BADGE_POS = {};           // 分区 -> [lng, lat]（取景要把徽章也算进去，否则会被裁掉）
  var syncTimer = null, syncPending = false;

  function LL(p) { return [p[0], p[1]]; }   // 高德用 [lng, lat]

  /* ---------- 桩位：照搬两张静态底图（手绘图）的分布 ----------
   * 用户要求「把静态图上的桩位分布原样搬过来」。两张手绘图里的桩位本来就是写死的像素坐标，
   * 这里只做一次「手绘图像素 → 经纬度」的锚定换算，行列位置、弧线走向一律照抄：
   *   · 北门：A6..A1 / 空 / C1..C11 与 B6..B1 / 空 / D1..D14 两块矩阵（共 37 位），
   *     像素坐标与 preview.html 里的 BM_SPOTS 逐位一致，整块搬进用户圈出来的地块。
   *   · 朝晖：围着体育场的两条弧（左弧 12 位、右弧 24 位，圆心=体育场中心，rx/ry 照抄静态图）。
   *     把手绘图里体育场的外接框锚到真实体育场外接框（GCJ-02），弧线就自然贴着跑道两侧。
   * 手绘图本身比例不严谨，所以这里只保证「分布形状一致」，不声称逐桩真位。
   */
  // 北门车图像素坐标（= preview.html 的 BM_SPOTS，改一处要两边一起改）
  var BM_PX = (function () {
    function pad2(n) { return String(n).padStart(2, '0'); }
    function row(prefix, x0, x1, n, y, asc) {
      var out = [];
      for (var i = 0; i < n; i++) {
        out.push({
          code: prefix + pad2(asc ? i + 1 : n - i),
          x: x0 + (i + 0.5) * (x1 - x0) / n,
          y: y,
        });
      }
      return out;
    }
    return [].concat(
      row('A', 491, 663, 6, 125, false),
      row('B', 491, 663, 6, 167.5, false),
      row('C', 693, 1008, 11, 125, true),
      row('D', 701, 1095, 14, 167.5, true)
    );
  })();
  var BM_BY_CODE = {};
  BM_PX.forEach(function (s) { BM_BY_CODE[s.code] = s; });

  // 北门：把上面这套像素布局整块搬进用户圈出来的地块
  // 2026-10-20 用户校正：「紫框标注的区域为北门」—— 之前整块骑在北门排布线上（校门东侧），
  // 位置不对。紫框是从用户截图上量出来的，四角像素 (292,175) (312,238) (465,194) (442,130)，
  // 是一块 137m×58m、长轴朝东北偏 16.7° 的地块；换算比例 0.87 米/像素由两个桩阵自身标定
  // （北门与朝晖的真实外接框 ÷ 各自渲染出来的像素宽高，横纵两向一致）。
  // 下面这四个数就是把「604px 宽的像素布局」旋转 16.7°、缩放到 125m（铺满地块长轴）后
  // 让中心落在紫框中心 —— 四排车位因此完整落在框内，不再压到校园边界。
  var BM_GEO = {
    lng: 108.9083605, lat: 34.375141,  // 紫框中心
    cx: 793, cy: 146.25,               // 四排车位在手绘图里的像素中心
    s: 0.207,                          // 米/像素（604px → 125m，铺满地块长轴）
    rot: 16.7 * Math.PI / 180,         // 地块长轴（西南 → 东北）
  };
  // 朝晖：手绘图（1024×1536）里体育场外接框 → 真实体育场外接框；弧参数与静态图 pinCoord 一致
  var CH_GEO = {
    px: { x0: 295, y0: 307, x1: 734, y1: 1243 },
    geo: { w: 108.910110, n: 34.375411, e: 108.911984, s: 34.373651 },
    cx: 511, cy: 784, rx: 368, ry: 501,
    leftCount: 12, leftStart: 180, leftEnd: 128, rightStart: 52, rightEnd: 0, total: 36,
  };
  function r6(v) { return Math.round(v * 1e6) / 1e6; }

  function bmGeo(px, py) {
    var east = (px - BM_GEO.cx) * BM_GEO.s;
    var north = -(py - BM_GEO.cy) * BM_GEO.s;
    var c = Math.cos(BM_GEO.rot), s = Math.sin(BM_GEO.rot);
    var E = east * c - north * s;
    var Nf = east * s + north * c;
    var lat = BM_GEO.lat + Nf / 110540;
    return [r6(BM_GEO.lng + E / (111320 * Math.cos(lat * Math.PI / 180))), r6(lat)];
  }

  function chGeo(px, py) {
    var kx = (CH_GEO.geo.e - CH_GEO.geo.w) / (CH_GEO.px.x1 - CH_GEO.px.x0);
    var ky = (CH_GEO.geo.n - CH_GEO.geo.s) / (CH_GEO.px.y1 - CH_GEO.px.y0);
    return [
      r6(CH_GEO.geo.w + (px - CH_GEO.px.x0) * kx),
      r6(CH_GEO.geo.n - (py - CH_GEO.px.y0) * ky),
    ];
  }

  /** 弧序号 1..36 → 手绘图像素（左弧 θ180°→128°，右弧 θ52°→0°，与静态图同一套） */
  function arcPx(seq) {
    var i = seq - 1, deg = Math.PI / 180, th;
    if (i < CH_GEO.leftCount) {
      var n = Math.max(1, CH_GEO.leftCount - 1);
      th = (CH_GEO.leftStart - (CH_GEO.leftStart - CH_GEO.leftEnd) * (i / n)) * deg;
    } else {
      var j = i - CH_GEO.leftCount;
      var n2 = Math.max(1, CH_GEO.total - CH_GEO.leftCount - 1);
      th = (CH_GEO.rightStart - (CH_GEO.rightStart - CH_GEO.rightEnd) * (j / n2)) * deg;
    }
    return [CH_GEO.cx + CH_GEO.rx * Math.cos(th), CH_GEO.cy + CH_GEO.ry * Math.sin(th)];
  }

  /** 桩号 → 北门车位键：'A03' / '北-A3 号桩' / 'a3' 都归一成 'A03' */
  function bmKey(code) {
    var s = String(code || '').toUpperCase().replace(/\s+/g, '');
    var m = s.match(/([A-D])-?(\d{1,2})(?!\d)/);
    return m ? m[1] + String(Number(m[2])).padStart(2, '0') : '';
  }
  /** 桩号 → 点位里那两个字符：'北-A01 号桩' → 'A1'，'C11' → 'C11' */
  function shortCode(code) {
    var k = bmKey(code);
    if (k) return k.charAt(0) + String(Number(k.slice(1)));
    var m = String(code || '').toUpperCase().match(/[A-Z]?\d{1,2}/);
    return m ? m[0] : String(code || '?').slice(0, 3);
  }
  /** 桩号 → 朝晖弧序号：'TY-07' / 'TZ-36' / '… 7 号桩' 取最后一段数字 */
  function arcSeq(code) {
    var m = String(code || '').match(/(\d+)(?!.*\d)/);
    var n = m ? Number(m[1]) : 0;
    return n >= 1 && n <= CH_GEO.total ? n : 0;
  }

  /** 把一个分区的桩逐台落到静态图的位置上；编号认不出的按顺序补进空位 */
  function layoutPiles(list, areaKey) {
    var out = [], i, used = {};
    if (areaKey === '渭水-北门') {
      list.forEach(function (p) {
        var spot = BM_BY_CODE[bmKey(p.code)];
        if (spot && !used[spot.code]) {
          used[spot.code] = 1;
          out.push({ p: p, pos: bmGeo(spot.x, spot.y) });
        } else {
          out.push({ p: p, pos: null });
        }
      });
      var spare = BM_PX.filter(function (s) { return !used[s.code]; });
      out.forEach(function (o) {
        if (!o.pos && spare.length) { var s = spare.shift(); o.pos = bmGeo(s.x, s.y); }
      });
    } else {
      list.forEach(function (p) {
        var seq = arcSeq(p.code);
        if (seq && !used[seq]) {
          used[seq] = 1;
          var px = arcPx(seq);
          out.push({ p: p, pos: chGeo(px[0], px[1]) });
        } else {
          out.push({ p: p, pos: null });
        }
      });
      var empty = [];
      for (i = 1; i <= CH_GEO.total; i++) if (!used[i]) empty.push(i);
      out.forEach(function (o) {
        if (!o.pos && empty.length) {
          var px2 = arcPx(empty.shift());
          o.pos = chGeo(px2[0], px2[1]);
        }
      });
    }
    return out.filter(function (o) { return !!o.pos; });
  }

  /** 某分区桩阵的外接框（用真实落点算，供相机取景） */
  function areaBBox(areaKey) {
    var laid = layoutPiles(piles.filter(function (p) { return p.location === areaKey; }), areaKey);
    var w = Infinity, e = -Infinity, s = Infinity, n = -Infinity;
    laid.forEach(function (o) {
      w = Math.min(w, o.pos[0]); e = Math.max(e, o.pos[0]);
      s = Math.min(s, o.pos[1]); n = Math.max(n, o.pos[1]);
    });
    if (!isFinite(w)) {
      var a = D.areas[areaKey];
      if (!a) return null;
      w = Math.min(a.line[0][0], a.line[1][0]); e = Math.max(a.line[0][0], a.line[1][0]);
      s = Math.min(a.line[0][1], a.line[1][1]); n = Math.max(a.line[0][1], a.line[1][1]);
    }
    return { w: w, e: e, s: s, n: n };
  }

  function unionBBox(boxes) {
    var w = Infinity, e = -Infinity, s = Infinity, n = -Infinity;
    boxes.forEach(function (b) {
      if (!b) return;
      w = Math.min(w, b.w); e = Math.max(e, b.e);
      s = Math.min(s, b.s); n = Math.max(n, b.n);
    });
    if (!isFinite(w)) return { w: D.bounds.west, e: D.bounds.east, s: D.bounds.south, n: D.bounds.north };
    return { w: w, e: e, s: s, n: n };
  }

  /* ---------- 桩点内容（点内写桩号，颜色表状态） ----------
   * 2026-10-20 用户指定：点内标注序号；绿=还有空位，红=全部占用，灰=设备离线。
   * 离线判断沿用页面里 levelOf() 的口径：拿不到端口数据（total 为 0）就算离线。
   */
  function pileContent(code, free, total) {
    var off = !total;
    var ok = total > 0 && free > 0;
    var cls = off ? 'off' : (ok ? 'free' : 'busy');
    return '<div class="pile ' + cls + '">' + shortCode(code) + '</div>';
  }

  /* ---------- 底图图层（只建一次） ---------- */
  function buildLayers() {
    // 校园边界
    campusLayer = new AMap.Polyline({
      path: D.boundary.map(LL),
      strokeColor: '#0F6E56', strokeWeight: 2, strokeStyle: 'dashed', strokeOpacity: 0.85,
      map: map,
    });

    // 建筑
    bldLayer = new AMap.GeoJSON({
      geoJSON: toGeoJSON(D.buildings),
      getPolygon: function (f, lnglats) {
        return new AMap.Polygon({ path: lnglats, fillColor: '#CFD8CB', fillOpacity: 0.55, strokeColor: '#8FA98A', strokeWeight: 1 });
      },
    });
    map.add(bldLayer);

    // 场地
    venueLayer = new AMap.GeoJSON({
      geoJSON: toGeoJSON(D.venues),
      getPolygon: function (f, lnglats) {
        return new AMap.Polygon({ path: lnglats, fillColor: '#D7E6CE', fillOpacity: 0.45, strokeColor: '#9DB98C', strokeWeight: 1 });
      },
    });
    map.add(venueLayer);

    // 水域（分普通水域 / 试验场）
    waterLayer = new AMap.GeoJSON({
      geoJSON: toGeoJSON(D.water.filter(function (w) { return !/试验场/.test(w.n); })),
      getPolygon: function (f, lnglats) {
        return new AMap.Polygon({ path: lnglats, fillColor: '#BCD9E8', fillOpacity: 0.55, strokeColor: '#7FB2CB', strokeWeight: 1 });
      },
    });
    map.add(waterLayer);
    var testLayer = new AMap.GeoJSON({
      geoJSON: toGeoJSON(D.water.filter(function (w) { return /试验场/.test(w.n); })),
      getPolygon: function (f, lnglats) {
        return new AMap.Polygon({ path: lnglats, fillColor: '#DED8C6', fillOpacity: 0.50, strokeColor: '#C3B99E', strokeWeight: 1 });
      },
    });
    map.add(testLayer);

    // 建筑层按缩放分级：放大后才叠轮廓；桩点外观也跟着缩放分级
    map.on('zoomend', function () {
      var show = map.getZoom() >= 16.3;
      if (bldLayer) { try { bldLayer.show(); } catch (e) {} }
      if (bldLayer) bldLayer.setOptions && bldLayer.setOptions({ visible: show });
      applyZoomTier();
    });
  }

  /* 桩点外观按「相邻两桩在屏幕上隔多少像素」来定，不再按固定 zoom 阈值。
   * 之前写死 18.3 级出桩号，结果容器宽一点窄一点就算出 18.1 或 18.5，
   * 同一份代码在别人手机上桩号直接消失 —— 阈值必须跟着实际像素走。
   *
   *   gap = 一格车位（约 6.5m）折算成当前缩放下的像素
   *   gap <  9  → 九像素圆点（校园总览那种距离，37 个点挤一块只能看点色）
   *   gap < 13  → 十三像素方点（还没到能看清两个字符的宽度）
   *   gap ≥ 13  → 16×15 方框徽章，框内写桩号（A1 / C11 / D14）
   *
   * 注意：高德 setZoomAndCenter 之后 zoomend 回调里 getZoom() 可能还是旧值（试过两次都这样），
   * 所以程序化设视野时把「目标 zoom」直接传进来，别去读 map.getZoom()。 */
  var CELL_M = 6.5;               // 北门一格车位的实际边长（米）
  var LAT_COS = Math.cos(34.375 * Math.PI / 180);
  function applyZoomTier(z) {
    if (!host) return;
    if (typeof z !== 'number') z = map ? map.getZoom() : 0;
    var res = 156543.03392 * LAT_COS / Math.pow(2, z);   // 米/像素
    var gap = CELL_M / Math.max(res, 1e-6);
    host.classList.toggle('zoom-far', gap < 9);
    host.classList.toggle('zoom-mid', gap >= 9 && gap < 13);
    host.dataset.gap = gap.toFixed(1);
  }

  function toGeoJSON(items) {
    return {
      type: 'FeatureCollection',
      features: items.map(function (it) {
        return {
          type: 'Feature',
          properties: { name: it.n },
          geometry: { type: 'Polygon', coordinates: it.p },
        };
      }),
    };
  }

  /* ---------- 总览气泡（分区徽章） ---------- */
  function rebuildBadges() {
    clearLayer(badgeLayer); badgeLayer = null;

    var groups = {};
    piles.forEach(function (p) {
      var a = D.areas[p.location];
      if (!a) return;
      if (!groups[p.location]) groups[p.location] = { free: 0, n: 0, line: a.line, name: a.name };
      groups[p.location].n++;
      if (p.free > 0) groups[p.location].free += p.free;
    });

    var markers = [];
    BADGE_POS = {};
    // 区域徽章挂在桩阵外接框的外侧（北门往北、朝晖往南），别压住照搬过来的桩位；
    // 单行小胶囊，避免两张 13m 高的车图被徽章盖住
    var OUT = { '渭水-北门': 0.00021, '渭水-朝晖体育场南': -0.00034 };
    // 北门那块的徽章在总览里会顶到容器左边缘（校门在校园最西侧），往东借 20m 才不贴边
    var BM_BADGE_DX = 0.00022;
    Object.keys(groups).forEach(function (loc) {
      var g = groups[loc];
      var b = areaBBox(loc);
      var mid = b
        ? [
            // 北门桩阵是斜的，AABB 中点会偏到地块西侧、徽章压到容器边，
            // 直接钉在地块中心线上并往东借一点，总览里就压在桩阵正上方
            loc === '渭水-北门' ? BM_GEO.lng + BM_BADGE_DX : (b.w + b.e) / 2,
            (loc === '渭水-北门' ? b.n : b.s) + (OUT[loc] || 0),
          ]
        : [(g.line[0][0] + g.line[1][0]) / 2, (g.line[0][1] + g.line[1][1]) / 2];
      BADGE_POS[loc] = mid;
      var ok = g.free > 0;
      var l2 = g.n + ' 台' + (ok ? ' · ' + g.free + ' 空位' : ' · 已满');
      markers.push(new AMap.Marker({
        position: mid,
        anchor: 'center',
        content: '<div style="background:#fff;border:2px solid ' + (ok ? '#3E8E52' : '#B5443A')
          + ';border-radius:12px;padding:3px 10px;white-space:nowrap;box-shadow:0 1px 4px rgba(0,0,0,.28)">'
          + '<span style="font-size:12.4px;font-weight:700;color:#2B2F28">' + g.name + '</span>'
          + '<span style="font-size:11px;color:#5F665C;margin-left:5px">' + l2 + '</span></div>',
        extData: { area: loc },
      }));
    });

    if (!markers.length) return;
    badgeLayer = markers;
    markers.forEach(function (m) {
      m.setMap(map);
      m.on('click', function () {
        var id = m.getExtData().area;
        if (id && onPileCb) onPileCb({ type: 'area', id: id });
      });
    });
  }

  /* ---------- 桩层：逐台一个点，不再把整个分区压成一个气泡 ---------- */
  function rebuildPins() {
    clearLayer(pinLayer); pinLayer = null;
    PIN_POS = {};

    var pinMarkers = [];

    Object.keys(D.areas).forEach(function (area) {
      var list = piles.filter(function (p) { return p.location === area; });
      if (!list.length) return;

      layoutPiles(list, area).forEach(function (o) {
        var p = o.p, pos = o.pos;
        PIN_POS[p.id] = pos;
        pinMarkers.push(new AMap.Marker({
          position: pos, anchor: 'center',
          content: pileContent(p.code, p.free, p.total),
          extData: { id: p.id },
          title: p.code + ' · ' + (p.total ? p.free + '/' + p.total + ' 空闲' : '无数据'),
        }));
      });
    });

    pinLayer = pinMarkers;

    pinMarkers.forEach(function (m) {
      m.setMap(map);
      m.on('click', function () {
        var d = m.getExtData();
        if (d.area) onPileCb && onPileCb({ type: 'area', id: d.area });
        else if (d.id && onPileCb) onPileCb({ type: 'pile', id: d.id });
      });
    });
  }

  function clearLayer(arr) {
    if (!arr) return;
    if (!Array.isArray(arr)) arr = [arr];
    arr.forEach(function (m) { try { m.setMap(null); } catch (e) {} });
  }

  function syncLayers() {
    var isCampus = curView === 'campus';
    if (badgeLayer) badgeLayer.forEach(function (m) { m.setMap(isCampus ? map : null); });
    // 桩点：总览显示（或分区内也显示），这里简化为总览 + 分区都显示桩点
    if (pinLayer) {
      var showPin = true;
      pinLayer.forEach(function (m) {
        var d = m.getExtData();
        if (!isCampus && d.id) {
          var p = null;
          piles.forEach(function (q) { if (q.id === d.id) p = q; });
          showPin = p && p.location === curView;
        } else if (!isCampus && d.area) {
          showPin = d.area === curView;
        } else {
          showPin = true;
        }
        m.setMap(showPin ? map : null);
      });
    }
  }

  /* ---------- 相机 ----------
   * 取景一律按「照搬过来的桩阵外接框」算，不再用分区排布线：
   * 桩位跟着静态图的分布走以后，北门那块只有 90m 宽、朝晖那个 U 约 300m 宽，
   * 按排布线取景会让桩阵偏在一边。允许活动的范围仍是整个校区（limitBounds），拖不走。
   */
  /* pad：四周留白比例；minZ：缩放托底
     托底是为了让「桩号方框」稳定出现 —— 容器窄的时候按 bbox 算出来只有 18.0 级，
     桩距折算成像素不够 13px，桩号就被降级成圆点，同一份代码在不同手机上长得不一样。 */
  function fitBBox(b, pad, minZ) {
    var el = host || document.getElementById('amap-host');
    var cw = (el && el.clientWidth) || 360;
    var ch = (el && el.clientHeight) || 640;
    var lat = (b.s + b.n) / 2;
    var cosLat = Math.cos(lat * Math.PI / 180);
    var res0 = 156543.03392 * cosLat;
    var k = 1 + (pad || 0);
    var spanLon = Math.max(1, (b.e - b.w) * 111320 * cosLat * k);
    var spanLat = Math.max(1, (b.n - b.s) * 110540 * k);
    var zx = Math.log2(res0 * cw / spanLon);
    var zy = Math.log2(res0 * ch / spanLat);
    var z = Math.max(minZ || 14, Math.min(19.4, Math.min(zx, zy)));
    map.setZoomAndCenter(z, [(b.w + b.e) / 2, lat]);
    // 先按目标档位刷一次，再靠 zoomend / 定时器兜住高德回填 zoom 的延迟
    applyZoomTier(z);
    setTimeout(function () { applyZoomTier(z); }, 60);
    setTimeout(function () { applyZoomTier(z); }, 400);
  }

  function fitCampus() {
    var b = unionBBox(Object.keys(D.areas).map(areaBBox));
    // 徽章挂在桩阵外侧，取景时把它一起算进去，否则会贴边被裁
    Object.keys(BADGE_POS).forEach(function (k) {
      var p = BADGE_POS[k];
      if (!p) return;
      b = {
        w: Math.min(b.w, p[0]), e: Math.max(b.e, p[0]),
        s: Math.min(b.s, p[1]), n: Math.max(b.n, p[1]),
      };
    });
    fitBBox(b, 0.10);
  }

  function applyCamera() {
    if (curView === 'campus') {
      fitCampus();
    } else {
      var b = areaBBox(curView);
      // 北门桩阵只占一块 137m×58m 的地块，留白 9%（窄屏单边约 15px，扣掉徽章半宽 8px 还剩 7px，
      // 最东头的 D14 不会被容器切掉），缩放托底 18.05 级 —— 低于这个级别桩距不够 13px，桩号就降级成圆点
      if (b) fitBBox(b, curView === '渭水-北门' ? 0.09 : 0.22, curView === '渭水-北门' ? 18.05 : 0);
      else fitCampus();
    }
    try { map.resize(); } catch (e) {}
    // 档位已经在 fitBBox 里按目标 zoom 设过了，这里再读 map.getZoom() 反而会拿旧值覆盖
  }

  /* ---------- 对外 ---------- */
  var api = {
    ready: function () { return ready; },
    failed: function () { return failed; },

    mount: function (hostEl, opts) {
      opts = opts || {};
      mountCount++;
      host = hostEl;
      onFailCb = opts.onFail || null;
      onPileCb = opts.onPileClick || null;
      if (typeof CHD_MAP === 'undefined') { failed = true; onFailCb && onFailCb('data'); return; }
      D = CHD_MAP;

      function init() {
        try {
          map = new AMap.Map(host, {
            viewMode: '2D',
            zoom: 15.2,
            center: LL(D.campusCenter),
            features: ['bg', 'road', 'building'],
            limitBounds: new AMap.Bounds(
              [D.bounds.west, D.bounds.south],
              [D.bounds.east, D.bounds.north]
            ),
            showLabel: false,
          });
        } catch (e) {
          failed = true;
          failReason = 'init:' + ((e && e.message) || e);
          console.warn('[CHD_AMAP]', failReason);
          onFailCb && onFailCb(failReason);
          return;
        }

        // 2.0 的覆盖物必须等底图 complete 之后再挂，否则 Polyline / GeoJSON 会抛错
        var built = false;
        function build() {
          if (built || failed) return;
          built = true;
          try { buildLayers(); } catch (e) { console.warn('[CHD_AMAP] 图层构建失败', e); }
          ready = true;
          try { map.resize(); } catch (e) {}
          try { applyCamera(); } catch (e) { console.warn('[CHD_AMAP] 相机失败', e); }
          opts.onReady && opts.onReady();
        }
        map.on('complete', build);
        setTimeout(build, 1500);   // 兜底：瓦片慢或 complete 没触发时也把桩点画出来
      }

      if (window.AMap) { init(); return; }

      // 没配 Key 就别去请求 SDK（会 401 且刷一堆无意义的报错），直接告诉调用方
      if (!AMAP_KEY || !AMAP_SCODE) {
        failed = true;
        failReason = 'nokey';
        console.warn('[CHD_AMAP] 未配置高德 Key：请复制 map-key.example.js 为 map-key.local.js 并填入自己的 Key');
        onFailCb && onFailCb(failReason);
        return;
      }

      window._AMapSecurityConfig = { securityJsCode: AMAP_SCODE };
      var s = document.createElement('script');
      s.src = SDK + '&key=' + encodeURIComponent(AMAP_KEY);
      s.onload = function () { if (window.AMap) init(); else { failed = true; failReason = 'load:empty'; onFailCb && onFailCb(failReason); } };
      s.onerror = function () { failed = true; failReason = 'load:error'; onFailCb && onFailCb(failReason); };
      document.head.appendChild(s);

      setTimeout(function () {
        if (!ready && !failed) {
          failed = true;
          failReason = 'timeout';
          onFailCb && onFailCb(failReason);
        }
      }, 8000);
    },

    setPiles: function (list, opts2) {
      piles = list || [];
      if (!ready) return;
      rebuildBadges();
      rebuildPins();
      syncLayers();
      // opts2.keepCamera：刷新数据时别把用户正在看的视角拉回全景
      if (!(opts2 && opts2.keepCamera)) applyCamera();
    },

    setView: function (view) {
      if (!ready) return;
      curView = view;
      syncLayers();
      applyCamera();
    },

    focusPile: function (id) {
      if (!ready) return false;
      var target = null;
      piles.forEach(function (q) { if (q.id === id) target = q; });
      if (!target || !PIN_POS[id]) return false;
      if (curView !== target.location) { curView = target.location; syncLayers(); }
      map.setZoomAndCenter(19.2, PIN_POS[id]);
      return true;
    },

    resize: function () { if (map && map.resize) try { map.resize(); } catch (e) {} },

    debug: function () {
      var ks = Object.keys(PIN_POS);
      return {
        view: curView, piles: piles.length, ready: ready, failed: failed,
        failReason: failReason, mountCount: mountCount,
        badges: badgeLayer ? badgeLayer.length : 0,
        pins: pinLayer ? pinLayer.length : 0,
        zoom: map ? map.getZoom() : null,
        sample: ks.slice(0, 3).map(function (k) { return k + ':' + PIN_POS[k].join(','); }),
        sampleLast: ks.length ? PIN_POS[ks[ks.length - 1]].join(',') : '',
      };
    },

    destroy: function () {
      clearLayer(badgeLayer); clearLayer(pinLayer);
      try { if (map) map.destroy(); } catch (e) {}
      badgeLayer = null; pinLayer = null; PIN_POS = {};
      map = null; ready = false;
      if (host) host.innerHTML = '';
    },
  };

  window.CHD_AMAP = api;
})();

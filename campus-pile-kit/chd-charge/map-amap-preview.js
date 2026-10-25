/* 高德地图运行时（校园语义层覆盖）
 * 依赖 map-data.js 提供的 window.CHD_MAP（GCJ-02 坐标，腾讯/高德通用）
 * 对外接口：CHD_AMAP.mount / setView / setZoom / setPiles / focusPile / resize / destroy
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
  /* 高德底图样式 —— **这是 ②「校外留白」与 ③「参考图风格」的唯一开关**。
   * 现在挂的是内置 `fresh`（浅绿清爽）。产品方在高德控制台做完「自定义地图样式」
   * 并把校外调成留白后，把下面这行换成 `'amap://styles/<你的styleId>'` 即可 —— 代码不用再动。
   * 详见 `buildLayers()` 里那段说明。 */
  var MAP_STYLE = 'amap://styles/fresh';
  var map = null, host = null;
  var bldLayer = null, venueLayer = null, waterLayer = null, campusLayer = null;
  var labelLayer = null;        // 楼名 / 地标名 / 水域名（HTML Marker 数组，缩放够近才显）
  var badgeLayer = null;        // 总览的分区气泡
  var pinLayer = null;          // 桩层（点内直接写桩号，不再单独挂文字标签）
  var clusterLayer = null;      // 缩小时的「分区聚合圈」层（绿圈=可用数，红圈=×）
  var piles = [];               // [{id, code, location, free, total}]
  var curView = 'campus';
  var ready = false, failed = false;
  var failReason = '', mountCount = 0;
  var onFailCb = null, onPileCb = null, onViewCb = null;
  var PIN_POS = {};             // id -> [lng, lat]（供 focusPile 用）
  var BADGE_POS = {};           // 分区 -> [lng, lat]（取景要把徽章也算进去，否则会被裁掉）
  var CLUSTER_POS = {};         // 分区 -> [lng, lat]（缩小时的聚合圈位置）
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
  //
  // ⚠️ 2026-10-21 修：`cx/cy/rx/ry` 原来是 v1.70 的手绘值（511/784/368/501），
  //   但那套半径**比体育场外接框还大**（rx 368 > 半宽 219.5），在 1024×1536 的抽象手绘图上
  //   看着没问题，一旦按真实经纬度换算，左右各甩出去约 60m/57m ——
  //   点会落到体育场外的马路和居民楼上（产品方一眼看出「不成弧」就是这个原因）。
  //
  //   本图 x/y 两向的比例还不一样：kx≈0.3923 m/px、ky≈0.2079 m/px，**相差 1.887 倍**
  //   （因为手绘体育场是 439×936 的长条，真实体育场却近圆形 172×195m）。
  //   所以不能直接照搬像素半径，只能**按外接框对齐**：
  //     cx = (295+734)/2 = 514.5   cy = (307+1243)/2 = 775
  //     rx = 半宽 (734-295)/2 = 219.5   ry = 半高 (1243-307)/2 = 468
  //   改完东西跨度 = 2×219.5×0.3923 ≈ 172.2m = 真实体育场宽度（不是巧合：
  //   1.887 倍的各向异性恰好补偿了 bbox 的 1:2.13 长宽比）。
  //
  //   **角度区间、leftCount、total 一个都不能动** —— 那才是产品方要的「v1.70 分布」本身。
  var CH_GEO = {
    px: { x0: 295, y0: 307, x1: 734, y1: 1243 },
    geo: { w: 108.910110, n: 34.375411, e: 108.911984, s: 34.373651 },
    cx: 514.5, cy: 775, rx: 219.5, ry: 468,
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
  /* ===== 「线段型分区」：桩位就是**一串固定经纬度** =====
   * 与另外两种分区都不同：北门是把像素布局整块搬进地块、朝晖是围体育场的两段弧，
   * 而这两个分区的桩位是**产品方在图上圈出一条红线**，我把红线两端像素配准后
   * 换算成经纬度、再等分出来的。见 `map-data.js` 里 `areas` 的注释。
   * 2026-10-21 新增两个（第二个是当天下午加的，所以这里做成表 —— 避免再抄第三遍抄错）： */
  var E_GEO = [
    // 20号楼（公路学院）：横线，E-01~E-24 **从左到右**。红线全长约 121m ÷ 23 段 ≈ 5.25m 一档。
    [108.892845, 34.367344], [108.892901, 34.367357], [108.892956, 34.367369], [108.893012, 34.367381],
    [108.893068, 34.367393], [108.893124, 34.367405], [108.893180, 34.367417], [108.893236, 34.367429],
    [108.893292, 34.367441], [108.893348, 34.367453], [108.893404, 34.367465], [108.893460, 34.367478],
    [108.893516, 34.367490], [108.893572, 34.367502], [108.893628, 34.367514], [108.893684, 34.367526],
    [108.893740, 34.367538], [108.893796, 34.367550], [108.893852, 34.367562], [108.893908, 34.367574],
    [108.893963, 34.367586], [108.894019, 34.367599], [108.894075, 34.367611], [108.894131, 34.367623],
  ];
  var W_GEO = [
    // 物业服务中心：**竖**线，W-01~W-12 **自下而上**（产品方原话「从下到上」）。
    // 红线两端 ≈ (607,963)=下端 / (578,793)=上端；线长约 41.5m ÷ 11 段 ≈ 3.8m 一档。
    // 位置在西区后勤管理中心（108.89616, 34.369613）的西北侧。
    [108.896000, 34.369790], [108.895993, 34.369823], [108.895986, 34.369857], [108.895978, 34.369891],
    [108.895971, 34.369924], [108.895964, 34.369958], [108.895957, 34.369991], [108.895950, 34.370025],
    [108.895943, 34.370058], [108.895935, 34.370092], [108.895928, 34.370125], [108.895921, 34.370159],
  ];
  var LINE_AREAS = [
    { loc: '渭水-20号楼',       prefix: 'E', geo: E_GEO },
    { loc: '渭水-物业服务中心', prefix: 'W', geo: W_GEO },
  ];
  function lineAreaOf(loc) {
    for (var i = 0; i < LINE_AREAS.length; i++) {
      if (LINE_AREAS[i].loc === loc) return LINE_AREAS[i];
    }
    return null;
  }
  /** 桩号 → 线段型分区的序号：'E-01' → 1、'W‑03' → 3、'E01' → 1；认不出返回 0。
   *
   *  ⚠️ **必须在 `arcSeq` 之前调用**：`arcSeq` 的判据是"取末尾数字、落在 1~36 就算朝晖"，
   *  而 `E-01` / `W-03` 的末尾数字正是 1 / 3 → 会被误判成朝晖 `T01` / `T03`，
   *  **桩点也会被整批摆到体育场那两条弧上**（2026-10-21 连着踩了两次：先 E、后 W）。
   *
   *  ⚠️ 连字符要容错：产品方给的清单里用的是**不换行连字符 `‑`（U+2011）**，不是普通 `-`。
   *  只认 `-` 的话 `W‑01` 认不出来 → 又掉回朝晖分支。这里把几种破折号都收进来。 */
  function lineSeq(code, prefix) {
    var s = String(code || '').toUpperCase().replace(/\s+/g, '');
    var m = s.match(new RegExp('(?:^|[^A-Z])' + prefix + '[\\-\\u2011\\u2013\\u2014\\u2212]?(\\d{1,2})(?!\\d)'));
    return m ? Number(m[1]) : 0;
  }
  /** 桩号 → 点位里那两个字符：'北-A01 号桩' → 'A1'，'C11' → 'C11'，'TY-07' → 'T07' */
  function shortCode(code) {
    var k = bmKey(code);
    if (k) return k.charAt(0) + String(Number(k.slice(1)));
    /* 线段型分区（E / W）要在 arcSeq **之前**判 —— 见 lineSeq 的注释。
     * 这里按前缀逐个试：E 前缀的正则不会误吞 'W-01'，反之亦然（正则要求前缀字母本身）。 */
    for (var li = 0; li < LINE_AREAS.length; li++) {
      var la = LINE_AREAS[li];
      var n = lineSeq(code, la.prefix);
      if (n >= 1 && n <= la.geo.length) return la.prefix + String(n).padStart(2, '0');
    }
    // 2026-10-21 修：朝晖要显示 `T01~T36`（产品方明确要求）。
    // 原来落到下面那条兜底正则 `/[A-Z]?\d{1,2}/` 上，'TY-07' 会被吃成 **'07'**（丢了 T）——
    // 因为 `[A-Z]?` 在 'T' 后面接不上数字（'Y' 不是数字），正则回溯后从 '07' 开始匹配。
    // 现在用 arcSeq（取末尾数字 → 1~36 的弧序号）先兜一层，拼成 'T' + 两位。
    // 注意 arcSeq 定义在本函数之后，靠函数声明提升，调用没问题。
    var seq = arcSeq(code);
    if (seq) return 'T' + String(seq).padStart(2, '0');
    var m = String(code || '').toUpperCase().match(/[A-Z]?\d{1,2}/);
    return m ? m[0] : String(code || '?').slice(0, 3);
  }
  /** 桩号 → 朝晖弧序号：'TY-07' / '… 7 号桩' 取最后一段数字
   *  ⚠️ 别拿 `TZ-36` 当例子 —— 数据里根本没有 `TZ` 这一组（只有 `TY-01~36`），
   *     这个不存在的例子曾误导过一轮排查。而且**"只看末尾数字"本身就是坑**：
   *     调用方必须先确认分区（用 `mapAreaOf()`），否则 `E-01`/`W-01` 会被当成朝晖桩。 */
  function arcSeq(code) {
    var m = String(code || '').match(/(\d+)(?!.*\d)/);
    var n = m ? Number(m[1]) : 0;
    return n >= 1 && n <= CH_GEO.total ? n : 0;
  }

  /** 把一个分区的桩逐台落到静态图的位置上；编号认不出的按顺序补进空位 */
  function layoutPiles(list, areaKey) {
    var out = [], i, used = {};
    /* 【线段型分区】20号楼（横线，E-01~E-24 从左到右）、物业服务中心（竖线，W-01~W-12 自下而上）。
     * 桩位就是 `geo` 里那串固定经纬度，按桩号序号取第 n 个。
     * ⚠️ 这个分支必须放在**最后那个 else（朝晖弧）之前** —— 那个 else 用 `arcSeq` 认桩号
     *   （"末尾数字在 1~36 内就算朝晖"），而 `E-01`/`W-03` 的末尾数字正是 1/3，
     *   整批会被摆到体育场那两条弧上（2026-10-21 连着踩了两次）。 */
    var lineArea = lineAreaOf(areaKey);
    if (lineArea) {
      list.forEach(function (p) {
        var seq = lineSeq(p.code, lineArea.prefix);
        // 带 `!used[seq]` 去重：同一编号出现两次时，后一台走下面的补位分支，不会两点重叠
        if (seq >= 1 && seq <= lineArea.geo.length && !used[seq]) {
          used[seq] = 1;
          out.push({ p: p, pos: lineArea.geo[seq - 1].slice() });
        } else {
          out.push({ p: p, pos: null });
        }
      });
      // 编号认不出的（或重复的）按顺序补进空着的点，别让它们掉出地图
      var emptyLine = [];
      for (i = 1; i <= lineArea.geo.length; i++) if (!used[i]) emptyLine.push(i);
      out.forEach(function (o) {
        if (!o.pos && emptyLine.length) {
          var idx = emptyLine.shift();
          used[idx] = 1;
          o.pos = lineArea.geo[idx - 1].slice();
        }
      });
    } else if (areaKey === '渭水-北门') {
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
  /* ---------- 逐 feature 建多边形 ----------
   * 🔴 2026-10-21 修 #44：**高德 2.0 没有 `AMap.GeoJSON`**（`typeof AMap.GeoJSON === 'undefined'`），
   *   原来 `new AMap.GeoJSON({...})` 在**第一个建筑层**就抛
   *   `TypeError: AMap.GeoJSON is not a constructor` → `buildLayers()` 从这里中断，
   *   **建筑 / 场地 / 水域三层从未渲染过**（地图上只有一条边界虚线），
   *   而且外层的 try/catch 把异常吞了、`ready` 照常置 true —— 属于「看着正常、功能全废」。
   *   改成逐 feature 建 `AMap.Polygon`（已实测 2.0 可用，`CLASS_NAME === 'Overlay.Polygon'`）。
   *
   * ⚠️ 注意 `it.p` 的形状是 **`[[[lng,lat],…]]`（环的数组）**，不是点的数组：
   *   环数 = 1 时直接把那一环当 path（最常见）；多环（带洞）时把整组传进去。
   *   WorkBuddy 方案里写的 `it.p.map(LL)` 会把「环」当成「点」传给 LL，这里按真实形状修正。 */
  function polygonsOf(items, opts) {
    return (items || []).map(function (it) {
      var rings = (it.p || []).map(function (ring) { return ring.map(LL); });
      return new AMap.Polygon(Object.assign({ path: rings.length === 1 ? rings[0] : rings }, opts));
    });
  }

  /** 多边形外环的形心（够用即可：取所有顶点的算术平均） */
  function centroidOf(p) {
    var ring = (p && p[0]) || [];
    if (!ring.length) return null;
    var sx = 0, sy = 0;
    for (var i = 0; i < ring.length; i++) { sx += ring[i][0]; sy += ring[i][1]; }
    return [sx / ring.length, sy / ring.length];
  }

  /** 楼名 / 地标名 / 水域名的文字标签
   *  用 `AMap.Marker` + HTML 而不是 `AMap.Text`：**Marker 已确认在 2.0 存在**（全项目都在用），
   *  而 `AMap.Text` 没验过（#44 的教训就是别用没验过的类）。
   *  样式按产品方给的参考图（汕大那套）来：灰绿色字 + 白色柔光描边，不抢底图。 */
  function labelMarker(text, pos, kind) {
    return new AMap.Marker({
      position: pos,
      anchor: 'center',
      content: '<div class="campus-label campus-label--' + (kind || 'bld') + '">'
        + String(text || '').replace(/[&<>"]/g, function (c) {
            return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c];
          })
        + '</div>',
      zIndex: 60,
      // 标签只作显示用，别挡住底下的桩点点击
      clickable: false,
    });
  }

  function buildLayers() {
    /* 底图风格（产品方要求 ③）—— 统一走文件顶部的 `MAP_STYLE` 常量，这里**只设一次**。
     * 曾经的坑：这一块和下面「②③ 说明」那块各写过一次 `setMapStyle`（值相同），
     * 会触发两次样式切换；改样式只改常量、别在别处再调一次。 */
    try {
      if (map.setMapStyle) map.setMapStyle(MAP_STYLE);
    } catch (e) { console.warn('[CHD_AMAP] setMapStyle 失败，用默认样式', e); }

    // 校园边界
    campusLayer = new AMap.Polyline({
      path: D.boundary.map(LL),
      strokeColor: '#0F6E56', strokeWeight: 2, strokeStyle: 'dashed', strokeOpacity: 0.85,
      map: map,
    });

    /* 「边界以外的地图隐去」+「换成参考图那种风格」这两条（产品方要求 ②③）——
     * 🔴 2026-10-21 **产品方拍板：只走「高德控制台自定义地图样式」这条路，代码侧不做遮罩。**
     *   样式本身已在上面 `buildLayers()` 开头按 `MAP_STYLE` 设过一次，这里**不再重复调用**。
     *
     * 为什么代码侧不做：`map.setMask()` 在高德 2.0 上是**坏的** —— 三种传参实测：
     *   ① `setMask(D.boundary.map(LL))`    → `getMask()` = 30，但**整张底图变白**
     *      （只剩桩点和标签），并抛 `TypeError: Cannot read properties of undefined (reading '0')`，
     *      栈全在高德内部 `renderFrame` → **它自己崩了**，不是我们数据错。
     *   ② `setMask([D.boundary.map(LL)])`  → `getMask()` = 0，不生效。
     *   ③ `setMask(D.boundary)`（裸数组）   → `getMask()` = 0，不生效。
     * 对照组：正式版 `map-amap.js`（不调 setMask）同一流程 **0 异常**、底图正常。
     * 已排除时序（`build()` 挂在 `map.on('complete')` 里）与数据（30 点闭合环）。
     *
     * 【给产品方的两步操作 —— ② 和 ③ 在这里一次解决】
     *   1. 登录高德开放平台控制台 → 该 Key 对应的应用 → **自定义地图样式** → 新建；
     *      在样式编辑器里把**校园边界外**的地区调成与底图同色/纯白（即"校外留白"），
     *      再按参考图调：底色极浅、去饱和、道路/绿地/水域柔和绿 —— 这一步就是 ③ 要的效果。
     *   2. 发布该样式 → 拿到形如 `amap://styles/<styleId>` 的字符串 → 填到下面的 `MAP_STYLE`。
     *
     * 在那之前用高德内置样式 `fresh`（浅绿清爽）顶着，方向与参考图一致但**做不到"一样"**。
     * 备选内置样式（改 `MAP_STYLE` 一个词即可）：`whitesmoke`（最浅）/ `grassgreen`（更绿）/ `grey`（灰调）。 */

    // 建筑（配色按参考图调淡：浅灰绿块 + 更浅的描边）
    bldLayer = polygonsOf(D.buildings, {
      fillColor: '#E3E6DE', fillOpacity: 0.85, strokeColor: '#C6CDC0', strokeWeight: 1,
    });
    bldLayer.forEach(function (m) { m.setMap(map); });

    // 场地（运动场一类，参考图里用更暖的浅绿）
    venueLayer = polygonsOf(D.venues, {
      fillColor: '#DCE8D2', fillOpacity: 0.75, strokeColor: '#B4C7A6', strokeWeight: 1,
    });
    venueLayer.forEach(function (m) { m.setMap(map); });

    // 水域（分普通水域 / 试验场）
    waterLayer = polygonsOf(D.water.filter(function (w) { return !/试验场/.test(w.n); }), {
      fillColor: '#C9DEE6', fillOpacity: 0.80, strokeColor: '#9CC0CE', strokeWeight: 1,
    });
    waterLayer.forEach(function (m) { m.setMap(map); });
    var testLayer = polygonsOf(D.water.filter(function (w) { return /试验场/.test(w.n); }), {
      fillColor: '#E0DAC9', fillOpacity: 0.70, strokeColor: '#C3B99E', strokeWeight: 1,
    });
    testLayer.forEach(function (m) { m.setMap(map); });

    /* 楼名 / 地标名 / 水域名（产品方要求 ① 的前两项）。
     * 主干路名不在这里 —— 我们**没有道路数据**（`D.roads` 不存在），
     * 靠高德自己的注记出：见 `new AMap.Map` 里的 `showLabel: true`。 */
    var labels = [];
    (D.buildings || []).forEach(function (b) {
      var c = centroidOf(b.p);
      if (c && b.n) labels.push(labelMarker(b.n, c, 'bld'));
    });
    (D.venues || []).forEach(function (v) {
      var c = centroidOf(v.p);
      if (c && v.n) labels.push(labelMarker(v.n, c, 'venue'));
    });
    (D.water || []).forEach(function (w) {
      var c = centroidOf(w.p);
      if (c && w.n) labels.push(labelMarker(w.n, c, 'water'));
    });
    labelLayer = labels;
    labels.forEach(function (m) { m.setMap(map); });

    /* 🔴 2026-10-21：缩放分级**不再在这里绑**。
     *
     * 原来 `map.on('zoomend', …)` 是本函数的最后一句，而高德 2.0 没有 `AMap.GeoJSON`
     * （第 264 行 `new AMap.GeoJSON(...)` 抛 `TypeError: AMap.GeoJSON is not a constructor`）→
     * 函数在第一个建筑层就中断，**缩放监听从未绑定**。
     * 外层 `build()` 的 try/catch 又把异常吞了、`ready` 照常置 true，
     * 于是 v1.67~v2.00 这段期间：地图看着正常，但**手指捏合/拖拽缩放永远不切档**
     * （`gap` 恒为初始值，缩小后一直是方框徽章，聚合圈永远出不来）。
     *
     * 现在绑定挪到 `build()` 里 `buildLayers()` 的 try 之后（见 onZoomTier），
     * 与图层构建解耦：GeoJSON 修好之前，缩放档位也照常工作。 */
  }

  /* 桩点外观按「相邻两桩在屏幕上隔多少像素」来定，不再按固定 zoom 阈值。
   * 之前写死 18.3 级出桩号，结果容器宽一点窄一点就算出 18.1 或 18.5，
   * 同一份代码在别人手机上桩号直接消失 —— 阈值必须跟着实际像素走。
   *
   * 2026-10-21 产品方改成**两态**（原来是 far/mid/near 三态）：
   *   gap = 一格车位（约 6.5m）折算成当前缩放下的像素
   *   gap <  13  → 缩得太狠、逐台点会叠 → **只显示分区聚合圈**（绿圈写可用数 / 红圈 ×），
   *                逐台点全部隐藏
   *   gap ≥ 13  → 逐台点可读 → 显示逐台点（16×15 桩号胶囊），聚合圈隐藏
   *
   * 聚合圈 / 逐台点互斥，切换靠 CSS 类 + JS 显隐两层保证。
   *
   * 注意：高德 setZoomAndCenter 之后 zoomend 回调里 getZoom() 可能还是旧值（试过两次都这样），
   * 所以程序化设视野时把「目标 zoom」直接传进来，别去读 map.getZoom()。 */
  var CELL_M = 6.5;               // 北门一格车位的实际边长（米）
  var LAT_COS = Math.cos(34.375 * Math.PI / 180);
  /* 缩放档位阈值（gap = 一格车位在当前缩放下折算成多少屏幕像素）
   *
   * 🔴 2026-10-21 二次修正 —— 上一版这里改错了，产品方回复「更新结果不理想」。
   *
   * 产品方的**原始要求**（见沟通记录 02:09 转述，原话）：
   *   「**缩小到标点重叠后分区聚合成圈**、点圈放大到分区全景」
   * 也就是说：**一旦标点开始重叠，就该换成「一个分区 = 一个圈」**，
   * 圈里写可用数（绿）或 × （红），点圈放大到该分区全景。
   *
   * 上一版我误把「缩小地图显示一个点」理解成「每桩一个小圆点」，
   * 于是插了一档小点、还把聚合圈阈值从 13 挪到 5 ——
   * **等于把产品方要的「圈」推迟了约 1.4 个缩放级**，缩小后先看到一堆小点、看不到圈。
   * 这就是「还是没实现我想要的功能」的原因。现在改回：**标点一开始重叠就聚合成圈**。
   *
   *   gap ≥ GAP_BADGE    → 逐台 16×15 徽章 + 桩号（近景，A1 / C11 / T01）
   *   gap < GAP_CLUSTER  → **分区聚合圈**（= 产品方要的那一档）
   *
   * 两个常量现在**都是 13**（= 徽章宽 16px 与车位距 13px 的临界，标点开始互相压到的位置），
   * 所以中间那档「逐台小圆点」不生效（`dotted` 恒为 false），代码与 CSS 保留备用：
   * **把 `GAP_BADGE` 调到大于 `GAP_CLUSTER`，中间就会多出一档小圆点**（例如 13/5 就是三态）。
   * 想更早看到圈就把 `GAP_CLUSTER` 调大（16 = 徽章刚开始贴边）。 */
  var GAP_BADGE = 13;
  var GAP_CLUSTER = 13;
  var clustered = false;          // 分区聚合圈态（供 syncLayers 复用）
  var dotted = false;             // 逐台小圆点态（当前阈值下不生效，见上）
  /* 最近一次「程序化取景」的时刻（fitBBox / setZoom 会盖戳）。
   * 为什么要它：高德的 `map.getZoom()` 在 `setZoomAndCenter` 之后**长期滞后**——
   * 2026-10-21 实测点圈后 2.7 秒仍报 17.23，而真实档位是 18.05（gap 14.0）。
   * 于是 `onZoomTier` 里 `applyZoomTier()` 不传 z 时会读到动画中间值 → 假聚合态
   * → 把刚进的分区视图强退回总览。见 applyZoomTier 里那段视频式时序记录。 */
  var progZoomAt = 0;
  /* 首帧「飞入」动画（2026-10-24 产品方要求：打开地图时**从默认位置平移到目标位置**，不要瞬移到位）。
   *
   * 做法：mount 时相机停在 zoom 15.2 / campusCenter（默认位置），
   * 第一次取景走 `setZoomAndCenter(z, center, false, FLY_MS)` 让高德补间过去；
   * 之后（切页签、换筛选、刷新数据）一律直接到位 —— 每次都飞一遍既慢又烦，
   * 还会把用户自己拖到的视角拽走。
   * mount() 里会重置 firstCamera，所以「关掉再打开」会再飞一次，这正是要的效果。 */
  var FLY_MS = 700;
  var firstCamera = true;
  function applyZoomTier(z, allowViewReset) {
    if (!host) return;
    if (typeof z !== 'number') z = map ? map.getZoom() : 0;
    var res = 156543.03392 * LAT_COS / Math.pow(2, z);   // 米/像素
    var gap = CELL_M / Math.max(res, 1e-6);
    var wantCluster = gap < GAP_CLUSTER;
    /* 🔴 2026-10-21 修 bug：产品方报「点绿圈放大后再缩放，所有充电桩标志都消失，只能退出重进」。
     *
     * 根因（状态机漏洞）：点圈后 `curView` = '渭水-北门'（分区视图），此时再缩小 →
     *   `clustered = true` → `syncLayers` 里 `if (clustered) showPin = false` 把**逐台点全隐藏**；
     *   而聚合圈的显隐条件是 `isCampus && clustered`，此刻 `curView` 已不是 'campus'
     *   → **聚合圈也不显示** → 整张图两样都没有 = 空白，只能退出重进。
     *
     * 两道防线（互相独立，任一条都能挡住空白）：
     *   ① 这里：一旦要进聚合态，先把视图退回总览。语义上也对
     *      —— 缩到「标点重叠」那么远，本来就该看总览。
     *   ② `syncLayers` 里改用 `clusterOn = clustered && isCampus` 统一裁决，
     *      让「clustered 为真但不在总览」这个组合**永远不可能**同时藏掉两样东西。
     *
     * 🔴 2026-10-21 追加（WorkBuddy 实测发现 #43 的副作用）：
     *   ①原本是无条件执行的，于是「点圈放大」被自己打回来了。实测时序（手机 390×844）：
     *     t=120ms  view=朝晖  gap=14.0  piles=36   ← 点圈成功，已进分区
     *     t=252ms  view=campus gap=7.7  piles=0    ← onZoomTier 读到滞后 zoom 17.23，
     *                                               gap 7.7<13 → 判定聚合 → 强退总览
     *     t=546ms  gap=14.0（fitBBox 第二枪补正档位）但 view 已是 campus、piles=73
     *   → 用户看到的是「点圈只闪一下，然后回到全校、73 个点全铺开」。
     *   所以这条强退**只在用户主动缩放时**才允许（allowViewReset），程序化取景期间禁止；
     *   连档位重算本身也要跳过（见 onZoomTier 的 1200ms 窗口），否则中间态仍会抖。
     */
    if (wantCluster && curView !== 'campus' && allowViewReset) curView = 'campus';
    clustered = wantCluster;
    dotted = !clustered && gap < GAP_BADGE;              // 中间档 → 逐台小点
    host.classList.toggle('zoom-cluster', clustered);
    host.classList.toggle('zoom-dot', dotted);
    host.dataset.gap = gap.toFixed(1);
    // 小点大小**随 gap 自适应**：gap 越小点越小，缩到很小时不会糊成一坨。
    // 上限 13px（再大就退回徽章档了），下限 5px（保证还看得见）。
    host.style.setProperty('--pile-gap', gap.toFixed(2) + 'px');
    /* 建筑层 + 楼名标签随缩放显隐（阈值 16.3）。
     * ⚠️ 2026-10-25 从 onZoomTier 挪到这里：那边只有**用户手势缩放**才会跑到，
     *   而「打开地图的第一帧」是程序化取景（fitBBox → 本函数），**永远不经过它**。
     *   于是 z≈15 的总览上几十个楼名全铺着，把四个分区圈和底图都糊住（截图实测）。
     *   放在这里以后，程序化取景与手势缩放**共用同一条阈值**，不会再出现两套口径。
     *   `bldLayer` 自 2026-10-21 起是 AMap.Polygon 数组（#44 修掉 GeoJSON），
     *   不能调 .show()/.setOptions()，只能逐元素 setMap(map|null)。 */
    var showDetail = z >= 16.3;
    [bldLayer, labelLayer].forEach(function (arr) {
      if (!arr) return;
      arr.forEach(function (m) {
        try { m.setMap(showDetail ? map : null); } catch (e) {}
      });
    });
    // 显隐统一交给 syncLayers 裁决（它同时感知分区过滤 + 缩放态），这里只负责定态
    syncLayers();
  }

  /* 缩放分级的**唯一入口**（2026-10-21 新增）。
   *
   * 为什么不在 buildLayers() 里直接绑：见那边注释 —— 图层构建抛错会把它一起带走，
   * 结果「手势缩放永不切档」。现在 `build()` 里单独绑，与图层构建彻底解耦。
   *
   * 两个事件都挂：
   *   zoomend     —— 手势/程序化缩放结束，正常路径
   *   zoomchange  —— 动画过程中连续触发；兜住「部分容器 zoomend 滞后或丢失」的情况
   * 用 120ms 节流，避免动画期间每帧重建 73 个 marker 的显隐。
   * 注意这里**不传 z**，让 applyZoomTier 自己读 `map.getZoom()`：
   * 节流 120ms 后高德已回填真实 zoom，比在 zoomend 回调里立刻读更准（那边会读到旧值）。 */
  var tierTimer = 0;
  function onZoomTier() {
    if (tierTimer) return;
    tierTimer = setTimeout(function () {
      tierTimer = 0;
      if (!map) return;
      /* 程序化取景期间（fitBBox / setZoom）整段跳过：
       * 高德 getZoom 在 setZoomAndCenter 之后长期滞后（实测 2.7s 仍报旧值），
       * 这里算出来的会是假档位，把刚点开的分区视图打回总览。档位交给
       * fitBBox 自己的 setTimeout(60)/setTimeout(400) 两枪，它们都带显式 z。 */
      if (Date.now() - progZoomAt < 1200) return;
      /* 建筑层与楼名标签随缩放显隐 —— 2026-10-21 起 `bldLayer` 是 **AMap.Polygon 数组**
       *（#44 修掉了 `AMap.GeoJSON`），所以不能再调 `.show()` / `.setOptions()`，
       * 改成逐元素 `setMap(map|null)`；楼名标签（`labelLayer`）用同一条阈值一起显隐，
       * 免得缩到全校时几十个楼名糊成一团。
       * ⚠️ 2026-10-25：这段**挪进 applyZoomTier**（每一档都会跑到，含程序化取景），
       *    这里不再重复做 —— 见 applyZoomTier 里的说明。 */
      // true = 用户主动缩放，允许「缩到标点重叠就退回总览」
      applyZoomTier(undefined, true);
    }, 120);
  }

  /* ⚠️ 2026-10-21 起本函数在 map-amap.js 里**已无调用方** ——
   *  它当初只为 `new AMap.GeoJSON({geoJSON: toGeoJSON(...)})` 服务，
   *  而高德 2.0 没有 `AMap.GeoJSON`（见 #44），四层已改成 `polygonsOf()` 直接建 Polygon。
   *  保留不删：`map.html`（另一个实验页）里还有一份同名函数在用，删了容易混淆；
   *  真要清理请连同那个页面一起评估。 */
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

  /* ---------- 分区全景取景（聚合圈点击 / 分区徽章点击 共用） ----------
   * 2026-10-21 产品方两条反馈一起落在这里：
   *   ① 「点击绿圈后区域还是有点小，可以设置充电桩边界靠近屏幕边界」
   *      → 四周留白从原来的 北门 0.09 / 朝晖 0.22 收到统一的 AREA_PAD。
   *   ② 「去除放大后点击北门、朝晖体育场的标签会跳转到旧地图的情况」
   *      → 徽章点击改走这里（在**高德底图上放大**），不再回调页面去 switchMap 静态旧图。
   */
  var AREA_PAD = 0.08;
  /* 取景框 = 分区几何包围盒 ∪ 该分区**所有桩点实际位置**。
   *
   * 🔴 2026-10-21 实测：只按 `areaBBox()` 取景会裁到最外侧的桩。
   *   areaBBox 来自分区排布线的两端点，而桩点是沿线自适应排出来的，
   *   端点之外还能落点 —— 朝晖实测桩点横向跨度 392px，比 bbox 折算的 371px 还宽，
   *   于是最外侧的 T01/T36 被容器切掉 1~3px（产品方说「区域还是有点小」，
   *   真修好之后又冒出来的边界问题）。并上桩点后 pad 才真正等于留白。 */
  function areaBBoxWithPiles(id) {
    var b = areaBBox(id);
    if (!b) return null;
    piles.forEach(function (p) {
      if (p.location !== id) return;
      var q = PIN_POS[p.id];
      if (!q) return;
      b = {
        w: Math.min(b.w, q[0]), e: Math.max(b.e, q[0]),
        s: Math.min(b.s, q[1]), n: Math.max(b.n, q[1]),
      };
    });
    return b;
  }
  function zoomToArea(id) {
    if (!id) return;
    var bb = areaBBoxWithPiles(id);
    if (!bb) return;
    curView = id;
    /* 留白换算：单边像素 = cw×p/(2(1+p))。窄屏 cw≈390、p=0.08 → 约 14px，
     * 标点徽章半宽 10px → 留出 4px 余量，「贴边但不裁切」。
     * （DeepSeek 原方案 p=0.05 → 9px，只够盖住半宽，遇上子像素取整就会切掉 1px。）
     * 原值是 北门 0.09 / 朝晖 0.22（朝晖留白尤其大），产品方反映「区域还是有点小」。
     *
     * 🔴 minZ 必须给到**徽章档**（gap≥13），否则会出现「点完还是圈」的死循环 ——
     *   WorkBuddy 2026-10-21 实测：朝晖按 bbox 只能算出 z≈16.17（gap 12.1），
     *   在 GAP_CLUSTER=13 下仍判成聚合圈 → 点了等于没点。 */
    fitBBox(bb, AREA_PAD, 18.0);
    /* ⚠️ 这里**不要**再单独调 syncLayers()：此刻 `clustered` 还是 true，
     * 而聚合圈的显隐条件是 `isCampus && clustered` —— curView 刚改成分区名（已不是 campus），
     * 会瞬间出现「逐台点被藏 + 聚合圈也不显示」的空档。
     * fitBBox 内部会走 applyZoomTier → syncLayers，用新的缩放态一次性算对。 */
    notifyView();
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
        if (!id) return;
        /* 2026-10-21 改：在**当前高德底图上**放大到该分区。
         * 原来这里是 `onPileCb({ type: 'area', id })`，页面收到 area 会
         * `switchMap('beimen'|'chaohui')` → 切到静态手绘旧图 ——
         * 产品方：「去除放大后，点击北门、朝晖体育场的标签会跳转到旧地图的情况」。
         * 现在与聚合圈点击走同一条路（zoomToArea），不再回调页面。 */
        zoomToArea(id);
      });
    });
  }

  /* ---------- 缩小时的「分区聚合圈」 ----------
   * 2026-10-21 产品方要求：地图缩小到「标点重叠过多」后，不再逐台画点，
   * 而是每个分区合成一个圈 —— 绿圈里写「该分区还有多少可用」，没有可用就红圈打 ×。
   * 点这个圈 → 放大到该分区全景（逐台点自然回到可读状态）。
   *
   * 与 rebuildBadges 的区别：badge 是「总览气泡」一直挂在分区外缘（带分区名），
   * 这个是缩小时**替代逐台点**的主体标记，只写数字不写名字，视觉更大更干净。
   *
   * ⚠️ 2026-10-25 补：**圈下面加分区名**。总览成了默认第一屏以后，四个圈只写数字
   * 谁也分不清是哪儿（产品方要的是「显示四个分区」）。名字用绝对定位挂在圈外，
   * 不改变 marker 的盒子尺寸 ⇒ 圈心仍然钉在分区几何中心。
   * 🔴 北门与朝晖的圈心只差 **37px**（188m，圈径 30px），名字都往下挂会叠在一起，
   *    所以北门的名字往上放（北边是空的），这是唯一需要单独配的一个分区。
   */
  var CL_LABEL_UP = { '渭水-北门': true };
  function rebuildClusters() {
    clearLayer(clusterLayer); clusterLayer = null;
    CLUSTER_POS = {};

    var groups = {};
    piles.forEach(function (p) {
      var a = D.areas[p.location];
      if (!a) return;
      if (!groups[p.location]) groups[p.location] = { free: 0, n: 0, name: a.name };
      groups[p.location].n++;
      if (p.free > 0) groups[p.location].free += p.free;
    });

    var markers = [];
    Object.keys(groups).forEach(function (loc) {
      var g = groups[loc];
      var b = areaBBox(loc);
      if (!b) return;
      var mid = [(b.w + b.e) / 2, (b.s + b.n) / 2];
      CLUSTER_POS[loc] = mid;
      var ok = g.free > 0;
      var inner = ok
        ? '<span class="cluster-num">' + g.free + '</span>'
        : '<span class="cluster-x">×</span>';
      /* 名字用绝对定位挂在圈外（见上面 CL_LABEL_UP 的说明）——
         这样 marker 盒子仍是 30×30 的圈，圈心不会被名字顶偏。 */
      var nm = g.name || loc.replace(/^渭水-/, '');
      markers.push(new AMap.Marker({
        position: mid, anchor: 'center',
        content: '<div class="cluster-cell' + (CL_LABEL_UP[loc] ? ' lbl-up' : '') + '">'
          + '<div class="cluster ' + (ok ? 'ok' : 'full') + '">' + inner + '</div>'
          + '<span class="cluster-name">' + nm + '</span></div>',
        extData: { area: loc },
        zIndex: 90,
      }));
    });

    if (!markers.length) return;
    clusterLayer = markers;
    markers.forEach(function (m) {
      m.setMap(map);
      m.on('click', function () {
        // 点聚合圈 → 放大到该分区全景（与分区徽章点击共用 zoomToArea，留白/托底一致）；
        // 放大后 applyZoomTier 会把聚合圈换成逐台点。
        // ⚠️ minZ 必须给到徽章档 —— 见 zoomToArea 里那条「点完还是圈」的说明。
        zoomToArea(m.getExtData().area);
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
    /* 🔴 clusterOn 而不是裸 clustered —— 这是「白屏」bug 的结构性兜底（见 applyZoomTier 注释②）。
     * 逐台点的隐藏与聚合圈的显示**必须用同一个开关**，否则会出现
     * 「clustered=true 但 curView 不是 campus」→ 点被隐藏、圈又不显示 → 整张图空掉。 */
    var clusterOn = clustered && isCampus;
    // 总览徽章：总览 + 放大态才显示（聚合成圈时信息与聚合圈重复，藏掉）
    if (badgeLayer) badgeLayer.forEach(function (m) { m.setMap(isCampus && !clusterOn ? map : null); });
    // 聚合圈：只在「总览 + 聚合成圈」时显示；进到某分区（已放大）就隐藏
    if (clusterLayer) clusterLayer.forEach(function (m) { m.setMap(clusterOn ? map : null); });
    // 桩点：总览显示（或分区内也显示），这里简化为总览 + 分区都显示桩点
    // 聚合成圈时逐台点整体隐藏（applyZoomTier 也会兜一层，这里先按分区+缩放态裁决）
    if (pinLayer) {
      pinLayer.forEach(function (m) {
        var d = m.getExtData();
        var showPin = true;
        if (!isCampus && d.id) {
          var p = null;
          piles.forEach(function (q) { if (q.id === d.id) p = q; });
          showPin = p && p.location === curView;
        } else if (!isCampus && d.area) {
          showPin = d.area === curView;
        } else {
          showPin = true;
        }
        // 聚合成圈时逐台点一律隐藏 —— 用 clusterOn（= clustered && isCampus），
        // 不能只看 clustered：否则分区视图里缩小时点被藏、圈又不显示 → 白屏
        if (clusterOn) showPin = false;
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
  function fitBBox(b, pad, minZ, animate) {
    progZoomAt = Date.now();      // 标记「这是程序化取景」，onZoomTier 在 1200ms 内不重算档位
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
    var center = [(b.w + b.e) / 2, lat];
    /* 第三参 immediately=true：无动画直接跳。
     * 🔴 2026-10-21 实测（WorkBuddy）：同一次调用里既改 center 又改 zoom 时，
     *   高德会把 zoom **压在动画中间值**上 —— 点圈后地图停在 z=17.23（目标 18.05），
     *   于是朝晖 36 台只占屏幕中间 224px（左右各留白 83px），产品方说的
     *   「点绿圈后区域还是有点小」其实是这条没到位，不是 AREA_PAD 的问题。
     *   对照实验：同一起点手动 setZoom(18.05) → 立刻到 18.05、36 台占 382px。
     *   加 immediately 之后 zoom 精确落到 z，取景才真的贴着标点边界。
     *
     * 2026-10-24：新增 `animate` —— **只给「打开地图后的第一帧」用**，走高德补间，
     *   从 mount 的默认相机飞过去。终点仍要补一次精确落位（见下）。 */
    if (animate) {
      map.setZoomAndCenter(z, center, false, FLY_MS);
      /* 🔴 动画模式下高德会把 zoom 停在中间值（同上面那条实测）。所以动画结束后
       *    **无条件**再精确落一次：目标本就到位时这是一次等值设置，没有视觉变化；
       *    落偏了就当场补正（幅度很小，用户只看到「停稳」）。
       *    ⚠️ 不要读 `map.getZoom()` 来判断要不要补 —— 它在 setZoomAndCenter 之后
       *    长期滞后（实测 2.7s 仍报旧值），读出来会误判成「偏很多」而立刻跳一下，
       *    等于把刚做的动画取消掉。 */
      setTimeout(function () {
        if (!map) return;
        progZoomAt = Date.now();
        map.setZoomAndCenter(z, center, true);
        applyZoomTier(z);
      }, FLY_MS + 90);
    } else {
      map.setZoomAndCenter(z, center, true);
    }
    // 先按目标档位刷一次，再靠 zoomend / 定时器兜住高德回填 zoom 的延迟
    applyZoomTier(z);
    setTimeout(function () { applyZoomTier(z); }, 60);
    setTimeout(function () { applyZoomTier(z); }, 400);
  }

  /** 四个分区的总览外接框 = 各分区桩阵外接框的并集 ∪ 分区徽章位置。
   *  ⚠️ 用 `areaBBoxWithPiles` 而不是 `areaBBox`：桩点是沿线自适应排出来的，
   *     会溢出排布线两端（2026-10-21 朝晖实测差 21px），只按排布线取景会裁掉最外侧的桩。
   *  ⚠️ 徽章/标签挂在桩阵外缘，取景时也要算进去，否则名字会被顶到画面外。 */
  function campusBBox() {
    var b = unionBBox(Object.keys(D.areas).map(function (k) {
      return areaBBoxWithPiles(k) || areaBBox(k);
    }));
    Object.keys(BADGE_POS).forEach(function (k) {
      var p = BADGE_POS[k];
      if (!p) return;
      b = {
        w: Math.min(b.w, p[0]), e: Math.max(b.e, p[0]),
        s: Math.min(b.s, p[1]), n: Math.max(b.n, p[1]),
      };
    });
    return b;
  }

  /**
   * 「渭水校区」页签的默认取景 = **四个分区一起进画面**（2026-10-25 产品方改回并加强）。
   *
   * 历史（两版都跑过，别再来回翻烧饼）：
   *   · v1.x 全域并集：视野被拉到全校级（z≈17.1）→ 桩号 `gap<13` 全变圆点，编号看不见 ✗
   *   · 2026-10-21 改「只框朝晖」（z≈18.1，编号可读）→ 代价是北门/物业/20号楼
   *     **全落在画面外**，可当时默认页签不是它，问题不明显。
   *   · 2026-10-25 v2.23 把它设成默认打开的第一屏后，产品方一眼看出「只能看到朝晖 36 台」，
   *     要求：「点击地图显示四个分区，点击后放大」→ 就是现在这一版。
   *
   * 现在的语义不是「把 109 个编号塞进一屏」（物理上不可能），而是**分区级总览**：
   *   一屏 z≈14.6（约 5.1 m/px）→ `gap≈1.3px` 远低于 `GAP_CLUSTER` → 自动进聚合圈档，
   *   屏幕上就是**四个带名字的圈**（20号楼 / 物业服务中心 / 北门 / 朝晖体育场南），
   *   点哪个圈就 `zoomToArea()` 放大到哪个分区 —— 那一档才是逐台编号（z≥18，编号必显）。
   *
   * minZ 传 0（fitBBox 内部 floor 到 14）：四个分区横跨 **1.8km**（108.8928~108.9125），
   *   任何比这更近的托底都会把最西的 20 号楼或最东的北门裁掉 —— 这里**不能有托底**。
   */
  function fitCampus(animate) {
    fitBBox(campusBBox(), 0.10, 0, animate);
  }

  /* ---------- 视图状态回传（给页面表头 / 「返回总览」按钮用） ----------
   * 为什么要它：总览成了默认第一屏以后，「点圈放大」是**引擎内部**行为（zoomToArea），
   * 页面并不知道镜头已经落到某个分区 —— 表头会一直写着「109 个点位」，
   * 与屏幕上只显示的 36 台自相矛盾；而且放大以后页面没有任何「回总览」的入口。
   * 所以状态一变就回传：curView + **当前视图**的点位数 / 有空位位数。 */
  function viewInfo() {
    var total = 0, free = 0;
    piles.forEach(function (p) {
      if (curView !== 'campus' && p.location !== curView) return;
      total++;
      if (p.free > 0) free++;
    });
    var a = (D && D.areas) ? D.areas[curView] : null;
    return {
      view: curView,
      name: a ? a.name : '渭水校区',
      school: curView === 'campus',
      piles: total,
      free: free,
    };
  }
  function notifyView() {
    if (!onViewCb) return;
    try { onViewCb(viewInfo()); } catch (e) {}
  }

  function applyCamera() {
    /* 只有「打开地图后的第一帧」做飞入动画（见 firstCamera 的说明）。
     * 注意这个判断必须在最前面取一次就置 false：同一次 applyCamera 里
     * fitCampus / fitBBox 可能被调用多次，不能都当成首帧。 */
    var fly = firstCamera;
    firstCamera = false;
    if (curView === 'campus') {
      fitCampus(fly);
    } else {
      var b = areaBBox(curView);
      // 北门桩阵只占一块 137m×58m 的地块，留白 9%（窄屏单边约 15px，扣掉徽章半宽 8px 还剩 7px，
      // 最东头的 D14 不会被容器切掉），缩放托底 18.05 级 —— 低于这个级别桩距不够 13px，桩号就降级成圆点
      if (b) fitBBox(b, curView === '渭水-北门' ? 0.09 : 0.22, curView === '渭水-北门' ? 18.05 : 0, fly);
      else fitCampus(fly);
    }
    try { map.resize(); } catch (e) {}
    // 档位已经在 fitBBox 里按目标 zoom 设过了，这里再读 map.getZoom() 反而会拿旧值覆盖
    notifyView();
  }

  /* ---------- 对外 ---------- */
  var api = {
    ready: function () { return ready; },
    failed: function () { return failed; },

    mount: function (hostEl, opts) {
      opts = opts || {};
      mountCount++;
      host = hostEl;
      /* 每次（重新）挂载都重置首帧标志 —— 「关掉地图再打开」应该再飞一次。
       * 不重置的话第二次打开会直接瞬移到位，与产品方要的过渡效果不一致。 */
      firstCamera = true;
      onFailCb = opts.onFail || null;
      onPileCb = opts.onPileClick || null;
      onViewCb = opts.onViewChange || null;
      if (typeof CHD_MAP === 'undefined') { failed = true; onFailCb && onFailCb('data'); return; }
      D = CHD_MAP;

      function init() {
        try {
          map = new AMap.Map(host, {
            viewMode: '2D',
            zoom: 15.2,
            center: LL(D.campusCenter),
            // 2026-10-21 产品方要「主干路名称」—— 我们**没有道路数据**（`D.roads` 不存在），
            //   所以路名只能靠高德自己的注记：把 showLabel 从 false 打开。
            //   features 里**不含 'point'**，所以 POI（店铺/公司）注记不会被带出来，
            //   带出来的是背景/道路/建筑的注记 —— 正好是「路名 + 楼名」。
            //   ⚠️ 楼名可能与我们自己画的 campus-label 重复；若看着重影，
            //      把 features 收成 ['bg', 'road'] 即只留路名（一个词的改动）。
            features: ['bg', 'road', 'building'],
            limitBounds: new AMap.Bounds(
              [D.bounds.west, D.bounds.south],
              [D.bounds.east, D.bounds.north]
            ),
            showLabel: true,
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
          // 🔴 缩放监听在这里绑，**绝不能放回 buildLayers() 内部** ——
          //    那里第一个 AMap.GeoJSON 就会抛错，绑在函数末尾等于永不绑定（v1.67~v2.00 的 P0）。
          map.on('zoomend', onZoomTier);
          map.on('zoomchange', onZoomTier);
          ready = true;
          try { map.resize(); } catch (e) {}
          try { applyCamera(); } catch (e) { console.warn('[CHD_AMAP] 相机失败', e); }
          applyZoomTier();          // 相机定了立刻定档，别等用户缩放
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
      rebuildClusters();
      syncLayers();
      // opts2.keepCamera：刷新数据时别把用户正在看的视角拉回全景
      if (!(opts2 && opts2.keepCamera)) applyCamera();
      notifyView();          // 数量变了（keepCamera 那条路不会走 applyCamera）
    },

    setView: function (view, opts2) {
      if (!ready) return;
      curView = view;
      syncLayers();
      /* keepCamera：只切「视图状态」，不动相机。
       * 给「首帧飞入」和「卡片定位」用 —— 页面在 onReady 里紧跟的那次
       * setPiles/setView 如果照默认走 applyCamera，会把刚起的飞入动画一把拽到终点，
       * 用户看到的就还是「瞬移到位」。 */
      if (!(opts2 && opts2.keepCamera)) applyCamera();
      notifyView();
    },

    // 程序化设定缩放（保持当前中心）；供测试与未来「缩到全校」入口复用。
    // z 会经 applyZoomTier 决定显示聚合圈还是逐台点。
    setZoom: function (z) {
      if (!ready || !map) return false;
      progZoomAt = Date.now();    // 同 fitBBox：程序化缩放，别让 onZoomTier 用滞后 zoom 覆盖
      map.setZoom(z);
      applyZoomTier(z);
      setTimeout(function () { applyZoomTier(z); }, 400);
      return true;
    },

    focusPile: function (id) {
      if (!ready) return false;
      var target = null;
      piles.forEach(function (q) { if (q.id === id) target = q; });
      if (!target || !PIN_POS[id]) return false;
      if (curView !== target.location) { curView = target.location; syncLayers(); }
      /* 🔴 2026-10-21 补（WorkBuddy 08:5x 提出、留给我的那一项）：**必须盖 progZoomAt 戳**。
       *
       * 为什么：高德 `getZoom()` 在 `setZoomAndCenter` 之后**长期滞后**（实测 2.7 秒仍报旧值）。
       *   `zoomend → onZoomTier` 只在 `progZoomAt` 的 1200ms 窗口内被挡住。
       *   原来这里没盖戳 → onZoomTier 会拿**滞后的旧 zoom** 去算 gap → 可能判成聚合档；
       *   而此刻 `curView` 已是分区名（不是 campus），会触发 applyZoomTier 里的
       *   「进聚合态就退回总览」→ **用户刚点「查找」就被从桩特写里弹回总览**。
       *   交付时全靠 `gap 13.19` 与阈值 `13` 之间 **0.19 的余量**兜着 —— 太险。
       *
       * 两件事一起做，彻底不依赖那个余量：
       *   ① 盖戳（与 fitBBox / setZoom 同一处理）
       *   ② 直接用**目标 zoom** 定档，不等滞后的 getZoom()
       */
      progZoomAt = Date.now();
      /* 2026-10-24：显式给「动画 + 时长」，让「查找」是**飞过去**而不是瞬移。
       * 终点照样补一次精确落位 —— 高德在同时改 center + zoom 的动画里会把 zoom
       * 停在中间值（见 fitBBox 那段实测），读 getZoom 又不可靠，所以直接等值重设。 */
      map.setZoomAndCenter(19.2, PIN_POS[id], false, FLY_MS);
      applyZoomTier(19.2);                                   // 用目标值定档（19.2 → gap≈30.8，必进徽章档）
      setTimeout(function () {                               // 动画收尾后再钉一次
        if (!map) return;
        progZoomAt = Date.now();
        map.setZoomAndCenter(19.2, PIN_POS[id], true);
        applyZoomTier(19.2);
      }, FLY_MS + 90);
      notifyView();          // 「查找」也是切了视图（curView 已变成该桩所属分区）
      return true;
    },

    resize: function () { if (map && map.resize) try { map.resize(); } catch (e) {} },

    /* 当前视图状态（页面表头 / 返回按钮用；也是验收「点圈放大后到底进了哪个分区」的判据） */
    viewInfo: viewInfo,

    debug: function () {
      var ks = Object.keys(PIN_POS);
      return {
        view: curView, piles: piles.length, ready: ready, failed: failed,
        failReason: failReason, mountCount: mountCount,
        badges: badgeLayer ? badgeLayer.length : 0,
        pins: pinLayer ? pinLayer.length : 0,
        clusters: clusterLayer ? clusterLayer.length : 0,
        clustered: clustered,
        gap: (host && host.dataset.gap) || '',
        zoom: map ? map.getZoom() : null,
        /* 相机中心：给「飞入动画」验收用（动画中每 100ms 采一次，中心应连续变化）。
         * `getZoom()` 在 setZoomAndCenter 后会滞后，`getCenter()` 不会 —— 所以判据用 center。 */
        center: (map && map.getCenter) ? (function () {
          try { var c = map.getCenter(); return [c.getLng(), c.getLat()]; } catch (e) { return null; }
        })() : null,
        sample: ks.slice(0, 3).map(function (k) { return k + ':' + PIN_POS[k].join(','); }),
        sampleLast: ks.length ? PIN_POS[ks[ks.length - 1]].join(',') : '',
        /* 2026-10-21 加（只为验收 #44 用）：建筑 / 场地 / 水域 / 楼名标签的真实数量，
         * 以及底图风格与边界遮罩是否真的生效。
         * 这几项以前查不到 —— `AMap.GeoJSON` 抛错被 try/catch 吞掉时，
         * 从外面看 `ready` 仍是 true，肉眼只能凭「有没有建筑轮廓」猜，没法判定。 */
        bld: bldLayer ? bldLayer.length : 0,
        venue: venueLayer ? venueLayer.length : 0,
        water: waterLayer ? waterLayer.length : 0,
        labels: labelLayer ? labelLayer.length : 0,
        mapStyle: (map && map.getMapStyle) ? (function () {
          try {
            var st = map.getMapStyle();
            return st ? String(st.styleId || st.style || st).slice(0, 40) : 'null';
          } catch (e) { return 'err'; }
        })() : 'no-api',
        mask: (map && map.getMask) ? (function () {
          try {
            var m = map.getMask();
            return m ? (m.length || 1) : 0;
          } catch (e) { return 'err'; }
        })() : 'no-api',
      };
    },

    destroy: function () {
      clearLayer(badgeLayer); clearLayer(pinLayer); clearLayer(clusterLayer);
      try { if (map) map.destroy(); } catch (e) {}
      badgeLayer = null; pinLayer = null; clusterLayer = null;
      PIN_POS = {}; CLUSTER_POS = {}; clustered = false; dotted = false;
      // 缩放态类名/变量挂在 host 上，销毁时一并清掉，免得下次 mount 残留旧档位
      if (host) {
        host.classList.remove('zoom-cluster', 'zoom-dot');
        host.style.removeProperty('--pile-gap');
      }
      map = null; ready = false;
      if (host) host.innerHTML = '';
    },
  };

  window.CHD_AMAP = api;
})();

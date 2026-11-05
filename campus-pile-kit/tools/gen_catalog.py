#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""从站点真源生成对外设备目录（chd-charge/catalog.json）。

    生成：python tools/gen_catalog.py                        （本地调试，写到站点目录）
    指定输出：python tools/gen_catalog.py --out dist/catalog.json
    自检：python tools/gen_catalog.py --check                （不写盘，只验生成物自洽）

🔴 **catalog.json 是构建产物，不进版本库。**
`make_cloudflare.py` / `make_dist.py` 打包时调用本模块生成，
`serve_gzip.py` 启动时在内存里生成一份 —— 三条产出路径都不需要人工介入，
改了 `DEFAULT_DEVICES` 之后下一次打包（或下一次启动）就是新的。

（`partitions.mjs` 不同：它是 wrangler 部署的输入，必须留在仓库里。）

## 为什么要这个文件

站点是给人看的：设备清单内联在 `index.html` 的 `DEFAULT_DEVICES` 里，坐标是
`map-amap.js` 在浏览器里现算的。别的应用想接进来，只能去抠 500KB 的 HTML、
再把三套落点算法（北门仿射、朝晖椭圆弧、线段等分）重写一遍 —— 重写完还得
跟着站点改版一起维护，而站点一改版它们就静默错位。

`catalog.json` 把这些「本来就已经是公开数据」的东西摊平成一份 JSON：
设备清单 + 分区 + 每台桩的 GCJ-02 坐标。静态文件，不走 Worker，不耗 Functions
额度，第三方拉一次就够。

## 真源与一致性

| 内容 | 真源 |
|---|---|
| 设备清单 | `chd-charge/index.html` 的 `DEFAULT_DEVICES` |
| 分区名与锚点 | `chd-charge/map-data.js` 的 `CHD_MAP.areas` |
| 落点参数 | `chd-charge/map-amap.js` 的 `BM_GEO` / `CH_GEO` / `E_GEO` / `W_GEO` / `Z_GEO` |
| 口数、清单版本、改名表 | `chd-charge/index.html` 的 `PORTS_PER_DEVICE` / `DEVICE_SCHEMA` / `LOCATION_RENAMES` |

⚠️ **三套落点公式是抄过来的**：`bm_geo` / `arc_px` / `ch_geo` 必须与
`map-amap.js` 里的 `bmGeo` / `arcPx` / `chGeo` 逐行等价。参数（中心、半径、
角度区间、像素行、线段经纬度）全部从 `map-amap.js` 现抽，所以**改数值不用动这里**；
只有**改公式本身**才需要同步改本文件，然后重新生成。

⚠️ 坐标是 **GCJ-02**（高德/腾讯坐标系），与站点地图一致。用 WGS84 底图的应用
（自建离线地图、Mapbox、OSM）必须自己做一次逆变换，不要直接叠加。
`precision` 字段说明每个点的可信度，语义见下。

## precision 分级

* `derived` —— 由实测基准经明确标定或几何换算：北门（地块中心 + 0.207 m/px + 16.7°）、
  朝晖（体育场外接框配准）。
* `schematic` —— 沿产品方画的红线两端等分推算，只保证点在线上的相对次序：
  20号楼（自西向东）、物业服务中心（自下而上）、住宅（沿尚苑路等距）。

站点**没有任何逐桩实测坐标**，所以没有 `measured`。

## 确定性

输出不含时间戳、固定键序、坐标 6 位小数，同一份输入必然产出同一份字节，
`--check` 才有意义。
"""
import io
import json
import math
import os
import re
import sys

TOOLS = os.path.dirname(os.path.abspath(__file__))
sys.path.insert(0, TOOLS)

from gen_snapshot_partitions import AREA_ORDER, parse_device_records  # noqa: E402

ROOT = os.path.dirname(TOOLS)
SITE = os.path.join(ROOT, 'chd-charge')
INDEX = os.path.join(SITE, 'index.html')
MAP_DATA = os.path.join(SITE, 'map-data.js')
MAP_AMAP = os.path.join(SITE, 'map-amap.js')
OUT = os.path.join(SITE, 'catalog.json')

SCHEMA = 1

# 北门/朝晖是标定换算出来的，线段型分区是等分推算出来的。
LINE_PRECISION = 'schematic'
DERIVED_PRECISION = 'derived'


def die(msg):
    sys.exit('[X] ' + msg)


def read(path):
    try:
        return io.open(path, encoding='utf-8', newline='').read()
    except OSError as e:
        die('读不到 %s：%s' % (os.path.relpath(path, ROOT), e))


# ────────────────────────────── 真源抽取 ──────────────────────────────

def parse_scalars(html):
    """index.html 里那几个单值常量。"""
    def num(name, pattern, cast=int):
        m = re.search(pattern, html)
        if not m:
            die('index.html 里找不到 %s（结构变了？）' % name)
        return cast(m.group(1))

    ports = num('PORTS_PER_DEVICE', r'const PORTS_PER_DEVICE = (\d+)')
    device_schema = num('DEVICE_SCHEMA', r'const DEVICE_SCHEMA = (\d+)')

    ver = re.search(r'id="app-ver"[^>]*>([^<]*)<', html)
    site_version = ''
    if ver:
        vm = re.search(r'v\d+(?:\.\d+)*', ver.group(1))
        site_version = vm.group(0) if vm else ''

    renames = []
    rm = re.search(r'const LOCATION_RENAMES = \[(.*?)\];', html, re.S)
    if rm:
        renames = [list(p) for p in re.findall(r"\['([^']+)',\s*'([^']+)'\]", rm.group(1))]

    return ports, device_schema, site_version, renames


def parse_areas():
    """map-data.js 的 CHD_MAP.areas：location → {name, line}。"""
    text = read(MAP_DATA)
    m = re.search(r'window\.CHD_MAP\s*=\s*(\{.*\})\s*;?\s*$', text, re.S)
    if not m:
        die('map-data.js 里找不到 window.CHD_MAP')
    data = json.loads(m.group(1))
    areas = data.get('areas') or {}
    if not areas:
        die('CHD_MAP.areas 为空')
    return areas


def _brace_block(text, start, open_ch='{', close_ch='}'):
    """从 start（指向 open_ch）起做括号配对，返回内部文本。"""
    depth = 0
    for i in range(start, len(text)):
        ch = text[i]
        if ch == open_ch:
            depth += 1
        elif ch == close_ch:
            depth -= 1
            if depth == 0:
                return text[start + 1:i]
    die('括号没有闭合（从 %d 起）' % start)


def _numbers(block):
    """把 `key: number` 全抽成 dict；嵌套对象的键名互不冲突，直接摊平。"""
    return {
        k: float(v)
        for k, v in re.findall(r'([A-Za-z_$][\w$]*)\s*:\s*(-?\d+(?:\.\d+)?)', block)
    }


def parse_geometry():
    """map-amap.js 里的落点参数。"""
    text = read(MAP_AMAP)

    def obj(name):
        m = re.search(r'var %s = \{' % name, text)
        if not m:
            die('map-amap.js 里找不到 %s' % name)
        return _numbers(_brace_block(text, m.end() - 1))

    bm = obj('BM_GEO')
    ch = obj('CH_GEO')

    # BM_PX 由 4 行描述符生成：row(prefix, x0, x1, n, y, asc)
    rows = re.findall(
        r"row\('([A-D])',\s*(-?[\d.]+),\s*(-?[\d.]+),\s*(\d+),\s*(-?[\d.]+),\s*(true|false)\)",
        text,
    )
    if len(rows) != 4:
        die('BM_PX 的 4 行描述符没有全部找到（实际 %d 行）' % len(rows))
    bm_px = {}
    for prefix, x0, x1, n, y, asc in rows:
        x0, x1, n, y = float(x0), float(x1), int(n), float(y)
        ascending = asc == 'true'
        for i in range(n):
            code = prefix + ('%02d' % (i + 1 if ascending else n - i))
            bm_px[code] = (x0 + (i + 0.5) * (x1 - x0) / n, y)

    def geo_table(name):
        m = re.search(r'var %s = \[' % name, text)
        if not m:
            die('map-amap.js 里找不到 %s' % name)
        body = _brace_block(text, m.end() - 1, '[', ']')
        pairs = re.findall(r'\[(-?[\d.]+),\s*(-?[\d.]+)\]', body)
        if not pairs:
            die('%s 是空的' % name)
        return [(float(lng), float(lat)) for lng, lat in pairs]

    # LINE_AREAS：location → (prefix, rows, geo 表名)。rows 只有「二维分区」才有
    # （目前只有北院），表示每排的点数；一维分区是 None。
    line_areas = {}
    lm = re.search(r'var LINE_AREAS = \[', text)
    if not lm:
        die('map-amap.js 里找不到 LINE_AREAS')
    for chunk in _brace_block(text, lm.end() - 1, '[', ']').split('{')[1:]:
        loc_m = re.search(r"loc:\s*'([^']+)'", chunk)
        pre_m = re.search(r"prefix:\s*'([A-Z])'", chunk)
        row_m = re.search(r'rows:\s*\[([\d,\s]+)\]', chunk)
        geo_m = re.search(r'geo:\s*([A-Za-z0-9_]+)', chunk)
        if loc_m and pre_m and geo_m:
            line_areas.setdefault(loc_m.group(1), (
                pre_m.group(1),
                [int(x) for x in re.findall(r'\d+', row_m.group(1))] if row_m else None,
                geo_m.group(1),
            ))

    # 🔴 按 **geo 变量名** 建落点表，别按 prefix 字母：v2.99 的
    #    「雁塔-5号学生公寓南部」前缀也是 'W'（与渭水物业 W-01~12 撞名），
    #    按 prefix 取表会静默拿到物业那串坐标 —— 12 台全跑到渭水去，
    #    而 `--check` 只看数量、看不出坐标错。新增分区不用在这里登记，
    #    只要在 LINE_AREAS 那行写了 geo 就会自动进来。
    tables = {g: geo_table(g) for g in sorted({v[2] for v in line_areas.values()})}

    # `rot: 16.7 * Math.PI / 180` —— _numbers 只能抽到 16.7，这里换算成弧度
    bm['rot'] = bm['rot'] * math.pi / 180.0
    return bm, bm_px, ch, tables, line_areas


# ────────────────────────────── 落点换算（镜像 map-amap.js） ──────────────────────────────

def r6(v):
    return round(v, 6)


def bm_geo(px, py, g):
    east = (px - g['cx']) * g['s']
    north = -(py - g['cy']) * g['s']
    c, s = math.cos(g['rot']), math.sin(g['rot'])
    e = east * c - north * s
    n = east * s + north * c
    lat = g['lat'] + n / 110540.0
    lng = g['lng'] + e / (111320.0 * math.cos(lat * math.pi / 180.0))
    return r6(lng), r6(lat)


def arc_px(seq, g):
    i = seq - 1
    if i < g['leftCount']:
        n = max(1.0, g['leftCount'] - 1)
        th = g['leftStart'] - (g['leftStart'] - g['leftEnd']) * (i / n)
    else:
        j = i - g['leftCount']
        n2 = max(1.0, g['total'] - g['leftCount'] - 1)
        th = g['rightStart'] - (g['rightStart'] - g['rightEnd']) * (j / n2)
    rad = math.radians(th)
    return g['cx'] + g['rx'] * math.cos(rad), g['cy'] + g['ry'] * math.sin(rad)


def ch_geo(px, py, g):
    kx = (g['e'] - g['w']) / (g['x1'] - g['x0'])
    ky = (g['n'] - g['s']) / (g['y1'] - g['y0'])
    return r6(g['w'] + (px - g['x0']) * kx), r6(g['n'] - (py - g['y0']) * ky)


def bm_key(code):
    m = re.search(r'([A-D])-?(\d{1,2})(?!\d)', str(code or '').upper().replace(' ', ''))
    return '%s%02d' % (m.group(1), int(m.group(2))) if m else ''


def line_seq(code, prefix):
    s = str(code or '').upper().replace(' ', '')
    m = re.search(prefix + r'[-\u2010\u2011\u2012\u2013\u2014\u2015\u2212]?(\d{1,2})(?!\d)', s)
    return int(m.group(1)) if m else 0


def by_seq(code, rows):
    """二维分区（北院）的桩号 → 一维下标（1 起算）：'B3-05' → 21、'B7-09' → 57。

    镜像 `map-amap.js` 的 `bySeq()`。行优先：前面各排点数之和 + 本排列号。
    认不出（排/列越界）返回 0，交给 build() 里的「补空位」分支。
    """
    s = str(code or '').upper().replace(' ', '')
    m = re.match(r'B[-\u2010\u2011\u2012\u2013\u2014\u2015\u2212]?(\d)'
                 r'[-\u2010\u2011\u2012\u2013\u2014\u2015\u2212]?(\d{1,2})$', s)
    if not m:
        return 0
    r, c = int(m.group(1)), int(m.group(2))
    if r < 1 or r > len(rows) or c < 1 or c > rows[r - 1]:
        return 0
    return sum(rows[:r - 1]) + c


def arc_seq(code, total):
    m = re.search(r'(\d+)(?!.*\d)', str(code or ''))
    if not m:
        return 0
    n = int(m.group(1))
    return n if 1 <= n <= total else 0


# ────────────────────────────── 组装 ──────────────────────────────

def build():
    ports_per_device, device_schema, site_version, renames = parse_scalars(read(INDEX))
    devices = parse_device_records()
    area_meta = parse_areas()
    bm, bm_px, ch, tables, line_areas = parse_geometry()

    order = {loc: (key, name) for loc, key, name in AREA_ORDER}
    known_locations = []
    for d in devices:
        if d['location'] not in known_locations:
            known_locations.append(d['location'])
    for loc in known_locations:
        if loc not in order:
            die('设备分区「%s」没有登记在 gen_snapshot_partitions.AREA_ORDER 里' % loc)

    # 每台桩的落点。分派顺序必须与 map-amap.js 的 layoutPiles 一致：
    # 线段型 → 北门 → 其余走朝晖弧。顺序反了，E-01/W-03 的末尾数字会被当成弧序号。
    used = {}
    coords = {}
    for d in devices:
        loc, code = d['location'], d['code']
        bucket = used.setdefault(loc, set())
        lng = lat = None
        if loc in line_areas:
            prefix, rows, geo = line_areas[loc]
            table = tables[geo]
            seq = by_seq(code, rows) if rows else line_seq(code, prefix)
            if 1 <= seq <= len(table) and seq not in bucket:
                lng, lat = table[seq - 1]
                bucket.add(seq)
            else:
                for i in range(1, len(table) + 1):
                    if i not in bucket:
                        lng, lat = table[i - 1]
                        bucket.add(i)
                        break
            precision = LINE_PRECISION
        elif loc == '渭水-北门':
            px = bm_px.get(bm_key(code))
            if px is not None and code not in bucket:
                lng, lat = bm_geo(px[0], px[1], bm)
                bucket.add(code)
            else:
                for key, p in bm_px.items():
                    if key not in bucket:
                        lng, lat = bm_geo(p[0], p[1], bm)
                        bucket.add(key)
                        break
            precision = DERIVED_PRECISION
        else:
            seq = arc_seq(code, ch['total'])
            if 1 <= seq <= ch['total'] and seq not in bucket:
                bucket.add(seq)
            else:
                seq = next((i for i in range(1, int(ch['total']) + 1) if i not in bucket), 0)
                if seq:
                    bucket.add(seq)
            if not seq:
                die('分区「%s」的落点槽位用完了（%s）' % (loc, code))
            lng, lat = ch_geo(*arc_px(seq, ch), ch)
            precision = DERIVED_PRECISION
        if lng is None or lat is None:
            die('设备 %s（%s）没有算出坐标' % (d['id'], code))
        coords[d['id']] = (lng, lat, precision)

    areas = []
    for loc, key, name in AREA_ORDER:
        meta = area_meta.get(loc) or {}
        line = meta.get('line') or []
        anchor = None
        if len(line) == 2:
            anchor = [
                r6((line[0][0] + line[1][0]) / 2.0),
                r6((line[0][1] + line[1][1]) / 2.0),
            ]
        rows = [d for d in devices if d['location'] == loc]
        if not rows:
            die('分区「%s」一台设备都没有' % loc)
        srcs = {d['src'] for d in rows}
        if len(srcs) > 1:
            die('分区「%s」里混了两个数据源 %s' % (loc, sorted(srcs)))
        src = srcs.pop()
        layout = 'line' if loc in line_areas else ('grid' if loc == '渭水-北门' else 'arc')
        entry = {
            'key': key,
            'name': name,
            'location': loc,
            'count': len(rows),
            'layout': layout,
            'src': src,
            'anchor': anchor,
        }
        if loc in line_areas:
            entry['precision'] = LINE_PRECISION
        else:
            entry['precision'] = DERIVED_PRECISION
        areas.append(entry)

    aliases = [loc for loc in line_areas if loc not in order]
    for loc in area_meta:
        if loc not in order and loc not in aliases:
            aliases.append(loc)

    out_devices = []
    for d in devices:
        lng, lat, precision = coords[d['id']]
        out_devices.append({
            'id': d['id'],
            'code': d['code'],
            'name': d['name'],
            'area': order[d['location']][0],
            'location': d['location'],
            'src': d['src'],
            'ports': d['portCount'] or ports_per_device,
            'lng': lng,
            'lat': lat,
            'precision': precision,
        })

    return {
        'schema': SCHEMA,
        'generator': 'tools/gen_catalog.py',
        'source': {
            'devices': 'chd-charge/index.html#DEFAULT_DEVICES',
            'areas': 'chd-charge/map-data.js#CHD_MAP.areas',
            'geometry': 'chd-charge/map-amap.js#BM_GEO/CH_GEO/E_GEO/W_GEO/Z_GEO/BY_GEO/Y_GEO/T_GEO/W5_GEO/P_GEO',
        },
        'siteVersion': site_version,
        'deviceSchema': device_schema,
        'coordSystem': 'GCJ-02',
        'portsPerDevice': ports_per_device,
        'total': len(out_devices),
        'locationRenames': renames,
        'locationAliases': aliases,
        'areas': areas,
        'devices': out_devices,
    }


def render(data):
    return json.dumps(data, ensure_ascii=False, indent=2) + "\n"


def validate(data):
    """生成物自检：数量对得上、id 不重复、每台都有坐标。

    目录是构建产物（不进版本库），没有可参照的历史版本；
    能验证的是这份生成物自身是否自洽：数量、唯一性、坐标齐全。
    """
    problems = []
    if data.get("schema") != SCHEMA:
        problems.append("schema 不是 %d" % SCHEMA)
    if data.get("coordSystem") != "GCJ-02":
        problems.append("coordSystem 不是 GCJ-02")
    devices = data.get("devices") or []
    areas = data.get("areas") or []
    if not devices:
        problems.append("devices 为空")
    if not areas:
        problems.append("areas 为空")
    if data.get("total") != len(devices):
        problems.append("total=%s 与设备数 %d 不符" % (data.get("total"), len(devices)))
    if sum(a["count"] for a in areas) != len(devices):
        problems.append(
            "分区台数之和 %d 与设备数 %d 不符"
            % (sum(a["count"] for a in areas), len(devices))
        )
    ids = [d["id"] for d in devices]
    if len(ids) != len(set(ids)):
        problems.append("设备 id 有重复")
    codes = [(d["area"], d["code"]) for d in devices]
    if len(codes) != len(set(codes)):
        problems.append("同一分区内桩号有重复")
    no_coord = [
        d["id"]
        for d in devices
        if not isinstance(d.get("lng"), (int, float))
        or not isinstance(d.get("lat"), (int, float))
    ]
    if no_coord:
        problems.append(
            "%d 台设备没有坐标（%s）" % (len(no_coord), " / ".join(no_coord[:5]))
        )
    no_anchor = [a.get("key") for a in areas if not a.get("anchor")]
    if no_anchor:
        problems.append("分区没有锚点：%s" % " / ".join(str(k) for k in no_anchor))
    if problems:
        die("catalog 自检不通过：" + "；".join(problems))
    return data


def build_text():
    """生成并自检，返回 (data, text)。不写盘 —— 写到哪里由调用方决定。"""
    data = validate(build())
    text = render(data)
    # 确定性：同一份输入必须产出同一份字节，否则「构建期生成」就没有可复现性。
    if render(validate(build())) != text:
        die("两次生成的结果不一致（输出不是确定性的）")
    return data, text


def generate(out_path):
    """生成并写入 out_path。打包器直接调这个函数，不经过子进程。"""
    data, text = build_text()
    parent = os.path.dirname(os.path.abspath(out_path))
    if parent and not os.path.isdir(parent):
        os.makedirs(parent)
    io.open(out_path, "w", encoding="utf-8", newline="\n").write(text)
    return data, text


def main():
    argv = sys.argv[1:]
    if "--check" in argv:
        data, text = build_text()
        print(
            "[OK] catalog 自检通过：%d 个分区 / %d 台 / %d 字节"
            % (len(data["areas"]), data["total"], len(text.encode("utf-8")))
        )
        return

    out = OUT
    if "--out" in argv:
        out = argv[argv.index("--out") + 1]

    data, text = generate(out)
    print(
        "已生成 %s：%d 个分区 / %d 台 / %d 字节"
        % (
            os.path.relpath(os.path.abspath(out), ROOT),
            len(data["areas"]),
            data["total"],
            len(text.encode("utf-8")),
        )
    )
    print(
        "         %s"
        % "、".join("%s=%d" % (a["key"], a["count"]) for a in data["areas"])
    )


if __name__ == "__main__":
    main()

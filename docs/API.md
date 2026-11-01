# 对外接口（第三方应用接入）

> 这份文档写给**想把「长安大学充电桩」接进自己应用的人**。
> 站点本身是纯前端单页，所有接口都在 `https://chd-charge.pages.dev` 下，全部只读。
>
> ⚠️ 这是个学生公益项目，跑在 Cloudflare 免费额度上。接口的限额不是摆设：
> 打穿了会连累所有人（页面转圈、统计断点）。**接入前先读第 0 节和第 6 节。**

---

## 0. 先决定你要什么数据

| 你要的 | 用哪个 | 一次请求拿到什么 | 新鲜度 |
|---|---|---|---|
| 有哪些桩、在哪、属于哪个区 | `GET /catalog.json` | 全部设备 + 分区 + 坐标 | 跟站点版本走 |
| 全校现在的空位 | `GET /api/snap?area=all` | 全部区 + 逐桩状态 | 分钟级（看时段） |
| 某个区「此刻」的准确状态 | `POST /api/pile` | ≤14 台的实时插座状态 | 秒级 |
| 一周占用率曲线 | `GET /api/stats` | 168 个小时点 | 每小时 |
| 全校空闲口总数（1 个数字） | `POST /api/shop` | `available` | 5 分钟 |

**最常见也最省的做法**：`/catalog.json` 拉一次存本地 → 首屏用 `/api/snap?area=all`
一次铺满 → 用户点「刷新」时只对**当前可见分区**打 `/api/pile`。

---

## 1. `GET /catalog.json` —— 设备目录（静态文件，无鉴权）

这是给第三方准备的入口。设备清单本来就在页面里，坐标本来是浏览器现算的 ——
把它们摊平成一份 JSON，省得每个接入方都去抠 500 KB 的 HTML、再把三套落点算法重写一遍。

```
GET https://chd-charge.pages.dev/catalog.json
```

- **不走 Worker**，是静态资源，不消耗 Functions 额度。
- 无 Origin 要求、无速率限制。
- `Cache-Control: public, max-age=300`，`Access-Control-Allow-Origin: *`（网页可直接 fetch）。
- 由 `campus-pile-kit/tools/gen_catalog.py` 从站点真源（`index.html` + `map-amap.js`）生成，构建时产出，与部署出去的那份页面同源。

### 结构

> 下面示例里的台数、分区数、版本号都是**示意值**，随站点版本变化；
> 真实值以响应为准，不要把它们写进你的代码。

```jsonc
{
  "schema": 1,
  "generator": "tools/gen_catalog.py",
  "source": { "devices": "...", "areas": "...", "geometry": "..." },
  "siteVersion": "v2.xx",        // 站点页脚版本，换版会变（示例值）
  "deviceSchema": 7,             // 站点本地清单的迁移水位（第三方一般用不到）
  "coordSystem": "GCJ-02",       // 🔴 不是 WGS84，见下
  "portsPerDevice": 4,           // 住芒那批桩的固定口数
  "total": 117,             // 示例值
  "locationRenames": [["物流服务中心", "物业服务中心"]],
  "locationAliases": ["渭水-物流服务中心", "渭水-住宅区", "渭水-住宅区(校外)"],
  "areas": [
    {
      "key": "chaohui",           // /api/stats 与 /api/snap 里的分区键
      "name": "朝晖体育场南",       // 展示短名
      "location": "渭水-朝晖体育场南", // 与 devices[].location 逐字一致
      "count": 36,
      "layout": "arc",            // grid | line | arc，说明坐标是怎么来的
      "src": "zm",                // zm（住芒，默认）| lvcc（驴充充）
      "anchor": [108.911069, 34.374054],  // 地图取景锚点 [lng, lat]
      "precision": "derived"      // derived | schematic
    }
  ],
  "devices": [
    {
      "id": "XLA29282",           // 平台查询键，跨版本稳定
      "code": "TY-01",            // 桩号，站点地图的落点键
      "name": "渭水校区 TY-01 号桩",
      "area": "chaohui",          // → areas[].key
      "location": "渭水-朝晖体育场南",
      "src": "zm",                // /api/pile 的 src 字段就用它
      "ports": 4,                 // 标称口数（失败时算分母用，真实口数以查询结果为准）
      "lng": 108.91011,
      "lat": 34.374531,
      "precision": "derived"
    }
  ]
}
```

### 三个必须知道的点

1. **`coordSystem` 是 GCJ-02**，和站点的高德/腾讯底图一致。用 WGS84 底图
   （OSM、Mapbox、自建离线图）的应用**必须自己做一次 gcj02 → wgs84 逆变换**，
   直接叠加会偏 400~600 米。站点不做转换，也不假设你用什么底图。
2. **`precision`**：`derived` = 由实测基准经标定/配准换算（北门、朝晖）；
   `schematic` = 沿产品方画的红线等分推算，只保证次序（20号楼、物业、住宅）。
   站点**没有逐桩实测坐标**，所以没有 `measured`。别把它当导航级精度用。
3. **`location` 字符串在历史数据里有脏值**：产品方手填时用过 U+2011（不换行连字符），
   分区也改过名（物流服务中心 → 物业服务中心）。比对前先归一化：
   把 `U+2010–U+2015`、`U+2212` 折成 `-`，再按 `locationRenames` 替换。
   `locationAliases` 是历史分区名，客户端看到它们时应当映射到现行分区。

---

## 2. `POST /api/pile` —— 逐台实时状态

这是站点自己的卡片用的接口。**一批最多 14 台**，超过直接 400，不会悄悄截断。

```http
POST https://chd-charge.pages.dev/api/pile
content-type: application/json
origin: https://chd-charge.pages.dev        ← 必填，见 §6.1

{"ids": ["XLA29282", "XLA30300"]}
```

### 请求字段

| 字段 | 类型 | 说明 |
|---|---|---|
| `ids` | string[] | 1..14 个，`/^[A-Za-z0-9_-]{4,32}$/` |
| `src` | `"lvcc"` | 可选。该批设备属于驴充充平台时必填；缺省 = 住芒。**一批只能一个源** |
| `fresh` | boolean | 可选。用户明确要「此刻」时传 `true` |
| `token` | string | 可选。只有站点维护者本机粘了自己的凭证时才带；**第三方不需要也不能用**（凭证在服务端） |

### 关于 `fresh`

`fresh: true` **不等于一定回源**。Worker 的边缘缓存里，如果这一台的数据比
`PILE_FRESH_MIN`（60 秒）更新，仍然直接用缓存 —— 这是刻意的：平台的限流按出口 IP 算，
全站共用一个出口，不能因为某个人点了刷新就多打一轮。

响应里的 `fresh` 字段回显你传了什么；真正判断「有没有换新」要看 `fetched` 和 `hit`。

### 响应

```jsonc
{
  "ok": true,
  "results": {
    "XLA29282": {
      "at": 1793534514674,                        // 毫秒
      "ports": [{"num": 1, "state": 1}, {"num": 2, "state": 0}]
    },
    "XLA30300": { "at": 0, "error": "平台没响应", "auth": false }
  },
  "hit": 1,          // 直接沿用边缘缓存的台数
  "fetched": 1,      // 真的回源平台的台数
  "recovered": 0,    // 被预算降级、后来又被别人刷新的台数
  "authFail": 0,     // 凭证失效的台数
  "fresh": false,
  "throttled": false, // true = 本轮有台因全站预算被降级为「用现有的」
  "oldestAge": 277    // 沿用缓存里最旧那台的年龄（秒）
}
```

`ports[].state`：**`0` 空闲、`1` 占用、其余（含 `-1` 异常/离线）一律按 `2` 处理**。
驴充充的原始 `ports` 数组下标 0 是占位符，插座从 1 开始 —— 站点已经归一过了，直接用 `num`。

单台失败时该项是 `{at: 0, error: string, auth: boolean}`，**没有 `ports`**。
`throttled: true` 是**降级不是错误**：保持你上一次的结果，别当失败重试。

### 错误码

| 状态 | `error` | 含义 |
|---|---|---|
| 405 | `method_not_allowed` | 必须 POST |
| 403 | `bad_origin` | Origin/Referer 不是本站（见 §6.1） |
| 400 | `bad_json` | 请求体不是 JSON |
| 400 | `no_ids` | `ids` 为空或全部不合法 |
| 400 | `too_many_ids` | 超过 `max`（14）——**请自己分批** |
| 400 | `no_token` | 服务端凭证缺失（`hint` 会说明是哪种） |
| 429 | `rate_limited` | 单 IP 超过 30 次/分钟 |

---

## 3. `GET /api/snap` —— 全校快照（一次拿全部）

这是**最省请求**的接口：一次返回所有分区、所有桩的逐插座状态。
数据来自定时采样（不是实时），所以新鲜度比 `/api/pile` 差，但成本是它的十分之一。

```
GET /api/snap?area=all          # 全部区
GET /api/snap?area=chaohui      # 单个区
GET /api/snap?area=all&refresh=1  # ⚠️ area=all 不支持 refresh，会回 refresh_ignored
```

- 边缘缓存 60 秒（`Cache-Control: public, max-age=60`）。
- 默认**只读**，不会触发上游扫描；只有 `area=<单个区>&refresh=1` 才会真的补刷。
- 采样间隔按「星期 × 小时」变化（工作日 5~60 分钟，周末 15~60 分钟），
  实际值在响应 `areas[].snapshot.interval`（秒）里。

### 响应

```jsonc
{
  "ok": true,
  "areas": [{
    "key": "chaohui", "name": "朝晖体育场南",
    "count": 36,          // 这个区**应该有**多少台（分区表口径）
    "age": 611,           // 这份快照多少秒前采的
    "degraded": false,
    "snapshot": {
      "valid": true,
      "error": null,      // {"code":"partial","failed":2,"kinds":["timeout"]} 之类
      "piles": 36,        // 这份快照里**实际有**多少台
      "checked": 36, "failed": 0,
      "total": 144,       // 插口总数
      "free": 6,
      "used_pct": 95.8,
      "at": 1793538922,   // 秒
      "interval": 900,
      "devices": {
        "XLA29282": {"p": "1111", "f": 0, "n": 4, "t": 1793538922},
        "XLA28826": {"p": "1101", "f": 1, "n": 4, "t": 1793538922}
      }
    }
  }],
  "summary": {"areas": 5, "total": 520, "free": 28, "used_pct": 94.6,
              "oldest_age": 611, "degraded_areas": 0},
  "oldest_key": "chaohui",
  "tuning": {"throttle_s": 120, "stale_hard_s": 1800, "cache_s": 60},
  "server_time": 1793539533
}
```

### `devices[id].p` 的编码

`p` 是**一个字符一个插座**的紧凑串，第 i 个字符对应插座号 i+1：

- `'0'` = 空闲
- `'1'` = 非空闲（占用、异常、离线都算）

`f` = 空闲数，`n` = 口数，`t` = 采样时间（秒）。
**注意**：这里只区分「空 / 不空」，没有 `/api/pile` 里的 `state=2` 细分。

### 🔴 缺失的设备是「未知」，不是「占用」

快照可能是 **partial** 的：某台桩这次超时，它就不在 `devices` 里，
`snapshot.piles` 会小于 `areas[].count`，`error.code` 会是 `"partial"`。

```js
// 正确的判读
const expected = area.count;              // 应该有多少台
const got = Object.keys(snapshot.devices).length;
const missing = expected - got;           // 这些是「这次没采到」，不是「满了」
```

把缺失当占用，会让「平台抖一下」直接变成「整片全红」。

### `tuning` 是服务端下发的常量

`throttle_s`（快照超过这个年龄才值得补刷）、`stale_hard_s`（超过就应当显示为旧数据）、
`cache_s`（本响应的缓存秒数）。**用它，别在客户端抄一份**——服务端调参时不会通知你。

---

## 4. `GET /api/stats` —— 一周回顾 / 各时段占用率

```
GET /api/stats
```

边缘缓存 300 秒。返回最近 7 天、每小时一个点（`keep: 168`）。

```jsonc
{
  "ok": true, "v": 1, "updated": 1793534738, "keep": 168,
  "points": [{
    "h": 1793534400,                       // 整点（秒，UTC）
    "at": 1793534738,                      // 实际采样时刻（秒）
    "areas": {
      "chaohui": {"pct": 99.3, "free": 1, "total": 144, "age": 315},
      "zhu":     {"pct": 87.5, "free": 13, "total": 104, "age": 96}
    },
    "all": 97,        // 全校占用率
    "coverage": 5     // 这个小时真的采到了几个区
  }]
}
```

### 🔴 `coverage` 不能拿「今天的分区数」当分母

分区是会长大的：`zhu`（住宅）从 2026-10-31T12:00Z 才开始有数据，
之前 47 个点只有 4 个区。判「这一小时是不是缺数据」时，
分母要用**这个点自己 `areas` 里的键数**，不是今天的 5：

```js
const expected = Object.keys(point.areas).length || point.coverage;
const complete = point.coverage >= expected;
```

否则加区那天之前的整周都会被标成「缺数据」——那几天其实一切正常。

`pct: null` 表示该区这一小时没有可用快照（例如 partial 或超时），不要当 0% 画。

---

## 5. 其余接口

### `POST /api/shop` —— 全站实时空闲口数

```http
POST /api/shop   {"shopId": "SDXA241610027"}
```

响应 `{ok: true, available: 1, at: <ms>, cached: bool, age: <s>}`。
边缘缓存 300 秒，`fresh: true` 可穿透（阈值 20 秒）。
**只覆盖住芒那 109 台**，不含驴充充的住宅区；`total` 恒为 `"0"`，分母要自己用目录算。

### `GET /api/cred` —— 凭证信箱元数据

只返回 `{ok, exists, updatedAt(ms), expiresAt(s), note}`，**不下发凭证本身**
（2026-10-27 起凭证只存在服务端）。第三方**用不上**，列在这里是为了让你知道别去试。

### `GET /api/ping` —— 自检

`{ok, kv: bool, token: bool, hints: string[], ts}`。用于确认部署绑定，不含敏感值。

---

## 6. 通用约定

### 6.1 Origin 闸门

`/api/*` 里的 `pile`、`shop`、`cred` 写操作都要求请求来自本站：

```
Origin（或 Referer）的 host 必须等于站点 host
```

否则 `403 {"ok": false, "error": "bad_origin"}`。

这是**防盗链**，不是鉴权。原生应用没有 CORS 约束，可以自行设置 `Origin` 头；
但它说明了一件事：**这个接口是给本站页面用的，第三方接入请优先用 `/catalog.json` 和 `/api/snap`。**

### 6.2 缓存

| 接口 | 边缘缓存 | 备注 |
|---|---|---|
| `/catalog.json` | 300 s | 静态资源 |
| `/api/snap` | 60 s | 公共缓存，全校共享 |
| `/api/stats` | 300 s | 公共缓存 |
| `/api/pile` | 单台 300 s（`fresh` 时 60 s） | 逐台缓存 |
| `/api/shop` | 300 s（`fresh` 时 20 s） | |

### 6.3 限额（都是「按出口 IP / 全站」算的，请当成硬约束）

| 项 | 值 |
|---|---|
| `/api/pile` 单次批大小 | **14 台**（超过 400） |
| `/api/pile` 单 IP 频率 | 30 次/分钟 |
| `/api/pile` 全站回源预算 | 160 台/分钟（仅住芒计入） |
| `/api/shop` 单 IP 频率 | 30 次/分钟 |
| `/api/cred` 读频率 | 60 次/分钟 |
| 平台侧并发上限 | 实测 20 并发 OK，30 并发约 1/3 超时，40 并发只剩 3 台 |

平台对**同一个出口 IP** 的请求量有硬上限。站点已经踩过一次：连续 109 台/分钟
会把出口 IP 打进风控，表现为**整片 TCP 超时**（不是 401、不是 429），
换网络才恢复。所以上面这些数不是保守，是实测出来的。

### 6.4 时间戳单位不统一

| 字段 | 单位 |
|---|---|
| `/api/pile` `results[].at` | **毫秒** |
| `/api/shop` `at` | **毫秒** |
| `/api/cred` `updatedAt` | **毫秒** |
| `/api/cred` `expiresAt` | **秒** |
| `/api/stats` `h` / `at` / `updated` | **秒** |
| `/api/snap` `at` / `server_time` / `devices[].t` | **秒** |

站点自己也被这个坑咬过（用 `raw > 1e11` 判单位）。接入时统一过一道。

---

## 7. 接入建议

1. **`/catalog.json` 拉一次缓存起来**，别每次启动都拉。它的变化频率等于站点改版频率（天级）。
2. **首屏用 `/api/snap?area=all`**，1 个请求铺满全表；**不要**一进来就 `/api/pile` 全量扫，
   那正好是站点当年把出口 IP 打进风控的打法。
3. **用户点「刷新」再打 `/api/pile`**，且只打**当前可见分区**（≤37 台 → 3 批）。
4. **按 `src` 分批**：住芒和驴充充不能混在一批里，混了会让一半的 id 打到错的平台。
5. **失败显示未知**：站点自己的口径是「查过但失败 = 未知」，不沿用上一次的绿点。
   否则「整片超时」会被误读成「刚才还有空位」。
6. **尊重 `throttled`**：它是降级，保持旧数据即可，不要重试。
7. **判断「有没有换新」看 `fetched`，别看 `fresh`**。

---

## 8. 变更记录

| 日期 | 变更 |
|---|---|
| 2026-11-01 | 新增 `GET /catalog.json`（设备目录 + 分区 + GCJ-02 坐标）与本文件 |

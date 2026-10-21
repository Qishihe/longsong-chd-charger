# 已授权域名上的运行时验收（2026-10-21 21:5x）

这个目录里是**在真实域名下**跑出来的结果，不是本地 `file://` 截的。

## 为什么非要「已授权域名」

高德 JS API 的 key 有**域名白名单**，它认的是**页面 origin**：

| 打开方式 | 高德会加载吗 |
|---|---|
| `file:///…/preview-v3.html` | ❌ 不加载（`window.AMap === undefined`） |
| `http://127.0.0.1:8080/…` | ❌ |
| `https://chd-charge.app.workbuddy.host:8443/…`（**带端口**） | ❌ origin 里多了端口号 |
| `https://chd-charge.app.workbuddy.host/…` | ✅ |

所以「未发布的页面」想跑真高德，只有一条路：**URL 是线上真域名，内容是本地字节**。

## 做法（`scratch/authdom/verify_auth.mjs`）

1. Edge 用 CDP 连上，`Emulation.setDeviceMetricsOverride` 390×844 @2x；
2. `Fetch.enable` + `Fetch.fulfillRequest`：把 `preview.html` / `preview-v3.html` / `map-amap-preview.js` / `map-data.js`
   四个请求的**响应体**换成本地工作区文件，**URL/origin 不动**；
3. 其余请求（`map-key.local.js`、`webapi.amap.com`、`/.cloud/*`）照常走线上；
4. 注入 `cpk.token`（已过期，只用来跳过「先接上一次」引导）+ 合成 `cpk.cache`（`SLOT_FREE = 0`，不是字符串 `'free'`）
   + 把 `cpk.devices` 落到 localStorage（这样 U+2011 A/B 才有东西可改）；
5. 断言 + 截图 + 存 JSON。

```bash
node scratch/authdom/verify_auth.mjs v3      # preview-v3.html
node scratch/authdom/verify_auth.mjs wuliu   # preview.html（物流 + normKey）
```

**两条走过的歪路**（别再试）：
- 本地 TLS + `--host-resolver-rules=MAP <域名> 127.0.0.1` → 要占 **443**，否则 origin 带端口，白名单照样拒；
- 本机 443 被沙箱代理拦，`curl` 走的是外网真站，拿不到本地文件。

## 结果

| 页面 | 通过 | 关键数字 |
|---|---|---|
| `preview-v3.html` | **19/19** | 高德 2.0；canvas 360×360；109 桩 / 109 点；建筑 83 / 场地 8 / 水域 2 / 楼名 95；胶囊在地图下方；底部导航 fixed；页脚不被压 |
| `preview.html`（物流） | **19/19** | 4 页签；点 wuliu → `渭水-物流服务中心` zoom 19.40；**W01…W12** 齐；**U+2011 A/B 仍是 12 桩** |

证据：`verify-v3.json`、`verify-wuliu.json`（含每一条断言的原始值）。

| 图 | 内容 |
|---|---|
| `v3-01-map.png` | v3 首屏：统计条 218 空闲、地图卡、朝晖双弧桩号 |
| `v3-02-mapcard.png` | 地图卡 + **地图下方的地点胶囊** |
| `v3-05-devices.png` | 设备页（109 张卡） |
| `v3-06-usage.png` | 使用情况弹窗（图表空，见下） |
| `v3-07-settings.png` | 设置 → 先弹**同步密码**（设计如此） |
| `v3-08-bottom.png` | 滚到底：页脚与底部导航**不重叠** |
| `wuliu-03b-wuliu-dialog.png` | **物流分区 W01…W12 竖排红线**，W-01 在下 |
| `wuliu-04-u2011.png` | `location` 换成 U+2011 后重载，仍然 12 台 |

## 两个「不是缺陷」

1. **「设置打不开」**：`#open-settings` 绑的是 `openSyncDialog`，先弹同步密码框，输对才 `tryOpenSettings()`。
2. **使用情况图表 canvas=0**：这台环境没有有效 token，历史也拉不到（云端库当时被隔离），无数据就不画图。
   云端恢复后需复测。

## 🔴 当日环境异常（与代码无关）

`.cloud/database/rest/*` 全部返回 **503**，响应体：

```json
{"code":"DATABASE_RESOURCE_ISOLATED","message":"Database resource is isolated.","server":"tcbgw"}
```

页面发请求时是带真实 `x-wb-webapp-access-key: wbpk_F4H…` 的，所以不是「没鉴权」。
含义是**平台侧数据库资源被隔离**（欠费/配额/停用一类），影响凭证共享、设备清单同步、历史快照、自动换 token。
需要产品方在云控制台处理。

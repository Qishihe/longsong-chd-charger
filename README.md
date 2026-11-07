# 长安大学充电桩查询

> 一个页面看清校园里每台共享充电桩还剩几个空位 —— 不用装 App、不用登录、不用扫码。

<p align="center">
  <a href="https://chd-charge.pages.dev/img/home.png"><img src="https://chd-charge.pages.dev/img/home.png" srcset="https://chd-charge.pages.dev/img/home.png 1x" width="285" alt="主界面：天气提醒、空闲插座统计与每台桩的实时空位"></a>
</p>

<p align="center">
  <code>纯前端单页</code> · <code>无构建、无框架、无 npm</code> · <code>200 台桩 / 10 个分区 / 4 个校区</code> · <code>v3.18</code>
</p>

---

## 这是什么

长安大学四个校区（渭水、本部北院、雁塔、小寨）的共享充电桩，分散在教学楼、公寓、体育场和停车场周边。
以前要查空位只能走到桩前扫码，或者一个个点开小程序看 —— 结果常常是**走到那儿才发现全被占了**。

这个项目把「哪台桩现在有几个空位」直接摊在一张手机页面上。

**现在覆盖 200 台桩、10 个分区：**

| 校区 | 桩数 | 分区 |
|---|---:|---|
| 渭水 | 117 | 住宅、物业、20 号楼、北门、朝晖体育场南 |
| 本部北院 | 57 | 北院 |
| 雁塔 | 26 | 水院、图书馆、5 号公寓南、停车场出口 |
| 小寨 | 0 | 暂无桩位，只提供地图 |

打开就是这些东西：

- **空闲插座总数**与**更新时间**，一眼知道「现在到底还有没有位置」
- 每台桩一张卡片，绿块 = 空闲、红块 = 占用，编号与插座序号都写着
- 按地址筛选、按空闲数/编号排序、收藏常用桩、切换一行一个 / 一行两个
- 地图视图：四个校区各有「校区全图」，建筑带名字，地址聚合成圈并标着还剩几个空位
- 未来 24 小时要下雨、下雪、冻雨或打雷时，页首提前提醒一句（按校区各自计算）
- 「一周回顾」：过去七天各时段占用率，挑人少的时候去
- 断网也能打开（Service Worker 缓存外壳），只是数据会标灰

数据来自第三方充电平台的扫码接口，凭证由使用者自己提供并保存在**浏览器本地**，服务端只存一段加密后的密文用于跨设备同步。

## 界面

<p align="center">
  <a href="https://chd-charge.pages.dev/img/map.png"><img src="https://chd-charge.pages.dev/img/map.png" srcset="https://chd-charge.pages.dev/img/map.png 1x" width="215" alt="地图：校区全图，建筑名、地址聚合圈与空位数"></a>
  <a href="https://chd-charge.pages.dev/img/review.png"><img src="https://chd-charge.pages.dev/img/review.png" srcset="https://chd-charge.pages.dev/img/review.png 1x" width="215" alt="一周回顾：七天各时段占用率柱状图与热力图"></a>
  <a href="https://chd-charge.pages.dev/img/admin.png"><img src="https://chd-charge.pages.dev/img/admin.png" srcset="https://chd-charge.pages.dev/img/admin.png 1x" width="215" alt="管理员后台：快照新鲜度、设备凭证、自动续期与密码解锁"></a>
</p>

<p align="center"><sub>校区全图 · 一周回顾 · 管理员后台</sub></p>

<p align="center">
  <a href="https://chd-charge.pages.dev/img/settings.png"><img src="https://chd-charge.pages.dev/img/settings.png" srcset="https://chd-charge.pages.dev/img/settings.png 1x" width="215" alt="设置：校区、排序、显示方式、皮肤、字体、天气提醒、扫码快捷按钮"></a>
  <a href="https://chd-charge.pages.dev/img/share.png"><img src="https://chd-charge.pages.dev/img/share.png" srcset="https://chd-charge.pages.dev/img/share.png 1x" width="215" alt="分享本站：指向本站的二维码、复制链接与分享给同学"></a>
  <a href="https://chd-charge.pages.dev/img/dark.png"><img src="https://chd-charge.pages.dev/img/dark.png" srcset="https://chd-charge.pages.dev/img/dark.png 1x" width="215" alt="暗色主题下的首页"></a>
</p>

<p align="center"><sub>设置 · 分享本站 · 暗色主题</sub></p>

## 特性

| 能力 | 说明 |
|---|---|
| **零依赖前端** | 原生 HTML/CSS/JS，改完文件直接就是产物，没有构建步骤 |
| **四校区地图** | 在线底图（高德）打底，每个校区一张「校区全图」；建筑注记按屏幕像素逐级放出，缩小时只留显眼地标，不会糊成一片 |
| **天气提醒** | 未来 24 小时有雨雪、冻雨、打雷，或气温越过 37℃ / -5℃，页首挂一句提醒；四个校区各按自己那片天算，可整项关掉 |
| **一周回顾** | 过去七天各时段占用率曲线与热力图，按校区、地址、日期分开看 |
| **扫码快捷按钮** | 右下角一颗能拖、会自己贴边的按钮，点一下直接进支付宝「扫一扫」；微信不允许网页直跳，只能帮你打开微信 |
| **凭证信箱** | 站长在管理员后台上传一次，全班自动同步；AES-GCM + PBKDF2 加密后存 KV，服务端读不到明文 |
| **凭证自治** | 管理员后台显示凭证剩余天数与最近一次自动续期结果；到期前由本机计划任务抓新 token 自动上架 |
| **分享本站** | 设置里一颗「分享本站」，弹出指向本站的二维码，配「复制链接」「分享给同学」 |
| **充电记录** | 设置里点一下记下这次充电；事后可补「充了多久」「充了多少电」「花多少电费」，漏记的也能按过去的时间补登，画出时长与电量的双轴折线。账单截图也能直接导进来，认图在本机做，认完逐条摆出来给你核对，改完再入账；电费只填总额或拆成电费 + 服务费都行。电量与电费都照小程序读数手填，不做折算。可导出 JSON 备份、再导回来（按时间合并）。全部存在本机 localStorage，一个请求都不发 |
| **离线可用** | Service Worker 预缓存外壳与底图，断网仍能看列表结构和上次的结果 |
| **并发受控** | 逐台查询并发 6、单批 12 台、双泳道，避开平台按出口 IP 的风控 |
| **皮肤与字体** | 5 种风格 × 5 种材质 × 4 档字体，全部走 CSS 变量，可自由组合；跟随系统深浅色 |
| **守门检查** | 46 项静态断言守着版本号同升、缓存一致性、预缓存清单、反代配置、对外目录由真源生成 |
| **对外目录** | `catalog.json` 把设备清单、分区与 GCJ-02 坐标摊平成静态 JSON，第三方应用不必解析页面 |
| **Android 壳** | WebView 壳只加载线上站点，页面更新不用重装 APK；推 `android-app/**` 由 GitHub Actions 出包 |

## 最近的更新

| 版本 | 变化 |
|---|---|
| v3.10–v3.18 | 充电记录扩成完整账本：手填电量与电费（可拆电费 + 服务费）、补登过去、导入订单截图本机识别后逐条核对、导出 JSON 备份；折线图把时长 / 电量 / 电费画进同一张图，同一比例、缺值断开；截图识别改为按订单号、账单里重复写的数与「电费 + 服务费 = 总额」自己校对，读准的直接勾上、不再条条标黄；使用说明补齐，页面重复文案与赞助二维码撤掉。公告按每 0.1 级归档 |
| v3.00–v3.09 | 四校区全图与建筑名按缩放分级、分享本站、记一次充电（带日期、可补时长电量、双轴折线）、设备凭证搬进管理员后台、主按钮配色修正 |
| v2.90–v2.99 | 天气提醒横幅（按校区各算各的）、可拖动的扫码快捷按钮、雁塔三处场地接入 |

🔴 这张表**按每 0.1 级合并一行**，不按小版本逐条堆；逐条明细在页面「关于本站 › 版本更新」里。
更早的变更也在那里翻。

## 它是怎么工作的

```mermaid
flowchart TB
    subgraph Client["浏览器（无后端依赖）"]
        Page["index.html<br/>单文件应用"]
        LS["localStorage<br/>加密凭证 + 偏好设置"]
        SW["Service Worker<br/>外壳缓存"]
    end

    subgraph Edge["边缘"]
        Host["静态托管<br/>Cloudflare Pages / 自建 gzip 服务"]
        Worker["Worker<br/>只处理 /api/*"]
        KV["KV<br/>加密后的凭证密文"]
        Snap["快照站 Worker<br/>定时采样 + 统计"]
        D1["D1<br/>按小时聚合的占用记录"]
    end

    Platform["第三方充电平台"]

    Page --> LS
    Page --> SW
    Page -- "静态资源" --> Host
    Page -- "读快照 / 换凭证" --> Worker
    Worker -- "凭证信箱读写" --> KV
    Worker -. "批量代查（带全站共享缓存）" .-> Platform
    Snap -. "定时逐区采样" .-> Platform
    Snap --> D1
    Page -- "一周回顾" --> Snap
```

默认由浏览器逐台直连平台（省掉中间跳数，也把风控压力分散到每个真实用户）；
URL 加 `?pileproxy=1` 切到服务端代查 —— 既是出口网络打不通平台时的救急手段，也是自动化测试必需的通道。
两种路径共用同一套并发上限，避免「自己把自己打挂」。

快照站是**独立的 Worker**：主时钟每分钟醒一次，按「分钟 % 5」取一组分区去采样，一跳最多两个区、70 台，
写完落到 D1。首屏因此不用打平台 —— 直接读最近一次全区快照，用户点刷新才真正发请求。
这条设计来自一次事故：一进来就全量扫，把出口 IP 打进平台风控，整片 TCP 超时。

## 第三方应用接入

设备清单和桩位坐标**本来就是公开数据**，只是过去只以「页面」的形态存在：清单内联在
`index.html`，坐标由 `map-amap.js` 在浏览器里现算。别的应用想接进来，只能去抠 500 KB 的 HTML、
再把三套落点算法重写一遍 —— 而且站点一改版，它们就静默错位。

所以额外产出一份静态目录：

```
GET https://chd-charge.pages.dev/catalog.json    # 全部设备 + 分区 + GCJ-02 坐标
```

它是静态文件：不走 Worker、不消耗 Functions 额度、无鉴权，带 `Access-Control-Allow-Origin: *`，
网页应用也能直接 `fetch`。

**它是构建产物，不进入版本库**：`make_cloudflare.py` / `make_dist.py` 打包时调
`tools/gen_catalog.py` 生成，`serve_gzip.py` 启动时也会在内存里生成一份。
所以改了 `DEFAULT_DEVICES` 之后不需要任何手工步骤。

实时状态、全校快照、一周统计的接口形状、缓存与限额见 **[docs/API.md](docs/API.md)**。

一句话原则：**首屏用 `/api/snap?area=all` 一次铺满，用户点刷新才用 `/api/pile` 打当前分区**。
一进来就全量扫，正是当年把出口 IP 打进平台风控、整片 TCP 超时的那种打法。

## 快速开始

只需要 Python 3.10+，不需要安装任何依赖。

```bash
git clone https://github.com/Qishihe/longsong-chd-charger.git
cd longsong-chd-charger/campus-pile-kit/chd-charge
python -m http.server 8080
# 浏览器打开 http://127.0.0.1:8080/index.html
```

打开后是**没有数据**的 —— 因为还没有凭证。页面顶部「使用说明」里写了怎么看桩位、
怎么记充电（含订单截图导入与备份）；数据要先从小程序取一串 token，
粘到「设置 › 管理员后台 › 设备凭证 › 更新」里。

配地图还需要一个高德 Key：复制 `map-key.example.js` 为 `map-key.local.js`，
按里面的六步填自己的 Key 与安全密钥（前端 Key 必然公开，域名白名单是唯一有效防护）。
**不配也能用，只是地图页签打不开。**

## 部署

站点是纯静态的，可部署到任何静态托管。

**Cloudflare Pages**

```bash
cd campus-pile-kit
python tools/make_cloudflare.py     # → dist-cloudflare/ 与 dist-cloudflare.zip
```

把 `dist-cloudflare.zip` 拖进 Cloudflare 控制台的 Create deployment 即可
（或 `npx wrangler pages deploy dist-cloudflare --project-name=<项目名> --branch=main`）。
⚠️ 必须传 **zip**、且 zip 顶层就是站点根 —— 套一层目录会导致根路径 404。

**任意 HTTP 服务器 / 需要 `/api/*` 反代时**

```bash
cd campus-pile-kit/chd-charge
PORT=8080 python serve_gzip.py
```

`serve_gzip.py` 是自带 gzip + ETag 的静态服务器，并反代 `/api/*` 到上游 Worker
（伪装浏览器 UA、改写 Origin —— 两件事漏一件就会被 Cloudflare 拦成 1010 / 403）。

**Android**

推 `campus-pile-kit/android-app/**` 会自动触发 GitHub Actions 构建 APK
（`minSdk 26`，release 签名从仓库 Secrets 取）。壳只加载 `https://chd-charge.pages.dev/`，
页面发版不用重出包 —— 靠 `no-cache` 响应头 + Service Worker 导航网络优先来保证跟新。

## 目录结构

```
campus-pile-kit/
├── chd-charge/          站点根目录（会被整包发布，别放私密文件）
│   ├── index.html       单文件应用（脚本内联）
│   ├── sw.js            Service Worker（预缓存 6 项外壳）
│   ├── map-amap.js      地图引擎：取景、聚合、建筑注记分级
│   ├── map-data.js      分区登记 + 底图坐标
│   ├── map-*.webp       兜底手绘底图
│   ├── share-qr.png     分享用二维码
│   ├── catalog.json     对外设备目录（构建产物，打包时自动生成）
│   ├── help.html        旧的图文教程（已下线：不进包、Worker 回 410，仅留档）
│   ├── serve_gzip.py    发布用服务器（静态 + gzip + /api 反代）
│   └── icons/           PWA 图标与 favicon
├── tools/               打包 / 守门 / 目录生成 / 凭证工具
│   ├── check_release.py 发布体检（46 项）
│   ├── gen_catalog.py   生成 catalog.json
│   └── cred_autorenew.py 凭证自动续期（本机计划任务调用）
├── snapshot-worker/     定时采样与统计的 Cloudflare Worker（D1）
├── android-app/         Android WebView 壳（只加载线上站点）
├── docs/                部署文档与历史评估
└── data/                采样产物与历史统计
```

## 验收

改动完发布前跑一遍守门：

```bash
python campus-pile-kit/tools/gen_snapshot_partitions.py --check   # 分区表与 DEFAULT_DEVICES 一致
python campus-pile-kit/tools/gen_catalog.py --check               # 对外目录生成器自检
python campus-pile-kit/tools/check_release.py                     # 发布体检（含上面两条的等价断言）
```

`check_release.py` 检查的是「最容易静默出错」的那几类东西：版本号几处是否同升、
Service Worker 缓存名是否跟着换、预缓存清单与页面引用是否逐字一致、
`serve_gzip.py` 的反代与 gzip 配置是否正确、注释里有没有会提前闭合的 `*/`。

改了 `DEFAULT_DEVICES`（加桩、改桩号、加分区）之后：`partitions.mjs` 是 wrangler 的部署输入、
必须提交，所以那条 `--check` 会先红，重跑生成器再提交；`catalog.json` 是构建产物、不进版本库，
打包时自动生成，**不需要任何手工步骤**。

## 文档

| 文档 | 内容 |
|---|---|
| [docs/API.md](docs/API.md) | **对外接口契约**：设备目录、实时状态、快照、统计、限额与接入建议 |
| [docs/DEVELOPMENT.md](docs/DEVELOPMENT.md) | 从零开始的完整开发历程：技术路线怎么定的、哪一步走错了、哪些坑必然踩 |
| [campus-pile-kit/docs/DEPLOY-CLOUDFLARE.md](campus-pile-kit/docs/DEPLOY-CLOUDFLARE.md) | Cloudflare Pages 部署步骤与高德白名单 |
| [campus-pile-kit/docs/DEPLOY-GUIDE.md](campus-pile-kit/docs/DEPLOY-GUIDE.md) | 自建服务器部署（systemd / nginx） |
| [campus-pile-kit/docs/纯静态部署步骤.md](campus-pile-kit/docs/纯静态部署步骤.md) | 纯静态托管的最短路径 |

## 免责声明

- 本项目是**学生公益项目**，与长安大学及任何充电桩运营商无隶属关系。
- 数据来自第三方平台的公开查询接口，本项目**不存储任何他人账户信息**；凭证由使用者自行提供，仅保存在自己的浏览器里。
- 查询结果仅供参考，实际可用状态以现场为准。请勿用于商业用途或高频自动化抓取 —— 那会让他人无法使用。
- 仓库内**不含**任何真实密钥、口令或抓包凭证；`*.local.js`、抓包存档等均已在 `.gitignore` 中排除。

## 许可

[Mozilla Public License 2.0](LICENSE)（MPL-2.0）· © 2026 长歌 (Changge)

- 可以自由使用、修改、分发，包括并入闭源项目 —— 前提是：**被你修改过的那些源文件**继续以 MPL 2.0 分发，并让拿到产品的人能取到它们的源码。
- 没有改动过的文件、你自己新写的文件不受此约束，可以和它们一起闭源分发。
- 内含明示的专利授权与「专利报复」条款；同时明确**不授予商标权**（请勿使用项目名与本项目图标作为你的产品标识）。
- 2026-11-01 之前发布的提交仍按当时的 MIT 许可发布，可从 git 历史取用；此后版本适用 MPL 2.0。
- 版权与单文件标注方式见 [NOTICE](NOTICE)。

## 致谢

感谢参与数据采集、拍摄照片、核对桩位信息的同学：渭水校区 **F.、ditto、W、元气少女**、本部北院 **予澄**、雁塔校区 **霆.** 等同学。

特别感谢 **予澄** 开发的采集设备编码功能，为各校区设备桩位信息的批量采集与整理提供了很大帮助。

特别感谢 **MyCHD** 作者 **Rinn**，为本项目的地图开发提供了思路与实现参考。

本项目在开发过程中参考、使用了以下开源项目：

- [MyCHD](https://github.com/RinnMoe/my_chu)
- [汕头大学充电桩监控](https://github.com/zhuangchuyuan86-bot/stu-charge-watch)

向所有开源开发者致谢 —— 开源社区的共享精神，是这个项目能实现的重要技术支撑。

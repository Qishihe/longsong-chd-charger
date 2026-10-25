# Cloudflare Pages 部署指南

**成本 0 元 / 年。** 免费额度：500 次构建/月、单站点 2 万文件、单文件 25 MiB、带宽不计量。
这个站 21 个文件、1.4 MB，用量连零头都不到。

---

## 一、上传（5 步，约 3 分钟）

1. 打开 <https://dash.cloudflare.com/> 注册 / 登录（**免费，不要求信用卡**）。
2. 左侧 **Workers & Pages** → 右上 **Create** → 选 **Pages** 页签 → **Upload assets**。
3. 项目名填 `chd-charge`（会成为 `<项目名>.pages.dev`，**全局唯一**；被占用就换个名字，记住它，下一步要用）。
4. 把 **`campus-pile-kit/dist-cloudflare.zip`** 直接拖进上传框 → **Deploy site**。
5. 等十几秒，拿到 `https://<项目名>.pages.dev`。

> **不要**拖 `dist-chd-charge.zip`（那是给「自己架服务器」的全量包，zip 里套了一层 `chd-charge/` 目录，
> 上传后根路径会变成 `/chd-charge/index.html`，打开首页 404）。
> **不要**选 Git 集成再想转直接上传 —— Direct Upload 项目**不能**事后改成 Git 集成，两者只能二选一。

---

## 二、⚠️ 必做：给新域名加高德白名单

**不加这一步，打开就是白屏（列表正常、地图区空的）。** 这是唯一必踩的坑。

高德 Key 的白名单认的是**页面 origin**，规则很严：

| 打开方式 | 地图 |
|---|---|
| `http://127.0.0.1:8080` | 不加载 |
| `https://xxx.pages.dev:8443`（带端口） | 不加载 |
| **`https://xxx.pages.dev`**（不带端口） | 需要加白名单才行 |
| `https://chd-charge.app.workbuddy.host`（旧站，已加过） | 正常 |

操作：

1. 登录 <https://console.amap.com/> → 应用管理 → 找到这个 Key（`map-key.local.js` 里那串）→ **设置**
2. 在 **Web 端（JS API）** 的白名单里加一条：`<项目名>.pages.dev`
   （只写域名，**不带 `https://`、不带路径、不带端口**）
3. 保存，**立即生效**，不用重启

> 加完刷新页面，`F12` → Console 里不该再有 `INVALID_USER_DOMAIN` 或 `AMap is not defined`。

---

## 三、验收清单（手工过一遍）

| 检查 | 期望 |
|---|---|
| 首页 | 打开不是白屏。未登录会看到「先接上一次」引导页 —— **这是正常的**，不是坏了 |
| 粘贴一个凭证后 | 列表出现 **109 台**（97 + 物流 12） |
| 地图页签 | **4 个**：渭水校区 / **渭水-物流服务中心** / 渭水-北门 / 渭水-朝晖体育场南 |
| 点「渭水-物流服务中心」 | 镜头拉到物流中心，**12 个 W 标记**，标号 `W01`…`W12`，**自下而上** |
| 地图总览（渭水校区） | 点位合计 **109**，不是 97 |
| 缩小地图 | 分区聚合成圈，不是一片空白 |

第 4 条是本次修复的重点（v2.03 及以前：列表 109、地图只有 97）。

---

## 四、已知坑（踩过的，别再踩）

1. **`pages.dev` 在国内的访问速度不稳。** 能用，但比国内服务器慢，偶尔抽风。
   如果同学普遍反映慢，可以绑自定义域名（免费额度含 100 个/项目），但**国内备案的域名 + 国内服务器**才治本；
   Cloudflare 只能改善，不能消除跨境延迟。
2. **高德 Key 是明文公开的。** 前端 Key 藏不住，这是必然 —— 你打开 `map-key.local.js` 就能看到。
   唯一的防护是**域名白名单**，所以第二节那步不能省。真要更强防护，去高德控制台把 Key 的「配额告警」打开。
3. **Direct Upload 不能转 Git 集成。** 选了拖拽上传，以后就只能一直拖。
   想要「push 代码自动部署」，得一开始就选 Git 集成（项目要重建）。
4. **更新时不要只传单个文件。** Cloudflare Pages 每次 Deploy 是**整体替换**，
   重新拖一次完整 zip 即可（旧文件不存在的会被清掉，这点比 WorkBuddy 的增量覆盖好）。
5. **`_headers` 不要删。** 它让 `sw.js` 和 `index.html` 走 `no-cache`。
   删了的话，发新版后用户可能长期看到旧页面（Service Worker 缓存）。
   `_headers` 本身不会作为文件发布出去，用 `curl https://<域名>/_headers` 应该 404。

---

## 五、以后怎么更新

```bash
cd campus-pile-kit
python tools/make_cloudflare.py     # 重建 dist-cloudflare.zip
```

然后回 Cloudflare → 你的项目 → **Create new deployment** → 拖新的 zip。

> 改动了 js 文件时，记得同步升 `?v=` 和 `sw.js` 的 `CACHE` 名（项目里的 `check_dual_track.py` 会帮你查）。

---

## 六、脱离平台后失效的 4 个功能

站点里有一层 WorkBuddy 云（`sdk/workbuddy-cloud.global.js` + `/.cloud/*`），换到 Cloudflare 后这层不存在：

| 功能 | 状态 | 影响 |
|---|---|---|
| 凭证共享（一人抓、全员用） | 失效 | 每台设备各粘一次 |
| 设备清单云同步 | 失效 | 用页面内置的 109 台默认清单 |
| 历史空位快照（趋势图） | 失效 | 趋势图无数据 |
| 凭证自动换 token | 失效 | 手动重新粘一次 |

**核心功能不受影响**：查空位、列表、地图、筛选、收藏、排序全部照常。
（这 4 项在 WorkBuddy 云端被隔离期间本来就已经用不了了，所以实际损失 ≈ 0。）

---

## 七、这个包和另外两个包的区别

| 包 | 给谁用 | 特点 |
|---|---|---|
| `dist-cloudflare.zip` | **Cloudflare 上传** | 精简 21 文件，zip 顶层扁平，带 `_headers` |
| `dist-cloudflare/` | 同上的解压版 | 目录形式，也可拖文件夹上传 |
| `dist-chd-charge.zip` | 拷给别人自己架服务器 | 全量 31 文件，含 `serve_gzip.py`、改版样张，zip 里套了一层目录 |

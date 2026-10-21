# 长安大学充电桩查询 · 独立部署包

这个目录是一份**能脱离 WorkBuddy 平台独立运行**的完整站点：31 个文件、2.4 MB，零外部依赖（高德地图走公共 JS API）。

生成时间：2026-10-21 23:0x　｜　内容版本：**正式版 v2.03**（`index.html`）+ 内测版 v2.13 内容（`preview.html`）

---

## 一、三分钟跑起来（本机自测）

```bash
cd dist-chd-charge
python3 serve_gzip.py --port 8099
# 浏览器打开 http://127.0.0.1:8099/
```

`serve_gzip.py` 只用 Python 标准库，没有任何 pip 依赖。它比 `python -m http.server` 好在会 **gzip 压缩**：
首页 225,984 B → **78,248 B**（2.89 倍）。

> 也可以用 `PORT=8099 python3 serve_gzip.py`，或 `python -m http.server`（不压缩，功能一样）。

---

## 二、部署到你自己的服务器

### 方式 A：任意 Linux VPS（推荐，行为和现在完全一致）

```bash
# 1. 把整个目录传上去
scp -r dist-chd-charge/ user@your-server:/opt/chd-charge/

# 2. 直接起（前台试跑）
cd /opt/chd-charge && python3 serve_gzip.py --port 3000

# 3. 长期跑：交给 systemd
sudo tee /etc/systemd/system/chd-charge.service > /dev/null <<'EOF'
[Unit]
Description=CHD charge site
After=network.target

[Service]
WorkingDirectory=/opt/chd-charge
ExecStart=/usr/bin/python3 serve_gzip.py --port 3000
Restart=always
User=www-data

[Install]
WantedBy=multi-user.target
EOF
sudo systemctl enable --now chd-charge
```

前面再放一层 Nginx（反向代理到 3000）就能用 80/443。**注意要保留 `Accept-Encoding` 头**，否则 gzip 白做：

```nginx
location / {
    proxy_pass http://127.0.0.1:3000;
    proxy_set_header Host $host;
    proxy_set_header Accept-Encoding $http_accept_encoding;
    proxy_http_version 1.1;
}
```

### 方式 B：静态托管（Vercel / Netlify / Cloudflare Pages / GitHub Pages）

直接把目录文件传上去即可，**不需要 `serve_gzip.py`**（托管商自己做 gzip 和 CDN）。
入口 `index.html`。`serve_gzip.py` 和 `.md` 文件可以删掉。

### 方式 C：内网 / 只给学校局域网用

同方式 A，绑内网 IP 即可。

---

## 三、⚠️ 唯一必须改的地方：高德 Key 的域名白名单

**不换域名就没事；一换域名，地图会白屏。** 这是部署到别处最常踩的坑。

高德 key 认的是**页面的 origin**，规则很严：

| 打开方式 | 地图 |
|---|---|
| `http://127.0.0.1:8099` | ❌ 不加载（`window.AMap === undefined`） |
| `https://你的域名:8443`（带端口） | ❌ origin 多了端口号，照样拒 |
| `https://你的域名`（不带端口，已加白名单） | ✅ |
| 现在的 `https://chd-charge.app.workbuddy.host` | ✅ |

**做法**：登录 [高德开放平台控制台](https://console.amap.com/) → 应用管理 → 找到这个 Key →
「设置」→ 把新域名加到 **Web 端（JS API）** 的白名单里。改完立即生效，不用重启。

Key 在 `map-key.local.js` 里（明文）。这个文件**不要提交到公开仓库**，也不要发到群里。

> 顺带说明：`127.0.0.1` 不加白名单也能跑**列表**，只是地图区是空的。本地自测时看到空地图是正常的。

---

## 四、脱离平台后，哪些功能会失效

站点里有一层 WorkBuddy 云（`sdk/workbuddy-cloud.global.js` + `/.cloud/*` 接口）。换服务器后这层不存在，涉及 4 个功能：

| 功能 | 自部署后 | 影响 |
|---|---|---|
| **凭证共享**（一个人抓一次，所有人能用） | ❌ 失效 | 变成**每台设备各粘一次**凭证。日常使用不影响 |
| **设备清单云同步**（新桩位/新地址自动下发） | ❌ 失效 | 用页面内置的 97 台默认清单；要加设备就得改代码 |
| **历史空位快照**（使用情况页的趋势图） | ❌ 失效 | 趋势图无数据 |
| **凭证失效自动换 token** | ❌ 失效 | 需要手动重新粘一次 |

**为什么不能自己搭一个后端补上？** 能，但要改代码。这层是加密存储的（`cipher` + `salt` + 同步密码），
服务端拿到的只有密文。真要迁移，得重写 `cloudPullDevices()` / `cloudPushDevices()` / 历史快照三处，
或者用一个简单的自建 KV + 你自己定的同步密码。需要的话可以另开一轮做。

**核心功能不受影响**：查空位（直连浙大/浙木的接口）、列表、地图、筛选、收藏、排序全部照常。

---

## 五、数据怎么带走

数据全在浏览器的 `localStorage` 里（键前缀 `cpk.`），**跟服务器无关**。所以要带走分两步：

### 第 1 步：从旧站导出（在 `chd-charge.app.workbuddy.host` 上做）

打开 https://chd-charge.app.workbuddy.host/ → 按 `F12` → 切到 **Console（控制台）** → 粘贴：

```js
(() => {
  const out = {};
  for (let i = 0; i < localStorage.length; i++) {
    const k = localStorage.key(i);
    if (k.startsWith('cpk.')) out[k] = localStorage.getItem(k);
  }
  const blob = new Blob([JSON.stringify(out, null, 1)], { type: 'application/json' });
  const a = document.createElement('a');
  a.href = URL.createObjectURL(blob);
  a.download = 'chd-charge-backup-' + new Date().toISOString().slice(0, 10) + '.json';
  a.click();
  console.log('已导出', Object.keys(out).length, '项');
})()
```

会下载一个 `chd-charge-backup-YYYY-MM-DD.json`，里面含设备清单、缓存、收藏、历史、token。
**这个文件含你的登录凭证，别公开发**。

### 第 2 步：导入新站（在新域名上做）

新站打开 → `F12` → Console → 先把文件内容读进来再粘：

```js
// 在 Console 里先执行下面这行，会弹出文件选择框
window.__pick = () => new Promise(r => {
  const i = document.createElement('input'); i.type = 'file'; i.accept = '.json';
  i.onchange = async () => r(JSON.parse(await i.files[0].text()));
  i.click();
});
const data = await window.__pick();
Object.entries(data).forEach(([k, v]) => localStorage.setItem(k, v));
location.reload();
```

> 提示：如果新域名下还没打开过页面，`localStorage` 是空的，导入后刷新即可。

### 如果只想带走设备清单（不含凭证）

旧站 Console 里跑：

```js
copy(localStorage.getItem('cpk.devices'))
```

粘到记事本保存。这份是纯设备列表（JSON 数组），可以安全分享。

---

## 六、文件清单

| 文件 | 大小 | 说明 |
|---|---|---|
| `index.html` | 226 KB | **正式版入口**（v2.03） |
| `preview.html` | 237 KB | 内测版（v2.13 内容：物流 W-01~W-12 + normKey） |
| `preview-v3.html` | 261 KB | v3 改版原型（独立页面，不影响主站） |
| `map.html` / `help.html` | 47 / 14 KB | 地图说明页、帮助页 |
| `map-amap.js` | 52 KB | 高德引擎（正式版） |
| `map-amap-preview.js` | 61 KB | 高德引擎（内测版，含物流分区） |
| `map-data.js` | 39 KB | 分区/建筑/场地坐标数据 |
| `map-key.local.js` | 1 KB | **高德 Key（私有，勿公开）** |
| `map-key.example.js` | 1.5 KB | Key 模板 |
| `sw.js` | 3 KB | Service Worker（离线缓存） |
| `serve_gzip.py` | 8 KB | 自带 gzip 的静态服务器（可选） |
| `sdk/workbuddy-cloud.global.js` | 72 KB | 云端 SDK（自部署后失效，可留着不影响） |
| `icons/` `map-*.webp` `map-beimen.svg` | 1.1 MB | 图标与底图 |
| `redesign*/` | 130 KB | 改版稿与样张（与主站无关，可删） |

**必须留着才能跑的最小集合**：`index.html`、`map-amap.js`、`map-data.js`、`map-key.local.js`、
`sw.js`、`preview-banner.js`（若保留 preview.html）、`icons/`、`map-*.webp`、`map-beimen.svg`。

---

## 七、常见问题

**Q：打开页面只看到「先接上一次」，没有设备列表？**
正常。未登录状态就是引导页。粘一次微信小程序的凭证（页面里有步骤）就能看到 97 台设备。

**Q：地图区是空的 / 白的？**
99% 是域名白名单（见第三节）。按 `F12` 看 Console 有没有 `INVALID_USER_DOMAIN` 或
`AMap is not defined`。

**Q：设备数量比原来少？**
云端清单拉不到时会退回页面内置的默认清单（97 台）。原来如果加过设备，用第五节的导出/导入补回来。

**Q：`serve_gzip.py` 访问 404？**
故意的，它在 `SELF_BLOCK` 里，不对外提供自己的源码。不影响站点。

**Q：能直接拿 git 仓库跑吗？**
可以，但 **`map-key.local.js` 被 `.gitignore` 排除了**，clone 下来会缺高德 Key，地图直接不加载。
这个包里的那份是完整的。

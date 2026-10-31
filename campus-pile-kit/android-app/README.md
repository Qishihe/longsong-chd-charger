# 安卓 App（WebView 壳）

把「长安大学充电桩查询」装进手机桌面的最小工程。
包名 `cn.edu.chd.charge`，minSdk 26（Android 8.0+），整包约 1.5 MB
（没有任何网页与图片资源，体积几乎全是 AndroidX 的兼容层）。

---

## 一、为什么网站更新，App 会跟着更新

因为这个 APK 里**一行网页都没有**。它只做一件事：启动时打开
`https://chd-charge.app.workbuddy.host/`，然后把屏幕交给那个网页。

更新链路是这样接起来的（三段都在线上，缺一段就会「App 里还是旧版」）：

| 环节 | 现有的配置 | 作用 |
|---|---|---|
| Cloudflare Pages `_headers` | `/` 与 `/index.html` → `Cache-Control: no-cache` | 浏览器/WebView 每次都要回源问一句「变了没」 |
| `sw.js` 的导航分支 | `request.mode === 'navigate'` → **网络优先**，失败才回缓存 | 在线时永远是线上那一份 HTML |
| `sw.js` 的激活 | `skipWaiting()` + `clients.claim()` | 新版本 SW 立刻接管，不用等第二次打开 |

所以：**你在电脑上部署完新版，手机上杀掉 App 重开，就是新版。** 不重装、不清缓存。

反过来说，只有下面这些情况才需要重新出 APK：

| 变了什么 | 网站重新部署 | 重出 APK |
|---|---|---|
| 页面内容 / 样式 / 皮肤 / 查询逻辑 | 需要 | 不用 |
| 换了域名 | 需要 | **需要**（入口地址编译进 BuildConfig 了） |
| App 图标、名字、返回键行为 | — | 需要 |
| 新增原生能力（通知、定位、分享…） | — | 需要 |

---

## 二、三步出第一个安装包

全部在 GitHub 网页上点，本机不需要装 JDK、Android SDK 或 Android Studio。

### 第 1 步：给密钥定个口令

仓库 → **Settings › Secrets and variables › Actions › New repository secret**

- Name：`KEYSTORE_PASSWORD`
- Secret：自己想一个口令，**记在密码管理器里**（丢了就再也签不出能覆盖升级的包，只能换新包重新装）

可选再加一个 `KEY_ALIAS`（不建则为 `chdcharge`）。

### 第 2 步：生成签名密钥（只跑一次）

**Actions** → 左侧「安卓 · 生成签名密钥（只需跑一次）」→ **Run workflow**，
输入框填 `GENERATE` → 运行。

跑完打开这次运行，在 **Summary** 里：

1. 记下 `SHA256:` 指纹（以后核对是不是同一把钥匙用）
2. 复制那串很长的 base64
3. 回到 Settings，新建 secret：Name 填 `KEYSTORE_BASE64`，值粘贴进去
4. 把 Summary 里也提示的：keystore 文件自己另存一份到 U 盘 / 密码管理器

> 为什么必须固定签名：Android 用它判断「新包是不是同一个 App 的升级」。
> 换了钥匙，新包装不上去，用户只能先卸载——所有人的偏好和凭证状态全丢。
> 所以这条 workflow 设计成只跑一次，跑第二次会覆盖旧钥匙（会造成上面这个后果）。

### 第 3 步：构建 APK

**Actions** → 「安卓 · 构建 APK」→ **Run workflow** → 等 3～5 分钟。

跑完在这页底部 **Artifacts** 下载 `chd-charge-apk`，解压得到
`chd-charge-<运行号>.apk`，传到手机上点开安装。

第一次装会问「是否允许安装未知应用」→ 允许。

---

## 三、装到手机上要注意的

- **传输**：微信/QQ 传文件后，先在微信里「用其他应用打开」→ 文件管理，否则微信内置预览会提示无法安装；数据线直接拷到 Download 目录最省事。
- **国产 ROM**：小米要在「设置 › 应用设置 › 授权管理 › 安装未知应用」放行；华为的「纯净模式」会拦，需要临时关闭。
- **首次打开提示「网络没连上」**：说明这台设备当时确实没网，或者校园网要先认证。连上再进一次。
- **卸载会清数据**：App 内的偏好（皮肤、显示方式）存在 WebView 的 localStorage 里，卸载即清空。覆盖升级不会丢。

---

## 四、日常怎么用

### 网站发版后

什么都不用做。手机上把 App 从后台划掉再点开，就是新版。

如果哪次确实看到旧内容，优先怀疑这三处，而不是 App：

1. Cloudflare 部署成功了吗（Pages 的 Deployments 是否为新提交）
2. `_headers` 里 `/` 的 `no-cache` 还在吗
3. `sw.js` 的 `CACHE` 版本号这次升了吗（发版纪律第 4 条）

### 改了 App 外壳之后

改 `campus-pile-kit/android-app/**` 并推到 `master`，workflow 会自动跑（也支持手动触发）。
`versionCode` 取 GitHub 运行号，天然递增，手机才会认这是升级。
直接覆盖安装即可，不用卸载。

### 想改入口地址

改 `gradle.properties` 的 `APP_URL` 和 `APP_HOST` 两行，推上去重新出包。
`APP_HOST` 决定「哪些链接留在 App 内、哪些丢给系统浏览器」，两个必须配套改。

---

## 五、本地构建（可选）

只有想改代码又不想每次推 CI 时才需要。

```bash
# 需要 JDK 17 + Android SDK Platform 35 + Build-Tools 35.0.0
cd campus-pile-kit/android-app
gradle wrapper --gradle-version 8.11.1   # 首次，生成 gradlew
./gradlew assembleDebug                  # 出可调试包
./gradlew assembleRelease                # 需要签名环境变量，见下
```

用 Android Studio 的话直接 **Open** 这个目录即可（`android-app/`，不是仓库根）。

本地签名（PowerShell）：

```powershell
$env:KEYSTORE_BASE64 = [Convert]::ToBase64String([IO.File]::ReadAllBytes("D:\keys\release.keystore"))
$env:KEYSTORE_PASSWORD = "你的口令"
$env:KEY_ALIAS = "chdcharge"
cd campus-pile-kit\android-app
.\gradlew assembleRelease
```

---

## 六、代码里几个刻意的决定

改之前先看这张表，每条都对应一个具体的坑。

| 位置 | 做法 | 为什么 |
|---|---|---|
| `setTextZoom(100)` | 固定 100% | 系统字号放大到 150% 会把 4 列插座格子撑出卡片；网站自己有字号体系 |
| `applyInsets()` 用原生 padding | 不用 CSS `env(safe-area-inset-*)` | Android WebView **不支持** safe-area 环境变量，只能原生补，否则状态栏压标题、导航条盖住最后一张卡 |
| 底部取 `max(系统栏, 键盘)` | 键盘弹出时底部让位 | 否则凭证输入框被键盘挡住 |
| `onPause()` 里调 `web.onPause()` | 主动触发 `visibilitychange` | 网站的「回前台超过 10 分钟才刷新」靠这个事件判断，不调就永远不会刷新 |
| `onCreateWindow` 用一次性 WebView 接住 | 而不是 `setSupportMultipleWindows(false)` | 关掉多窗口会让 `target="_blank"`（致谢里的 GitHub 链接）**点了完全没反应** |
| `onActivityResult` 取消时也回 `null` | 必须回调 | 不回的话页面的 `<input type=file>` 会永久卡死，再也点不开 |
| 返回键先问 `dialog[open]` | `evaluateJavascript` 查一次 | 站点的弹窗是 `<dialog>`，不产生浏览历史；不拦的话弹窗开着按返回会直接退出 App |
| `allowBackup=false` | 不参与系统备份 | 凭证本来就不落盘，没有需要备份的东西 |
| 只申请 `INTERNET` | 不申请定位/存储 | 网页里用不到，少一条权限就少一次安装时的心理负担 |
| `usesCleartextTraffic=false` | 禁明文 | 站点全站 HTTPS，禁掉可以避免被降级 |
| `setUserAgentString(... + " ChdChargeApp/1.0.0")` | 留个尾巴 | 以后想在网页里区分「来自 App」时有钩子可用，现在不影响任何逻辑 |

---

## 七、已知限制

- **断网只能看壳**：Service Worker 缓存的界面 + 上次的数据；空位数据本来就不缓存（缓存空位等于骗人）。
- **WebView 太老的机型**：站点用了 `body:has(dialog[open])` 锁背景滚动，需要 Chromium 105+（2022 年）。更老的 WebView 上弹窗打开时背景还能滚，功能不受影响，只是观感差一点。
- **不上应用商店**：自用侧载。要走商店需另外准备隐私政策、截图、软著等材料。
- **高德 Key 不用改**：WebView 里页面的 origin 仍是 `https://chd-charge.app.workbuddy.host`，域名白名单照样匹配。

---

## 八、出问题时

**构建失败**
看 Actions 日志。最常见是 SDK 组件没装上（`sdkmanager` 那段报错），重跑一次即可；其次是 Gradle 版本与 AGP 不匹配（工程钉的是 Gradle 8.11.1 + AGP 8.7.3）。

**手机上「应用未安装」**
十有八九是签名不一致（这次用了 debug 签名，或换过钥匙）。两个办法：找回原来那把 keystore；或者卸载旧版重装（会清数据）。
构建日志里会打印证书 SHA-256，可以和第一次生成时的指纹对比。

**打开白屏**
1. 手机浏览器能不能打开同一个地址？打不开就是网络/域名问题，跟 App 无关。
2. 能打开但 App 白屏：连电脑，Chrome 打开 `chrome://inspect`，选这个 WebView 看 Console（debug 构建已开 `setWebContentsDebuggingEnabled`）。

**内容不更新**
按「四、日常」里的三条排查。App 侧不需要做任何事——它没有本地网页副本，想旧都旧不下来。

**想再确认一次「到底是哪一版」**
App 里滚到页脚看 `版本 vX.XX`，那就是当前真实加载的网页版本。和 Cloudflare 最新部署对得上，就说明更新链路是通的。

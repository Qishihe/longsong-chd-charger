/* 只负责两件事：
   1. 让页面在断网时不至于白屏（壳走缓存）
   2. 让 Android 认定这是一个可安装的应用（有 fetch 处理器是硬条件）
   空位数据一律不缓存 —— 缓存空位等于骗人。
   云端的同步请求同样不能碰：那是同一域名下的接口，一旦被缓存优先命中，
   手机就会永远读到第一份密文，电脑换了凭证它也换不掉。 */

/* ⚠️ 改了预缓存逻辑就必须**同时把这个版本号 +1** ——
   Service Worker 只有「脚本字节变了」才会重新 install；
   只改 install 里的逻辑、不动这个名字，**已装用户的旧壳不会重来一遍** ✗
   v88 → v89（2026-10-22：SHELL 补 map-data.js + addAll 改逐条 add）
   v90 → v91（2026-10-22：fetch 里排除 /api/**，否则凭证信箱会被缓存钉死）
   v91 → v92（2026-10-23：两版都上了首屏预渲染 + 刷新按钮不再禁用，HTML 变了要换壳）
   v99 → v100（v2.10：Worker 并发池）
   v100 → v101（2026-10-25：SHELL 里的 map-data.js 从旧版本号跟到 `?v=164`
                  —— 页面已经升到 164，壳还钉在 163，**Cache API 按完整 URL 匹配**
                  → 断网时那份 map-data.js 命中不了，等于没预缓存 ✗
                  ⚠️ 以后改任何 `?v=` 都要回来搜一遍这个文件）
   v101 → v102（2026-10-25 v2.26：首页删掉「正在充电」「全站实时空闲」两块 DOM，
                  导航走网络优先本可自愈，但离线兜底那份壳还是旧结构 —— 换壳保证一致）
   v102 → v103（2026-10-25 v2.27：副标题「手机直连…」换成「致谢 & 贡献名单」弹窗入口）
   v103 → v104（2026-10-25 v2.16/v2.28：`credBoxAvailable()` 去掉 cloudSupport 短路 ——
                  老域名退回 109 台直连会被平台限流打穿，离线壳里存的是旧逻辑）
   v104 → v105（2026-10-25 v2.17/v2.29：刷新取数改回浏览器直连平台
                  （`PILE_DIRECT_ONLY`），离线的壳必须跟着换）
   v105 → v106（2026-10-25 v2.18/v2.29：内测同步正式版 —— 正式版也加了
                  「致谢 & 贡献名单」弹窗，离线壳里的 index.html 还是旧结构）
   v106 → v107（2026-10-25 v2.19/v2.30：致谢名单「元气少女李方朵」→「元气少女」，
                  两版文案都改了，离线壳里的那份还是旧名字）
   v107 → v108（2026-10-25 v2.20/v2.31：新增「使用说明」弹窗 + 赞助码图片，
                  SHELL 补 ./sponsor-qr.png —— 不加的话断网点开说明会裂图）
   v108 → v109（2026-10-25 v2.21/v2.32：致谢名单「卷不动根本卷不动」→「ditto」，
                  赞助说明去掉「掏钱」并标注支付宝收款码 —— index.html 内容变了，
                  不换壳的话老用户的离线副本还是旧文案）
   v109 → v110（2026-10-25 v2.22/v2.33：下掉「一周数据」入口按钮，
                  按钮区改成「地图 / 使用说明 / 设置」—— DOM 变了必须换壳）
   v110 → v111（2026-10-27 v2.23/v2.34：凭证不再写 localStorage，改成内存变量 +
                  首个会话标记 `cpk.had`；`credBoxPull` 的「要不要重新解」判断跟着改了）
   v111 → v112（2026-10-27 v2.24/v2.35：**凭证不再下发给浏览器** —— `/api/cred` 只回
                  `{updatedAt, expiresAt}`，解密和转发搬到 Worker，取数一律走 `/api/pile`。
                  这次是协议级的改动：旧壳里的页面会去读已经不存在的 `data` 字段，
                  表现是「信箱内容损坏」+ 永远不显示桩 —— 必须换壳把页面一起推下去）
   v112 → v113（2026-10-27 v2.25/v2.36：删掉写死在页面里的 `BUILTIN_SYNC_KEY`，
                  同步链路改成「没填密钥就不启用」。页面从此不持有任何解密钥匙 ——
                  原来那把钥匙公开在 HTML 里，等于锁和钥匙一起挂门口）
   v113 → v114（2026-10-29 v2.26/v2.37：开屏提速 —— ① 云服务 SDK 加 defer；
                  ② 首屏骨架卡写进 HTML；③ `seedFirstPaint()` 不再等凭证。
                  两版 HTML 都变了，老用户的离线壳必须换，否则断网时还是旧结构）
   v114 → v115（2026-10-29 v2.27/v2.38：手动刷新放宽到 60 秒 —— 前端加
                  MIN_MANUAL_GAP_MS 闸，Worker 的 PILE_FRESH_MIN 90→60、
                  回源预算 240→160）
   v115 → v116（2026-10-29 v2.28/v2.39：自动刷新 10 分钟 → 60 分钟；
                  抖动 ±60s → ±3min；「切回前台补刷」独立成
                  FOREGROUND_STALE_MS=10min，不再跟着自动刷新一起变成 1 小时）
   v116 → v117（2026-10-29 v2.40：新增「一周回顾」弹窗（头部第四颗按钮，读 /api/stats）。
                  HTML 结构变了 → 必须换壳，否则老用户的离线副本里没有 review-dialog，
                  点按钮会啥也不发生（showModal on null））
   v117 → v118（2026-10-29 v2.30/v2.41：头部加「版本更新」铃铛与齿轮设置，
                  插座格子改成 4 列并写字、占用块加斜纹。两版 HTML 结构都变了
                  → 必须换壳，否则老用户的离线副本里没有 changelog-dialog，
                  点铃铛会什么都不发生）
   v118 → v119（2026-10-29 v2.31/v2.42：插座格子去掉斜纹，改纯色。
                  只动了 CSS，不换壳的话老用户会一直是「带斜纹」的旧副本）
   v119 → v120（2026-10-29 v2.32/v2.43：统计卡数值与标签同行、更新时间改具体时刻。
                  有 DOM 结构变化（`.stat-line` 包了一层），必须换壳）
   v120 → v121（2026-10-29 v2.33/v2.44：更新时间卡改上下居中（`.stat-stack`），
                  公告红点改比「内容指纹」而不是版本号。DOM 又变了 → 换壳）
   v121 → v122（2026-10-29 v2.34/v2.45：重复刷新的黄色横幅条改成底部 toast。
                  新增 `#toast` 节点，老副本里没有它 → 不换壳的话 showToast 静默失效）
   v122 → v123（2026-10-29 v2.35/v2.46：设置弹窗改成三个入口 + 展开面板。
                  `#password-dialog` 删了、`#admin-entry` 没了、多了 `.set-item` /
                  `#set-*-panel`，老副本点齿轮会是一个什么都不做的旧弹窗）
   v123 → v124（2026-10-29 v2.36/v2.47：设置弹窗排版放松（只改 CSS 间距、无 DOM 变化），
                  但 HTML 内联样式变了 → 不换壳老用户会继续看到挤在一起的那版）
   v124 → v125（2026-10-29 v2.37/v2.48：剩下的一次性提示也搬到 toast，
                  并把 toast 改成「弹窗开着就挂进 dialog」—— JS 变、HTML 变，换壳）
   v125 → v126（2026-10-29 v2.38：内测版整体退役，设置里那颗「查看最新测试版」
                  入口和它那行说明删掉。HTML 结构变了 → 换壳）
   v126 → v127（2026-10-29 v2.39：两句过时文案改准 —— 设置底部不再声称「凭证只存在
                  你自己的浏览器里」，指引改指「设备凭证」。顺带修好本文件：从 v123 那条
                  起每行末尾都多了一个注释结束符，注释被提前闭合、正文成了裸文本，
                  SW 一直是语法错误、**从没注册成功过** —— 之前几轮「换壳」其实都没生效）
   v127 → v128（2026-10-29 v2.40：公告精简体 —— 14 条压成 2 条区间条目，
                  删掉测试版/赞赏码这类只有维护者看得懂的条目。HTML 变了 → 换壳）
   v128 → v129（2026-10-29 v2.41：「一周回顾」的日期选择从一排 chip 改成标题旁的气泡
                  （#rv-day 删了、多了 #rv-day-btn/#rv-day-bubble），口径说明改多行 div。
                  DOM 结构变了 → 必须换壳，否则老副本里没有气泡节点）
   v129 → v130（2026-10-29 v2.42：「空闲插座」卡加 .stat--free，数字/标签/副标
                  整组横竖居中（原来是左对齐、贴左上角，和右边居中的更新时间卡
                  并排看着没对齐）。纯 CSS 改动，但 CSS 内联在 index.html 里、
                  index.html 是壳文件 → 仍要换壳）
   v130 → v131（2026-10-29 v2.43：默认排序改「当前空闲」；卡片右上角「空闲 N/4 / 已满」
                  药丸换成定位图标（`data-find` 不变，点击即原来右下角的「查找」），
                  右下角「查找」按钮删除、`.find-btn` / `.pill*` 样式一并清掉。
                  顺带修 `camera` 宽高 NaN：`AMAP_MAP` 没有 w/h，初始化时
                  `camera.w = curMap.w` 得到 undefined → 首次回落静态底图时
                  37 个车位圈 `r="NaN"`。DOM + CSS 都变了 → 换壳）
   v131 → v132（2026-10-29 v2.44：地图打开逻辑改「直接展示当前这块分布，不放大不平移」
                  —— 取消 mount 后的 700ms 飞入动画（applyCamera 一律 immediate）、
                  卡片定位图标不再飞到单桩特写（改 `highlightPile()` 只加描边高亮）。
                  index.html（CSS `.pile.hl` + openMapAt 重写）+ map-amap.js 都变了 → 换壳）
   v132 → v133（2026-10-30 v2.45：地图新增「校区胶囊 + 地址胶囊」两级切换 ——
                  `#map-head` 里多了 #map-campus-btn / #map-campus-bubble，下面那排地址
                  胶囊去掉「渭水-」前缀；四个地址从「两个在线 + 两张手绘图」统一成在线
                  分区视图，手绘图收进 STATIC_MAPS 只作兜底。DOM + JS 都变了 → 换壳）
   v133 → v134（2026-10-30 v2.46：补上漏掉的「20 号楼」地址胶囊 —— `map-data.js` 的 areas
                  里一直有 `渭水-20号楼`、24 台桩挂在上面，却从来没给它做胶囊，这 24 台
                  只能混在校区全图里找。同步删掉地址胶囊下方那条「空闲数 / 已满 / 离线」
                  图例（DOM + CSS 一起删），并把标题行与胶囊行合成一整块顶栏（去分隔线）。
                  DOM + CSS + JS 都变了 → 换壳）
   v134 → v135（2026-10-30 v2.47：首屏凭证引导卡 `#guide` 整块下线 ——
                  「先接上一次」那张卡连同它那段就地显隐的内联脚本、CSS、两颗按钮
                  绑定一起删掉；凭证入口彻底收敛到右上角设置 › 设备凭证。
                  开屏现在是「先把上一次的结果铺出来」（seedFirstPaint 无条件执行），
                  拿不到凭证也只是顶栏说一句，不再清空卡片。
                  DOM + CSS + JS 都变了 → 换壳）
   v135 → v136（2026-10-30 v2.48：列表上方地址筛选从 <select> 下拉改成一行
                  左右滑动的胶囊（#loc-pills / .loc-pill，事件委托在容器上），
                  显示文案去掉「渭水-」前缀；旧 <option> 里写死地址导致新分区
                  不出现的问题一并修掉。排序下拉保留、挪到最右边。
                  DOM + CSS + JS 都变了 → 换壳）
   v136 → v137（2026-10-30 v2.49：卡片标题去掉「渭水校区」前缀（仅显示层，名称数据
                  不动 —— mapForAddress 还要靠全名识别地址）；设置弹窗新增第四个入口
                  「显示方式」：勾选后一行摆两个充电桩（#cards.two-col，插座格字号/高度
                  缩一号），默认仍是一行一个。
                  DOM + CSS + JS 都变了 → 换壳）
   v137 → v138（2026-10-30 v2.50：设置主面板改**分组列表**（小节标题 + 圆角卡，
                  行 = 图标 + 名称 + 右值 + 箭头，照产品方样式图做的），点行进
                  **独立子弹窗**（dlg-cred / dlg-sync / dlg-view / dlg-admin，
                  主面板留在下面）—— 原地展开的手风琴（.set-item/.set-panel）
                  整组退役；四个子弹窗的 DOM/ID 与老面板逐字一致，绑定没动。
                  同时给所有 <dialog> 加 overscroll-behavior:contain +
                  body:has(dialog[open]) 锁页面滚动：弹窗里滑到头不再带动
                  底下的设备列表。
                  DOM + CSS + JS 都变了 → 换壳）
   v138 → v139（2026-10-30 v2.51：卡片地址行压成一行 —— loc 加 nowrap+ellipsis，
                 且放开 flex 子项 min-width（不放开省略号不生效）；显示层再去掉
                 「渭水-」前缀（与胶囊/标题口径一致）。DOM + CSS + JS 变 → 换壳）
   v139 → v140（2026-10-30 v2.52：设置 › 皮肤 —— 风格（杂志编辑 · 书页朱砂，
                 衬线标题/细线/单栏）× 材质（磨砂玻璃 · 雾紫晶光，半透明面板/
                 backdrop-blur/细亮边/@supports 实色兜底），挂 <html> 的
                 data-skin / data-mat；皮肤 CSS 块在暗色 media 之后以覆盖深浅色。
                 DOM + CSS + JS 都变了 → 换壳）
   v140 → v141（2026-10-30 v2.53：不同网络下的加载提速 —— head 挂高德
                 dns-prefetch、boot 空闲时 preconnect 预热高德连接（不带
                 crossorigin，maps 是 no-cors 脚本）、map-data.js 加
                 fetchpriority=low 让带宽让给首屏；SW 壳补上云同步 SDK
                 ./sdk/workbuddy-cloud.global.js（72KB 功能必需文件）。
                 SHELL 变 + 页面变 → 换壳） */
/* v141 → v142（2026-10-30 v2.54：刷新按钮不再显示「37/109」数字（按钮不被撑宽）；
   红绿语义色变量化并随皮肤/材质适配 —— 新增 --free-deep/--free-soft(-2)/--free-line/
   --busy-soft 衍生档，杂志=墨绿+朱砂、玻璃=冷调青绿+莓紫；JS 画的 marker/pin/cluster
   也改读 var()，换肤即全局变色。DOM + CSS + JS 都变了 → 换壳） */
/* v142 → v143（2026-10-30 v2.55：杂志风不再锁死单栏 —— 「显示方式」的
   一行一个/两个在所有风格下都可手动切换：删掉 data-skin="magazine" 下强制
   #cards.two-col 回单栏的整段 CSS，只保留两列时卡片 padding=14px 的纸面
   呼吸感；皮肤弹窗与设置里的说明文案同步。   CSS + 文案变 → 换壳） */
/* v143 → v144（2026-10-30 v2.56：皮肤扩到 4 风格 × 4 材质 + 新增中性材质。
   新增风格 forest（森林麦穗，暗底）/ moss（苔绿暖橙）/ pixel（奶油草绿像素游戏）；
   新增材质 clear（透明磨砂，不带配色、继承风格）/ peach（桃雾莓光）/ deepsea（深海冰晶，暗底）。
   同时把「辅助面」全部收成变量（--slot、--sk- 系、--pressed、--toast- 系、--warn- 系、
   --bad- 系、--err- 系、--load- 系、--done- 系、--input-bg、--on-free、--on-busy、
   --on-accent），暗色模式与暗底皮肤共用一套，暗色 @media 由逐条覆盖改成只改变量。
   DOM + CSS + JS 变 → 换壳） */
/* v144 → v145（2026-10-30 v2.57：刷新闸放宽 + 北门桩号去掉「北-」。
   新增 scopeStaleAge()：当前地址里有超过 1 分钟的旧记录时，手动刷新只等 20 秒
   （MIN_RETRY_GAP_MS），不再被 60 秒闸拦死；横幅文案同步。
   shortPileLabel() 去掉「北-」前缀并把 A01 补成 A-01。   index.html 变 → 换壳） */
/* v145 → v146（2026-10-30 v2.58：只补查没响应的那几台 + 一周回顾标题行。
   新增 refreshPlan()：手动刷新先算「这一轮该查谁」—— 失败的、从没查过的、
   超过 1 分钟的都算 need；need 只是范围内一部分时只补这几台（不进全量闸），
   need 等于全部才算全量刷新。补查最小间隔 MIN_PARTIAL_GAP_MS = 5000。
   卡片错误行新增 cardErrText()：给「平台没响应」补「· 重新查询」入口。
   #review-dialog 的标题行改两行网格，关闭按钮与标题同行。   index.html 变 → 换壳） */
/* v146 → v147（2026-10-30 v2.59：设置里新增「关于」。
   开发者与致谢 & 贡献名单整块从首页副标题搬进 #dlg-about（入口 = 设置 › 关于本站）；
   首页副标题那条 by长歌 与 #thanks-open 链接、以及 #thanks-dialog 一并删除。
   顺带把唤起 QQ 前「关掉宿主弹窗」改成 link.closest('dialog')，不再写死使用说明。
   DOM + CSS + JS 变 → 换壳） */
/* v148 → v149（2026-10-30 v2.60：刷新误判 + 首屏并行。
   ①「连续 5 台没响应就砍整轮」改成失败率判定（查够 10 台、失败占比 ≥70% 才提前结束），
     平台偶发抖动不再误杀整轮；② 首屏查询与 /api/cred 凭证同步并行，KEY_BOX_EXP 持久化
     服务端凭证到期时间，refresh 不再串行等跨境往返。
   DOM + JS 变 → 换壳） */
/* v149 → v150（2026-10-30 v2.61：设置里加「字体」维度。
   第四个 data-* 维度 data-font（serif/mono/round，默认不挂属性），
   --font-ui / --font-display 两个变量收编正文与标题字体。
   DOM + CSS + JS 变 → 换壳） */
/* v150 → v151（2026-10-30 v2.62：15 处「关闭」文字链换成 30px 圆圈叉图标，
   「一周回顾」标题行改回三项一行（标题缩成「各时段占用率」）。
   DOM + CSS 变 → 换壳） */
/* v154 → v155（2026-10-30：图标定稿为花体字标「Changge」，并给图标链接加 `?v=1`
   打破浏览器自带的 favicon 缓存 —— 光换文件内容不够，Chrome/Edge 的 favicon 库
   按「图标 URL」缓存，URL 不变就一直显示旧图标（旧的内联 SVG 是绿闪电）。
   SHELL 里的 favicon 条目同步带上 `?v=1`：Cache API 按完整 URL 匹配，
   少一个 query 断网时就命中不了。icon-192/512 也进了壳，所以照样换壳） */
/* v153 → v154（2026-10-30：图标换成花体字标「Changge」，
   顶上 v153 那版「长」字 + 闪电（v152/v153 都没发过版）。
   SHELL 新加 ./icons/favicon.svg（页面改成外链它了），
   icon-192/512/favicon.svg 都是预缓存文件，内容变了必须换壳） */
/* v155 → v156（2026-10-31 v2.63：新增「渭水-住宅区」8 台 —— 另一个平台（驴充充）的机器，
   前端要按 `src` 分源、地图要认 `R-01~R-08` 这条线，`map-data.js` / `map-amap.js` / index 三份都变。
   SHELL 里的 `./map-data.js?v=` 跟着 164 → 165（Cache API 按完整 URL 匹配，少改一处就断网失效） */
/* v156 → v157（2026-10-31 v2.64：住宅这 8 台**合并成一个分区 + 重排桩号**——
   分区名 `渭水-住宅区`/`渭水-住宅区(校外)` → `渭水-住宅`，桩号 `R-01~R-08` → `Z-01~Z-08`，
   8 台全部上图并沿尚苑路排成一排。`map-data.js` 的 `areas` 键改了、`map-amap.js` 换成一排 8 个
   落点、index 加了 schema 7 迁移，三份都变。SHELL 里的 `./map-data.js?v=` 跟着 166 → 167。 */
/* v157 → v158（2026-10-31 v2.65：「一周回顾」加「住宅」这一路 —— 只动 index.html 里
   RV_AREAS 与「缺区」判定，共享 js / 地图数据都没变，所以 SHELL 的 `?v=` 不动，只换壳） */
/* v158 → v159（同一版，v158 只上线了几分钟）：住宅这一档在还没有统计点时会是一排
   灰桩，补了一句「这一档还没有数据」的说明。index.html 变了就必须换壳 ——
   壳名不变的话，已经装了 v158 的浏览器会一直用缓存里那份旧的 index.html。 */
/* v159 → v160（2026-10-31 v2.66）：回顾的地址档改成左右滑动的胶囊、地图的地址气泡
   多了一颗「住宅」。只动 index.html（样式 + MAP_ORDER + 页签按钮），
   共享 js / 地图数据都没变 → SHELL 的 `?v=` 不动，只换壳。 */
/* v160 → v161（同一版，v160 只上线了十几分钟）：地图地址气泡加到 6 颗后
   「朝晖」会被整颗推出可视区，收短了两颗的文案、收紧内距；另外给横滑行加了两端渐隐。
   样式与文案都在 index.html 里 → 只换壳（版本号不动，沿用 v158→v159 那次的做法）。 */
/* v161 → v162（2026-11-01 v2.67）：「换一串凭证」弹窗补上真正的上传通道 ——
   10-27 删掉内置同步密钥后，那条「加密传到云端」的链路恒 null，弹窗却在承诺
   「所有打开的人自动用上」，用户看到的是「传了没反应、刷新就没了」。
   现在弹窗多一个「写口令」输入框，校验通过后直接 POST /api/cred 写 KV。
   改动全在 index.html 与 help.html 的文案里，共享 js / 地图数据没变 → SHELL 的 `?v=` 不动，只换壳。 */
/* v162 → v163（2026-11-01 v2.68）：人多的时候不再被当成「平台封了你」——
   站点 Worker 对同一出口 IP 有每分钟 30 批的限流，校园网 NAT 下几个人就能吃满，
   而前端把 429 当成「整批失败」→ 剩下上百台逐台标成「平台没响应」→ 触发 10 分钟冷却 +
   劝用户换网络。现在 429 单独认、退一步重试、只提示「同时查的人有点多」。
   改动全在 index.html 里 → 共享 js / 地图数据没变，`?v=` 不动，只换壳。 */
/* v165 → v166（2026-11-02 v2.71）：扫码弹窗加闪光灯 —— 走库的
   applyVideoConstraints({advanced:[{torch:true}]})，按钮挂在 .scan-stage 上，
   按 getRunningTrackCapabilities().torch 决定显示（iOS Safari 不支持 → 藏起来）。
   改动全在 index.html 里 → 共享 js / 地图数据没变，`?v=` 不动，只换壳。 */
/* v164 → v165（2026-11-02 v2.70）：扫码弹窗的「摄像头打不开」是假警报 ——
   html5-qrcode 的 start() 成功后会把 #scan-reader 整个清空，而角标 hud 当时就在
   这个容器里，被一起抹掉；随后 .then 里 `$('scan-hud').hidden = false` 抛
   TypeError，又被紧邻的 .catch 当成摄像头失败显示出来（真错误被掩盖）。
   现在 hud/hint 移到容器外层的 .scan-stage 里，库再怎么清也碰不到。
   改动全在 index.html 里 → 共享 js / 地图数据没变，`?v=` 不动，只换壳。 */
/* v166 → v167（2026-11-02 v2.72）：新增「本部北院」57 台 + 首页校区下拉。
   这一版**共享 js 真的变了**（`map-data.js` 加了 `areas['北院-体育馆北停车场']`，
   `map-amap.js` 加了 57 个落点），所以 SHELL 里的 `./map-data.js?v=` 跟着 166 → 167 ——
   只换 CACHE 名不动 `?v=` 的话，Cache API 按完整 URL 匹配，新页面会去要 `?v=167`
   而壳里存的是 `?v=166`，断网开页面就没有 CHD_MAP。 */
/* v167 → v168（2026-11-02 v2.72 补丁）：v167 上线后又改了两处 index.html ——
   ① 空校区（雁塔/小寨）会把整条工具栏藏掉，连校区胶囊一起消失，用户切不回来；
   ② `#cards` 的 `min-height:100vh` 把空状态顶到一屏之外，看起来是白屏。
   两处都只动 index.html，但 v167 已经被一部分浏览器缓存了 → 必须换壳才拿得到新版。 */
/* v168 → v169（2026-11-02 v2.73）：北院那 57 个落点**重算了一遍**（位置没挪到对的地方：
   第一版压到求是路西侧运动场，第二版铺得比停车场还宽）。`map-amap.js` 的 `BY_GEO`
   与 `map-data.js` 的 `line` 都变了 → 两个 `?v=` 各 +1，壳跟着换。 */
/* v169 → v170（2026-11-02 v2.74）：顶部精简与设置补位，**壳必须换**。
   `index.html` 改了（地址胶囊去掉「全部」、排序搬进设置、新增校区/排序两个子弹窗、
   地址胶囊两端渐隐），`map-amap.js` 也改了（limitBounds 跟着视图走 —— 之前一进北院，
   轻轻拖一下就被高德拽回渭水）。两个 `?v=` 各 +1。 */
const CACHE = 'campus-pile-v170';
const SHELL = [
  './',
  './index.html',
  './help.html',
  './manifest.webmanifest',
  './icons/icon-192.png',
  './icons/icon-512.png',
  /* 标签页图标（8.9KB，花体字标转成的路径）。index.html 是外链它而不是内联 data URI，
     所以要进壳 —— 否则断网重开时标签页会退回默认图标。
     ⚠️ 必须带 `?v=1`，与页面里的 `<link rel="icon" ... ?v=1>` 逐字一致（Cache API 按完整 URL 匹配）。 */
  './icons/favicon.svg?v=1',
  /* 「使用说明」弹窗里的赞助码（39KB）。断网时点开说明也得看得见图，
     否则会是一个破图占位符。它不带 query，所以直接写路径即可。 */
  './sponsor-qr.png',
  /* 云同步（v2.53）的 DB 客户端 —— cloudSupport() 靠 WorkBuddyCloud 全局工作，
     是功能必需文件，不是平台残留。72KB 不小，进壳之后重访/断网不再白下
     （此前它靠 HTTP 缓存，弱网下经常 304 一来一回）。 */
  './sdk/workbuddy-cloud.global.js',
  /* ⚠️ 必须**带 `?v=167`** —— Cache API 按**完整 URL** 匹配：
     存不带 query 的 `./map-data.js`，断网时那个带 `?v=165` 的请求**命中不了**，等于没存 ✗
     ⚠️ 而且这个 `?v=` 要与页面里的**静态标签** `<script src="map-data.js?v=167">`
     和 `loadScriptOnce('map-data.js?v=167')` **保持一致**（升级时要一起改）✗

     为什么非要缓存它：首访那次导航发生在 SW 接管**之前**，所以它平时进不了缓存 ✗
     而断网时它是 `window.CHD_MAP` 的**唯一来源** —— 取不到就会让
     `mapAreaOf()` 与 `arcArea` 落到**同一个兜底值**，判据恒真，
     朝晖弧于是多画 20号楼(E-*) 与物流(W-*) 的桩（74 个点、24 个重合槽）✗
     （修好后应为 38 个节点 = 36 点 + 2 弧线） */
  './map-data.js?v=169',
];

self.addEventListener('install', (event) => {
  event.waitUntil(
    caches.open(CACHE)
      /* 🔴 2026-10-22 改：原来是 `cache.addAll(SHELL)` —— 它是**原子**的，
         SHELL 里**任何一条 404，整个预缓存就全空**；而下面那句 `.catch(() => skipWaiting())`
         又把失败**吞掉**了 → 页面上**零信号**，直到**真断网才表现为白屏** ✗
         （本次就是 `./help.html` 引起的，实测 cache = []、断网 reload = chrome-error 页。）
         改成逐条 add + allSettled：**单条失败不再拖垮整个壳** ✓
         ⚠️ 不要写成 `Promise.all` —— 那样一条失败就整体 reject，等于回到老问题 ✗ */
      .then((cache) => Promise.allSettled(SHELL.map((url) => cache.add(url))))
      .then((results) => {
        // 把失败项**喊出来**：SW 的 console 在 DevTools 里看得到。
        // 这是把「静默失败」变成「可观测」的唯一便宜手段 —— 否则下次还是只能靠断网白屏来发现 ✗
        results.forEach((r, i) => {
          if (r && r.status === 'rejected') {
            console.warn('[sw] 预缓存失败: ' + SHELL[i], r.reason);
          }
        });
        // ⚠️ **无论成败都要 skipWaiting**：若让某条失败把 activate 卡住，
        //    会变成「壳没备好、SW 也没接管」的更糟状态 ✗（旧代码用双 then/catch 表达同一语义）
        return self.skipWaiting();
      })
      .catch(() => self.skipWaiting())
  );
});

self.addEventListener('activate', (event) => {
  event.waitUntil(
    caches.keys()
      .then((keys) => Promise.all(keys.filter((k) => k !== CACHE).map((k) => caches.delete(k))))
      .then(() => self.clients.claim())
  );
});

self.addEventListener('fetch', (event) => {
  const request = event.request;
  if (request.method !== 'GET') return;

  const url = new URL(request.url);

  // 跨域（充电平台接口）一律直连，不介入
  if (url.origin !== self.location.origin) return;

  // 云服务数据面（/.cloud/**）：直连，绝不用缓存兜底
  if (url.pathname.indexOf('/.cloud/') === 0) return;

  /* 凭证信箱（/api/**，由 _worker.js 直出）：**必须排除**。
     这条是同一条原则的第二次踩点 —— 静态资源走的是「缓存优先 + 后台更新」，
     一旦把 /api/cred 也缓存了，手机会**永远读到第一份密文**，
     站长每周换凭证等于白换，而且没有任何报错信号 ✗ */
  if (url.pathname.indexOf('/api/') === 0) return;

  // 导航请求：网络优先，断了才用缓存里的壳
  if (request.mode === 'navigate') {
    event.respondWith(
      fetch(request)
        .then((response) => {
          const copy = response.clone();
          // 按实际路径缓存，避免访问 preview.html 时覆盖 index.html 的离线副本
          const isRoot = url.pathname === '/' || url.pathname === '';
          const cacheKey = isRoot ? './index.html' : '.' + url.pathname;
          caches.open(CACHE).then((cache) => cache.put(cacheKey, copy)).catch(() => {});
          return response;
        })
        .catch(() => {
          const isRoot = url.pathname === '/' || url.pathname === '';
          const cacheKey = isRoot ? './index.html' : '.' + url.pathname;
          return caches.match(cacheKey).then((hit) => hit || caches.match('./index.html') || caches.match('./'));
        })
    );
    return;
  }

  // 静态资源：先用缓存出图，同时后台悄悄拉一份新的存起来
  // （原来纯缓存优先，URL 不变就永远发旧文件，改完自己在手机上看不到效果，
  //   以为是没发布 —— 这套 stale-while-revalidate 就是为这个坑加的）
  event.respondWith(
    caches.match(request).then((hit) => {
      const network = fetch(request).then((response) => {
        if (response.ok && response.type === 'basic') {
          const copy = response.clone();
          caches.open(CACHE).then((cache) => cache.put(request, copy)).catch(() => {});
        }
        return response;
      });
      if (!hit) return network;
      network.catch(() => {});   // 断网时后台请求会失败，别让它变成未处理的 rejection
      return hit;
    })
  );
});

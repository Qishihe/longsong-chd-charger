/* 高德 Key 模板 —— 复制本文件为 map-key.local.js，填入你自己的值。
 *
 * 为什么不在仓库里直接写 Key：本仓库是公开的，Key 写进来等于送给所有人用，
 * 配额（150 万次/月）算在你头上，被刷光后你自己站点的地图会挂。
 *
 * 申请步骤：
 *   1) 打开 https://console.amap.com/dev/key ，注册并完成个人实名认证
 *   2) 应用管理 → 我的应用 → 创建新应用（名字随意）
 *   3) 该应用下「添加 Key」，服务平台必须选「Web端(JS API)」
 *   4) 创建成功后，页面上同时给你两样东西：
 *        · Key（32 位十六进制）
 *        · 安全密钥 securityJsCode（另一串 32 位）
 *      两个必须配对使用，少一个会报 INVALID_USER_SCODE
 *   5) 点该 Key 右侧「设置」→ 域名白名单，加上你的站点域名
 *      （只写域名，不带 https://、不带路径、不带端口；一次只加一条）
 *   6) 把下面两行的值换成你自己的，保存为 map-key.local.js
 *
 * 注意：
 *   · map-key.local.js 已在 .gitignore 里，不会被提交
 *   · 部署时这个文件必须一起传上去，否则线上地图会提示「未配置高德 Key」
 *   · 换 Key 时还要把 preview.html 里 map-amap.js 的 ?v= 号加一，否则 SW 缓存不刷新
 */
window.CHD_AMAP_KEY = '';       // ← 你的高德 Key（Web端 JS API）
window.CHD_AMAP_SCODE = '';     // ← 你的安全密钥 securityJsCode
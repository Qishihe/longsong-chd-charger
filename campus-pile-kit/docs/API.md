# HTTP 接口契约

主站是 Cloudflare Pages 高级模式，所有 `/api/*` 由 `tools/cloudflare/_worker.js` 处理。
`_routes.json` 已通配 `/api/*`，`sw.js` 明确排除 `/api/*`（不进离线缓存）。
本文档只描述**对外行为**；改字段或路径时同步升这里的版本说明。

- 文档版本：2026-11-10（v3.20 加入违规车牌登记）
- 所有响应 `Content-Type: application/json; charset=utf-8`，`Cache-Control: no-store`
- 时间统一用毫秒 Unix 时间戳；日与月按**北京时间 UTC+8 自然边界**
- 车牌先归一（全角转半角、各类连字符统一、去空白、大写）再参与比较

## 通用错误

| HTTP | error | 含义 |
|---|---|---|
| 400 | `bad_json` / `bad_plate` / `bad_campus` / `bad_reason` / `bad_ym` | 参数不合法 |
| 401 | `bad_token` | 管理员口令不对，或不是同源请求 |
| 405 | `method_not_allowed` | 方法不对 |
| 409 | `duplicate` | 同设备同日同车牌重复登记 |
| 429 | `daily_full` / `report_limit` / `query_limit` / `global_limit` / `storage_cap` | 当日额度已满，或库内明细总量触顶 |
| 503 | `plate_disabled` | D1 绑定或 secret 未配置 |
| 404 | `not_found` | 其余路径 |

429 是**日切归零、不累计**，不是滑动 24 小时窗口。

## 既有端点（简表）

| 方法 | 路径 | 说明 |
|---|---|---|
| POST | `/api/pile` | 批量代打上游查桩，`ids` 单批 ≤ 14 |
| POST | `/api/shop` | 商铺 / 驴充充查询 |
| GET | `/api/stats`、`/api/snap` | 反代快照 Worker，`?refresh=1` 可触发补刷 |
| GET | `/api/cred` | 凭证元数据（不含密文），60 次/分/IP |
| POST | `/api/cred` | 写凭证，需 `x-admin-token` |
| POST | `/api/cred/renew` | 自动续期结果上报，需 `x-admin-token` |
| GET | `/api/ping` | 自检：只回环境变量**名**与绑定是否存在 |

## v3.20 违规车牌登记

### 数据口径

| 口径 | 值 | 用途 |
|---|---|---|
| 记录保留窗口 | 180 天 | `reports` 明细惰性清理；月汇总保留最近 7 个自然月 |
| 普通查询统计段 | 180 天滚动 | `GET /api/plate?q=` 的 `count` 与登记回显的 N |

🔴 2026-11-10：查询段由 90 天拉到 **180 天，与保留窗口对齐** —— 库里还留着的
记录查询却数不到，对用户没法解释。两个常量仍分开写，改任一个都要同步
前端文案 / 本文档 / `_vm_v320` 回归。窗口变长也意味着同一车牌的累计次数会更高、
「挂榜」时间更久，见文末风险说明。
| 排行榜 | 自然月 `YYYY-MM` | 管理员按月份 + 校区筛选 |
| 每日登记上限 | 2000 条 | 全站当天总数，超限 `global_limit`，日切归零 |
| 明细总量上限 | 200000 行 | 库内 `reports` 行数硬顶，超限 `storage_cap`，不再写库 |

车牌在库里只有 `plate_hash = HMAC(normalize(plate), PLATE_HMAC_KEY)` 和
`plate_enc`（AES-GCM 密文，随机 IV），**明文只在管理员月榜接口临时解密返回**。
`src_hash` 是设备票据的 HMAC，不是账号、不是身份。

### `GET /api/plate`

不带 `q` 时返回配置（前端据此显隐入口，无需鉴权）：

```json
{
  "ok": true,
  "enabled": true,
  "windowDays": 180,
  "queryDays": 180,
  "maxPerDay": 2,
  "queryLimit": 3,
  "dailyCap": 2000,
  "totalCap": 200000,
  "campuses": [{"key": "weishui", "name": "渭水"}],
  "reasons": [{"key": "pull", "name": "拔充电器"}]
}
```

`enabled: false` 表示服务端尚未配置 `PLATE_DB` / `PLATE_HMAC_KEY` / `PLATE_AES_KEY`，
此时其余车牌端点一律 503，页面显示「暂未开放」，不影响查桩主功能。

带 `q=<车牌>` 时返回近 180 天统计（请求头 `x-plate-src` 带本机设备票据）：

```json
{"ok": true, "listed": true, "count": 2,
 "lastAt": 1762750000000,
 "byCampus": {"weishui": 1, "yanta": 1},
 "queryDays": 180}
```

未命中也扣查询额度，避免额度变成「哪些车牌登记过」的枚举探测器。
每台设备每天 3 次。

### `POST /api/plate/report`

```json
{"plate": "陕A12345", "reason": "pull", "campus": "weishui", "src": "<设备票据>"}
```

- `reason` ∈ `pull`（拔充电器）/ `park`（乱停）/ `other`（其他）
- `campus` ∈ `weishui` / `beiyuan` / `yanta` / `xiaozhai`，服务端白名单校验
- 成功：`{"ok": true, "total": 3, "queryDays": 180}`，`total` 是近 180 天次数

### 限额与两道硬闸门

免费额度是**账号级共享**的，车牌 D1 被刷爆会连带拖慢同账号的快照站查桩，
所以写入口有两道独立闸门，都在写库之前判定：

| 闸门 | 值 | 触发时 |
|---|---|---|
| 每车牌每天 | 2 次 | `429 daily_full` |
| 每设备每天 | 登记 5 / 查询 3 次 | `429 report_limit` / `query_limit` |
| **每日上限** | 全站 2000 条 | `429 global_limit`，日切归零 |
| **全部上限** | 明细 200000 行 | `429 storage_cap`，不扣额度、不写一行 |

每车牌 2 次按 `plate_hash + day` 全局计，不按校区分桶（否则换校区即可翻 4 倍额度）；
同设备同日同车牌由唯一索引幂等，不重复扣额度。

🔴 总量**不能每次 `SELECT COUNT(*)`**：18 万行扫一次就是 18 万行读，按每天
2000 次登记会把 D1 免费版的行读额度直接扫穿。所以用 `plate_meta` 单行计数器，
登记 +1、撤销 −N、清理 −N 维护；只有触顶时才强制清一次 180 天前的记录，
再用真实 COUNT 复核并自校正（计数器虚高时自愈，不会一直误拒）。

不支持、也不接受证据图片上传。

### `GET /api/admin/plate/rank`

**必须**带 `x-admin-token`（优先比对 `PLATE_ADMIN_TOKEN`，未配则退回
`ADMIN_TOKEN`），且请求必须同源。前端 `sessionStorage['cpk.unlocked']` 只是 UI 显隐，
不是鉴权 —— 直接 curl 打这个接口而没有令牌，一律 401。

参数：`ym=YYYY-MM`（缺省当前月）、`campus=<key>`（缺省全部）、`limit`（默认 20，最大 50）。

```json
{
  "ok": true, "ym": "2026-11", "campus": "",
  "months": ["2026-11", "2026-10"], "currentYm": "2026-11",
  "windowDays": 180,
  "rows": [{"plate": "陕A12345", "count": 3,
            "pull": 2, "park": 1, "other": 0, "lastAt": 1762750000000}]
}
```

`months` 由 `SELECT DISTINCT ym` 动态生成，范围受最近 7 个自然月
（`PLATE_MONTHS_KEEP`）约束；最早那个月可能不完整，当月是「进行中」。
🔴 月汇总是登记时累加的预汇总，惰性清理删掉 180 天前明细时**不会回退月汇总**，
所以边界月份上「月榜数字」与「180 天查询次数」可能不完全相等。走 `plate_month` /
`plate_month_campus` 的索引，不对明细做全表分组。每次查看写一条 `rank` 审计。

### `POST /api/admin/plate/revoke`

同样需要 `x-admin-token` + 同源。

```json
{"plate": "陕A12345", "ym": "2026-11", "campus": "weishui"}
```

删掉该车牌该月（可限定校区）的全部登记，回退对应月份与校区的汇总计数，
写一条 `revoke` 审计。返回 `{"ok": true, "removed": 3, "ym": "2026-11", "campus": "weishui"}`。
明细删掉后，180 天查询次数与当天剩余额度自动跟着变，不需要手工改冗余计数列。

这是「通知删除」的最低落地形态：不做这个就不要上线。

## 数据表

见 `tools/plate_schema.sql`。Worker 在首次请求时用
`db.batch(DDL)` 惰性建表（`CREATE ... IF NOT EXISTS`），控制台不强制手工执行 SQL；
该 SQL 文件留作留档与手动重建用。

| 表 | 用途 |
|---|---|
| `plates` | 车牌哈希主键 + 密文 + 首次/最近时间 + 历史累计 |
| `reports` | 明细（唯一权威数据），带 `(plate_hash, src_hash, day)` 唯一索引 |
| `plate_month` | 按自然月预汇总，供月榜索引扫描 |
| `plate_month_campus` | 按自然月 + 校区预汇总，供筛选 |
| `plate_quota` | 原子扣次（scope / key / day），不累计 |
| `plate_meta` | 明细总行数计数器，供总量闸门 O(1) 判定 |
| `plate_audit` | 登记 / 月榜查看 / 撤销留痕 |

180 天次数、当天已登记几次、按校区分布都从 `reports` 现算，
没有冗余计数列，撤销后不会出现「累计没跟着退」。

## 上线前置（控制台手工，代码里做不了）

主站是 Direct Upload，**没有 wrangler.toml**，绑定在 Cloudflare 控制台配置：

1. 创建 D1 数据库，在 Pages 项目 `Settings → Functions → D1 database bindings`
   绑定为 `PLATE_DB`，然后重新部署一次（绑定变更需 redeploy 生效）。
2. 加三个 Secret：`PLATE_HMAC_KEY`、`PLATE_AES_KEY`（高熵随机串），
   可选 `PLATE_ADMIN_TOKEN`（不配则复用 `ADMIN_TOKEN`）。
   🔴 口令一旦更换，旧的车牌哈希与密文会全部解不开，别在生产上随手改。
3. 部署后 `GET /api/plate` 看 `enabled:true`（同时会回 `dailyCap` / `totalCap`）。
   `/api/ping` 只回环境变量名与 KV / token 是否存在
   （`{"ok":true,"kv":true,"token":true,"hints":[...]}`），可用来确认绑定生效，
   但它**没有** `enabled` 字段。

免费额度是**账号级共享**：车牌功能被刷到 D1 超额会连带拖慢同账号的快照站
查桩主功能，建议把这块放独立 CF 账号。代码侧已有「每日 2000 条 / 总量 20 万行」
两道硬闸门兜底，见上文「限额与两道硬闸门」。

## 仍存在的风险（2026-11-10 复核）

按优先级，前两组是**上线前应处理的**，后两组是可接受但要有预案的。

1. **合规（P0）**：登记提交前只有一句最小告知，没有单独同意；「违规」由用户
   单方定性、不留证据（不传照片）、没有面向当事人的申诉 / 通知删除入口
   （目前只有管理员按月撤销）。车牌属可关联到个人的信息，HMAC 只是去标识化，
   不是匿名化。民法典 1195–1197 的通知—反通知、名誉权风险仍在。
   🔴 查询窗口从 90 天拉到 **180 天**后，同一车牌的累计次数更高、「挂榜」更久，
   这一项风险是加重的，不是减轻。
2. **防刷（P0/P1）**：Turnstile 未接（国内可达性没测过）；`x-plate-src` 是客户端
   自报的设备票据，换一串就能重置「每设备 5 登记 / 3 查询」；每车牌每天 2 次
   可被抢先占满，真实举报当天进不来；按 2000 条/天持续写，约 100 天就能把
   20 万行总量上限填满，之后全站登记一律 429（可用性拒绝服务）。
   isolate 内存里的限流不是硬闸，D1 原子扣次才是。
3. **数据与密钥（P1）**：`plate_month` 是登记时累加的预汇总，惰性清理删掉
   180 天前的明细时**不会回退月汇总**，边界月份上「月榜数字」与「180 天查询次数」
   可能不相等；`plate_audit` 没有任何清理策略，会一直长；`plates.total_all`
   只增不减，撤销后会留孤儿行。三把密钥的明文备份在本机文件里，
   换 `PLATE_HMAC_KEY` / `PLATE_AES_KEY` 会让全库解不开；管理员口令一旦泄露，
   月榜接口能把车牌明文整批读走。
4. **架构与运维（P1/P2）**：D1 与查桩主功能共用账号级免费额度，没有独立告警、
   没有备份 / 导出、触顶才知道；CSP 仍是 Report-Only（页面大量内联脚本与上拉外链，
   强制 CSP 会白屏）；同源校验能挡普通跨站，但 `Origin` 头可伪造，真正的边界是
   `x-admin-token`；撤销按月粗粒度，删一辆车当月全部登记时会连带删掉别人的合法登记。

建议的最小处置顺序：单独同意文案 + 申诉渠道 → Turnstile 或等价人机校验 →
审计表清理与月汇总重算 → 监控告警 / 独立 CF 账号。

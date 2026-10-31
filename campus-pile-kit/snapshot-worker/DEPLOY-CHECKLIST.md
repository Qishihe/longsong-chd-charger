# 快照方案 · 部署步骤清单（D1 版）

> 用途：把「从本地代码到线上跑起来」拆成可勾选的步骤。
> 当前状态：①代码 ✅ ②审计 ✅（D1 专项 22 条 + 循环专项 23 条） ③内部通道补丁 ✅（已打，待部署） ④建库 ⬜ ⑤部署 ⬜ ⑥前端接入 ⬜

---

## 为什么是 D1，不是 R2

2026-10-27 实测核实：
- **R2 是 CF 唯一要求绑支付方式才能激活的存储**（银联单标储蓄卡大概率被「card type not accepted」拒掉）。
- **D1 免费计划直接开，不需要卡**，且是 SQLite **强一致**数据库，锁原子性由 `INSERT ON CONFLICT DO NOTHING` 保证。
- 额度：D1 免费 10 万行写/天（**按天重置，UTC 00:00 清零**），本方案实测含索引约 2,500~3,100 行/天（典型）、最坏 9,610 行/天（9.6%），比 R2 更宽裕。
- 「更新识别会不会造成回路」单列了一套 `audit_loop.mjs` 验证：**请求放大 20 倍，上游回源只放大 1.04 倍**（详见 README §6f）。

---

## 步骤 1：生成内部密钥（一次性）

```bash
node -e "console.log(require('crypto').randomBytes(32).toString('hex'))"
```

记下这串值。它是 chd-snap Worker 调 `/api/pile` 时证明「我是自己人」的钥匙，步骤 4 和步骤 5 都用它。

---

## 步骤 2：建 D1 数据库（不需要支付方式）

```bash
npx wrangler d1 create chd-snap
# 输出 database_id，填进 wrangler.toml 的 [[d1_databases]]

# 建表（kv + locks + slice 索引）
npx wrangler d1 execute chd-snap --remote --file=migrations/0001_init.sql
```

> ⚠️ **顺序不能反**：先建库 → 建表 → 再 deploy Worker。migration 和代码分开执行，
> 否则绑定名/表名对不上，全站瞬间 500（见 README 红线第 13 条）。
>
> 🔴 `idx_locks_slice` 索引是硬要求：锁表一天 3600 行，`purgeLocks` 的
> `DELETE ... WHERE slice < ?` 没索引就全表扫描，行读额度爆掉。

---

## 步骤 3：拿到 account_id（仅第一次部署需要）

```bash
npx wrangler whoami
```

输出的 `account_id` 填进 `wrangler.toml` 的 `account_id = "..."`。

---

## 步骤 4：部署 chd-snap Worker

```bash
cd campus-pile-kit/snapshot-worker

# 4a. 配内部密钥（粘步骤 1 那串值）
npx wrangler secret put SNAP_KEY

# 4b. 部署
npx wrangler deploy

# 4c. 另开终端看日志
npx wrangler tail
```

> ⚠️ 需要 Cloudflare API token 或已登录的 wrangler。没登录先 `npx wrangler login`。
> 登录卡在浏览器回调时，先 `unset HTTP_PROXY HTTPS_PROXY` 再登。

---

## 步骤 5：给站点 Pages 项目配同一个密钥

```bash
npx wrangler pages secret put SNAP_KEY --project-name chd-charge
```

**粘步骤 1 的同一串值**。两边不一致的话，chd-snap 调 `/api/pile` 会被当外站拒掉（403）。

> ⚠️ 这是改线上配置，按项目规矩：先部署到 preview 环境验证，确认无误再上 production。

---

## 步骤 6：验证（部署后第一条命令跑这个）

```bash
BASE=https://chd-snap.<你的子域>.workers.dev
node tools/verify_snapshot_lock.mjs "$BASE" --wait
```

验的是**整套方案的地基**：D1 的 `INSERT ON CONFLICT DO NOTHING` 是不是真锁。
判据：同一分区并发 5 个 `refresh=1`，只能有 **1 个** `refreshed: true`。

**这一条不能跳。** 万一 migrations 没跑、或 `locks` 表漏了主键约束，`ON CONFLICT`
不触发，锁就永远抢成功、并发全放行、上游被打爆，全程不报错。

---

## 步骤 6b：盯 cron 有没有真的跑完（部署后 1 小时内必看）

CF 的 Cron Triggers **不重试、不告警**，而免费版每次 cron 只有 **10 毫秒 CPU**
（付费版才是 30 秒）。所以「定时任务跑没跑完」必须自己看：

```bash
# 1) 看最近 100 次调用的 outcome
npx wrangler tail --format json      # 或直接看 Dashboard → Settings → Trigger Events
# 🔴 出现 exceededCpu = 这条 cron 没跑完且不会被重试 → 只能升付费或把一轮拆小

# 2) 看有没有「该刷没刷上」
curl -s "$BASE/api/health?fresh=1" | jq '.areas[] | {key, age, interval, overdue}'
# overdue=true 说明这一区已经超龄，补跑机制会介入；若持续 true 就是上面步骤 1 的问题
```

> 另外两条硬约束提前知道：**每个账号免费版只有 5 条 cron**，本方案 4 条分区 +
> 1 条统计正好用完，以后再要加别的定时 Worker 就会部署失败。主站 Worker 没有
> `scheduled` handler，不占名额。详见 README §6g。

---

## 步骤 7：手工核对接口

```bash
curl -s "$BASE/api/health?fresh=1" | jq
# 期望 config.d1_bound=true, snap_key_set=true, cron_disabled=false

curl -s "$BASE/api/snap?area=beimen&refresh=1" | jq '{age,throttled,refreshing,refreshed,rate_limited,blocked_by}'
# 连打两次：第一次可能 refreshed=true，第二次一定 throttled=true（120 秒节流）

# 核对 D1 里的数据（应恒 5 行业务数据 + 锁行有界）
npx wrangler d1 execute chd-snap --remote --command="SELECT key FROM kv ORDER BY key"
npx wrangler d1 execute chd-snap --remote --command="SELECT COUNT(*) FROM locks"
# locks 行数应 < 50（purgeLocks 每小时清一次）
```

---

## 完成后的状态

| 项 | 状态 |
|---|---|
| 4 个分区快照 | 每 5 分钟（高峰）/ 更长（低谷）刷新一次 |
| 统计对象 | 每小时 :05 采一个点，7 天封顶 168 个 |
| 锁表 | 每小时 `purgeLocks` 清一次，恒有界 |
| 页面 | **还没接**，仍是直连 `/api/pile` 的旧逻辑 |

前端接入是第 ⑥ 阶段，单独进行，先并存跑两周再切正式。

---

## 回退 / 清理

```bash
npx wrangler delete chd-snap          # 停调度
npx wrangler d1 delete chd-snap       # 彻底清库（确认不再用）
```

前端还没接 `/api/snap` 之前，删掉它对线上零影响。

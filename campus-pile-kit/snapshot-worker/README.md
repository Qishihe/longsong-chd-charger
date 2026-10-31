# 快照站（snapshot-worker）

把「页面每次打开都去打上游」换成「定时任务维护一份快照，页面读快照」。

这份目录只做**调度 + 存储**：扫桩仍然走站点现有的 `/api/pile`，所以
**凭证只有一份、限流只有一套**。它自己不持有 token。

> 数据形状：4 个分区快照 + 1 个统计对象 = **固定 5 个 key**，整年也只占 20 KB。
> 锁对象按时间片生成，靠 `lock/` 前缀的 lifecycle 自动清。

---

## 0. 前置：在站点 Worker 上加一条内部通道（3 行）

站点 Worker 从 v2.25 起要求同源（挡住「拿端点当免费代理刷平台」）。
服务器到服务器没有 Origin，而 Workers 的 fetch 里 Origin / Referer 属于
受限头，设了也可能被剥掉 —— 所以走显式密钥。

`campus-pile-kit/dist-cloudflare/_worker.js` 第 227 行，把：

```js
  if (!sameSiteRequest(request, url)) return json({ ok: false, error: 'bad_origin' }, 403);
```

改成：

```js
  /* 内部调度器（chd-snap Worker）：带对了密钥就放行。没设 SNAP_KEY 时这段等于不存在。 */
  const snapKey = request.headers.get('x-snap-key') || '';
  const internal = !!(env.SNAP_KEY && snapKey && snapKey === env.SNAP_KEY);
  if (!internal && !sameSiteRequest(request, url)) return json({ ok: false, error: 'bad_origin' }, 403);
```

然后给 Pages 项目加同名密钥（值自己生成一串 32 位随机）：

```bash
npx wrangler pages secret put SNAP_KEY --project-name chd-charge
```

⚠️ 这一步要按项目规矩走：**先 preview 验证，再动 index**，并留快照。

---

## 1. 建库（D1，不需要支付方式）

🔴 **为什么是 D1 不是 R2**：R2 是 Cloudflare 唯一要求绑支付方式才能激活的存储，
而 D1 免费计划直接开、不需要卡。并且 D1 是 SQLite **强一致**数据库，锁的
原子性由 `INSERT ON CONFLICT DO NOTHING` 保证 —— 把 R2 方案里唯一那个
「原子锁只能部署后验证」的赌局直接关掉。详见 §9。

```bash
npx wrangler d1 create chd-snap
# 输出 database_id，填进 wrangler.toml 的 [[d1_databases]]

# 建表（两条表 + 一条索引，见 migrations/0001_init.sql）
npx wrangler d1 execute chd-snap --remote --file=migrations/0001_init.sql
```

两张表：
- `kv`：快照 + 统计，`key` 是主键，覆盖写 = UPSERT，行数恒定（4 快照 + 1 统计 = 5 行）
- `locks`：时间片锁，`(key)` 主键 + `slice` 索引，供 `purgeLocks` 批量清过期锁

🔴 **`idx_locks_slice` 索引是硬要求**，不是优化：锁表一天长 3600 行，`purgeLocks`
的 `DELETE ... WHERE slice < ?` 若没有索引，每次清理都全表扫描，行读额度直接爆。


---

## 2. 填配置

`wrangler.toml` 里改 `account_id`（`npx wrangler whoami` 能看到），
把 `database_id` 填成第 1 步 `d1 create` 输出的 id。

`PILE_ORIGIN` 默认 `https://chd-charge.pages.dev`，如果站点迁到自定义域，
这里和 `worker.mjs` 的 `ALLOWED_ORIGINS` 两处都要改（🔴 换域名必查）。

---

## 3. 部署

```bash
cd campus-pile-kit/snapshot-worker
npx wrangler secret put SNAP_KEY     # 粘贴第 0 步那串随机值
npx wrangler deploy
npx wrangler tail                    # 另开一个窗口看日志
```

部署完 cron 不会立刻对齐，CF 侧最长可能延迟十几分钟才生效，属正常。

---

## 4. 验收

⚠️ **`refresh` 的默认值变了**：现在必须显式传 `refresh=1` 才会尝试补刷。
不带参数 = 纯读。原因是以前默认补刷，任何人不带参数 curl 一下、爬虫抓一次、
甚至健康检查，都会触发一轮真实的上游扫描。

**第一条命令跑这个**（它会把下面那些 curl 全做一遍，并验一件本地测不了的事）：

```bash
BASE=https://chd-snap.<你的子域>.workers.dev
node tools/verify_snapshot_lock.mjs "$BASE" --wait
```

它验的是：**D1 的 `INSERT ON CONFLICT DO NOTHING` 到底是不是真锁**。整套方案的
并发安全只依赖这一条假设。D1 是强一致 SQLite，这条是数据库的基本保证，不像
R2 的最终一致要赌；但万一 migrations 没跑、或 `locks` 表漏了主键约束，
`ON CONFLICT` 不会触发，锁就永远抢成功、并发全放行、上游被打爆，而且
**全程不报错**。所以这一步不能跳过。

判据：同一分区并发 5 个 `refresh=1`，只能有 1 个 `refreshed: true`。

手工核对：

```bash
curl -s "$BASE/api/health?fresh=1" | jq
# 期望：4 个区都出现，err=null；config 三项 d1_bound / snap_key_set / pile_origin 全部符合预期
# 顺带看 write_guard：enabled 必须是 true，blocked 只会在被打过尖峰时才增长
# （health 默认缓存 60 秒，要立刻看最新值就加 ?fresh=1）

curl -s "$BASE/api/snap?area=beimen&refresh=0" | jq '.snapshot | {piles,total,free,used_pct,valid,error}'
# 期望：piles=37, total≈148, used_pct 在 0–100, valid=true

curl -s "$BASE/api/snap?area=beimen&refresh=1" | jq '{age,throttled,refreshing,refreshed,rate_limited,blocked_by,config_error}'
# 连打两次：第一次可能 refreshed=true，第二次一定 throttled=true（120 秒节流）
# 若第二次落在同一时间片里又被判重复，会看到 rate_limited=true —— 这是好事，不是故障
# blocked_by=inflight 表示上一轮还没跑完（正常，几秒后就好）
# config_error=snap_key_missing 说明这一处部署漏了 SNAP_KEY —— 别去重抓凭证

curl -s "$BASE/api/snap?area=all&refresh=1" | jq '{refresh_ignored,oldest_key}'
# 期望：refresh_ignored="area=all_not_supported" + 给出 oldest_key
# 总览页要补刷就对 oldest_key 那个区单独发 refresh=1

curl -s "$BASE/api/stats" | jq '.points | length'
# 跑满一小时后应为 1，7 天后封顶 168
```

D1 里应该正好有 5 行业务数据（4 快照 + 1 统计）：

```bash
npx wrangler d1 execute chd-snap --remote --command="SELECT key FROM kv ORDER BY key"
npx wrangler d1 execute chd-snap --remote --command="SELECT COUNT(*) FROM locks"
# locks 的行数应保持有界（purgeLocks 每小时清一次，正常 < 50 行）
```

---

## 5. 本地自测（不需要账号，也不打上游）

```bash
node campus-pile-kit/snapshot-worker/selftest.mjs
```

177 条断言，覆盖的都是「写错了不报错、只会慢慢烂」的地方：

- 锁的原子性：5 个并发只有 1 个抢到
- **全站锁**：四个区同一时间片想刷，只放行一个（不然就是 109 台/分）
- **写入闸门**：同一秒 100 个并发只产生 3 次写（不是 3 + 99×2 次），跨片立刻恢复
- **跨片在飞**：上一轮还没跑完时零写入跳过；force 能插队（§6d）
- **配置一致性**：时段表必须是 5 的倍数；`wrangler.toml` 的 5 条 cron 直接读文件比对，统计那条不许落在分区的那一分钟
- **缺 `SNAP_KEY`**：cron 干脆不跑，绝不留下一个假的 6 小时 auth 退避
- 120 秒节流：够新就不打上游
- **够新就跳过**：cron 也不许在 120 秒内重扫同一区（跨时间片边界时靠这条拦住）
- 抢不到锁：返回 `refreshing` 而不是排队
- 上游全挂：保留旧数据、`at` 不变、`error.code` 区分 `auth` / `upstream`
- **auth 退避阶梯**：10 分钟 → 10 分钟 → 6 小时，别把临时限流当成凭证过期
- **partial 不累加**：一半台失败时只退 5 分钟，别让保护一半数据变成全停
- **busy 不算平台故障**：被自己人的回源预算挤掉时只等 60 秒
- **force 逃生门**：必须持内部密钥，且能绕过锁 / 节流 / 退避（运维要立刻看到结果）
- **DISABLE_CRON**：多部署互斥开关
- 统计：超龄记 `null`，同一小时不重复落点，滚动只留 168，深夜不因阈值写死而断线
- 分区表：每区 ≤ 40 台（`/api/pile` 单批上限），总和 = 109

改了设备清单之后必须重新生成分区表，否则新桩永远不会被刷：

```bash
python tools/gen_snapshot_partitions.py           # 重新生成 partitions.mjs
python tools/gen_snapshot_partitions.py --check   # 只校验（适合进守门脚本）
```

---

## 5b. 崩溃审计（改动后必跑）

额度审计问的是「花得太多吗」，这个问的是「会不会直接挂」。

```bash
node campus-pile-kit/snapshot-worker/audit_crash.mjs
```

做法：把真实的 `core.mjs` / `worker.mjs` 接上「会坏」的 R2 和上游 ——
读抛异常、写抛异常、永不 resolve、返回 null / 字符串 / 错误形状、对象被写坏，
然后观察两件事：

1. cron 抛不抛异常（抛了 = 这一轮彻底没有记录，连「失败」都留不下）
2. `/api/snap` 返回 200 还是 500（500 = 用户连旧数据都看不到）

当前 **33 条全过**。这一轮查出并修掉的问题：

| 问题 | 现象 | 修法 |
|---|---|---|
| **读路径被写路径带崩** | R2 读失败 / 抢锁失败 / 快照写失败 → 整个 `/api/snap` 500，而上一份快照明明还能用 | `snapFor` 自己兜住所有 I/O 异常，降级返回旧快照 + `ok:false` |
| **`Promise.all` 放大故障** | `?area=all` 时四个区里一个读失败 → 另外三个的完好数据也一起丢 | 全部改 `allSettled`，逐区标 `degraded` |
| **cron 静默消失** | 任何未捕获异常 → 这次触发没有任何日志、没有快照，面板只显示「失败一次」 | `scheduled` 与 `fetch` 各加一层兜底，错误必进 `console.error` |
| **没有超时** | R2 或站点接口挂住 → 一直等到 30 秒 wall-clock 被掐，用户转圈 30 秒后白屏 | `withTimeout`（R2 2 秒 / 扫描 18 秒）+ `AbortSignal.timeout` |
| **上游原文进公开响应** | `error.sample` 把 `/api/pile` 的报错原样带出，实测暴露了 `JWT token is missing; trace=abc123` | 改成只存归类码 `kinds`，原文只进 Worker 日志 |
| **上游原文进 Worker 日志** | 快照已只存归类码，但 `console.warn` 的「样例」还把 `rec.error` 原文打进日志 —— trace id / 内部地址 / token 提示留了副本 | 日志也只打 `kinds`；`makeScanBatch` 抛错时不拼上游原文 |
| **首轮全失败写空快照** | 首次部署正好上游挂了 → 写 `piles=0`，页面显示「本校共 0 台充电桩」 | 快照加 `valid` 字段，全失败时为 `false` |
| **`oldest_age` 伪造 0** | 所有区都没数据时 `?? 0` 让它变成「0 秒前刚更新」，与事实相反 | 改为 `null` |

### 前端必须遵守的六条硬规则

这几条不是建议，写错了会直接把上面所有的修复全部作废：

1. **首屏用 `refresh=0`**，先把快照渲染出来，再异步发 `refresh=1` 去补刷。
   反过来的话，首屏最坏要等 18 秒（扫描超时时间），方案的意义就没了。
2. **判断数据能不能用，看 `snapshot.valid`，不要只看 `piles`。**
   `piles === 0 && valid === false` 意味着「这一轮没取到」，不是「没有桩」。
3. **`ok === false` 时不要清空界面。** 它表示「暂时取不到」（R2 抖动、
   降级），不是「没有数据」。保留上一次渲染 + 顶部提示条才对。
4. **`rate_limited === true` 时不要重拉。** 它和 `refreshing` 是两件事：
   前者是「这一片已经试过，直接给了你旧数据」，重拉还是同一片还是被挡；
   后者才是「别人在刷，3 秒后再来」。混在一起会把请求量放大三倍，
   正好把写入闸门省下来的额度还回去（见 §6c）。
5. **显示「x 分钟前」时，年龄要加 `Age` 响应头。**
   `realAge = snapshot.age + Number(response.headers.get('Age') || 0)`。
   因为响应带 `max-age=60`，命中缓存时前端拿到的是最多 60 秒前的副本，
   而里面的 `age` 是**生成那一刻**的值 —— 直接用它会把「快过期」显示成「刚刚更新」。
   Worker 已经用 `access-control-expose-headers: Age` 暴露了这个头，
   不这么算就永远差那最多 60 秒。
6. **`?area=all` 不支持补刷。** 四个区串行最坏 72 秒，超过 Workers 的 30 秒
   wall-clock。传了 `refresh=1` 会收到 `refresh_ignored: 'area=all_not_supported'`
   和 `oldest_key` —— 要补刷就对 `oldest_key` 那个区单独发一次 `refresh=1`，
   下次打开再轮到另一个区，四个区就轮流被推进。

### 一个字段语义要提前说清

`/api/snap` 在降级时返回 **HTTP 200 但 `ok: false`**。
这是故意的：5xx 会让很多前端代码直接抛异常，把已经渲染好的界面换成白屏 ——
而数据取不到的时候，最不该做的就是连上一次的界面也一起丢掉。

---

## 6. 额度审计（改动后必跑）

```bash
node campus-pile-kit/snapshot-worker/audit_quota.mjs            # 全部 9 个场景
node campus-pile-kit/snapshot-worker/audit_quota.mjs a3         # 只跑一个
```

它 import 真正的 `core.mjs` / `worker.mjs`，喂假存储和假上游，按 `wrangler.toml`
那 5 条 cron 逐秒推进 24 小时，把每一次读 / 写 / 上游请求都计下来。

> ⚠️ 这套 audit_quota 的计费口径是 **R2 的「次」**（Class A/Class B）。换成 D1
> 后计费单位变成**「行」**，所以额度结论要改看 `audit_d1.mjs` 的第 7 节。
> 但「上游台/天」「峰值台/分」这两列**与存储无关**，结论不变。

**D1 的额度口径（2026-10-27 核对官方 Pricing）**：

| | Workers Free | Workers Paid |
|---|---|---|
| 行读 | **500 万 / 天** | 250 亿 / 月 included，超出 $0.001/百万 |
| 行写 | **10 万 / 天** | 5,000 万 / 月 included，超出 $1.00/百万 |
| 存储 | 5 GB（总量） | 5 GB included，超出 $0.75/GB·月 |

🔴 **免费额度按「天」重置（UTC 00:00 清零），不是按月**。付费版才是月额度。
撞到日限额后**没有 grace period、没有部分降级 —— 对该库的查询直接返回错误**，
直到 UTC 零点。所以真正要盯的是「单日峰值」而不是「月均」。

**行写要按「表 + 索引」双计**（官方原话：*Indexes will add an additional written
row when writes include the indexed column, as there are two rows written: one to
the table itself, and one to the index.*）。`locks` 有 `idx_locks_slice` 且锁行必然
写 `slice` 列，`kv` 的 `TEXT PRIMARY KEY` 有隐式唯一索引 —— 所以每个逻辑行
真实记账 **×2**。第一版估算漏了这一半，已修正。

| 场景 | 逻辑行/天 | 含索引行/天 | 占免费额度 |
|---|---|---|---|
| **真实典型**（没人访问，只有 cron 408 轮/天） | ~1,248 | **~2,496** | 2.5% |
| **典型 + 日 1000 访问**（约 100 次真补刷） | ~1,548 | **~3,096** | 3.1% |
| **设计最坏**（全天每片每区刷满，24h 不停有人） | 4,805 | **~9,610** | 9.6% |

四条判读：

1. **存储永远不会爆**：`kv` 表恒 5 行（快照 4 + 统计 1），`locks` 表靠
   `purgeLocks` 每小时清一次，恒有界（正常 < 50 行）。总占用 < 100 KB，5 GB 用不到万分之一。
2. **行写即使按最坏上界也只到 9.6%，日常约 3%**，比 R2 的 2.8%~6.9% 更宽裕。
   而且**抢锁失败零计费**：R2 的 412 也算一次 Class A 写，D1 的
   `INSERT ... ON CONFLICT DO NOTHING` 撞锁时 `changes=0`、一行没落盘，
   「一天 4000 次失败抢锁 → 追加 0 行写」。并发尖峰天然免费，这是 D1 相对 R2 的实质优势。
3. **唯一会累积的是锁行**：设计最坏 3600 行/天。R2 靠 `lock/` lifecycle 删，D1 靠
   `purgeLocks` 删（统计 cron 每小时顺带清，成本 1 条 DELETE）。**两者都不能省**，
   否则锁表一个月堆到 10.8 万行，inflight 检查的 SELECT 从点查变扫表，行读爆炸。
4. **上游压力才是真风险，不是 CF 额度**。审计把「四区叠加」实测成了一个具体数字：
   修复前峰值 **109 台/分**（正是历史事故量级），现在是 **73 台/分**。

> ⚠️ 一个必须记住的对比：**按需补刷并不总是比定时全量更省。**
> 定时全量 10 分钟 = 15,696 台/天。日访问 100 次时按需是 14,341（省 9%），
> 但日访问 1000 次时是 22,593（**多 44%**）。临界点大约在**日 250 次访问**。
> 原因是补刷粒度是「一整个区」（约 27 台），一次访问就要打 27 台。
> 想在高访问量下继续省，得把补刷粒度降到「用户当前筛选的那几条街」。

---

## 6b. 速率与风控审计（改动后必跑）

额度审计问「花得太多吗」，崩溃审计问「会不会挂」，这一套问的是**「会不会因为打得太密、太集中，被上游屏蔽」**：

```bash
node campus-pile-kit/snapshot-worker/audit_rate.mjs        # 全部 8 个场景
node campus-pile-kit/snapshot-worker/audit_rate.mjs s6     # 只跑一个
```

它记录每一次上游请求的**毫秒级时间戳**，用三个口径衡量：

| 口径 | 含义 | 基准线 |
|---|---|---|
| **60 秒峰值** | 任意一分钟最多打多少台 | 109 台/分（历史事故线，表现是整片 TCP 超时） |
| **1 秒并发** | 同一秒发出几个请求 | 20 个（实测 30 并发就有 1/3 超时） |
| **节流内重复** | 同一台桩在 120 秒内被请求第二次 | 应为 0 |

**2026-10-27 实测结论**：

| 场景 | 60 秒峰值 | 1 秒并发 | 节流内重复 | 判定 |
|---|---|---|---|---|
| S1 只有 cron，没人访问 | 37 | 1 | 0 | OK |
| S2 有人访问（每小时 20 次） | 73 | 2 | 0 | OK |
| S3 高峰 4 人同时打开 4 个区 | 73 | 2 | 0 | OK |
| S4 cron 传播延迟 90 秒 | 37 | 1 | 0 | OK |
| S5 上游一半的台失败 | 73 | 2 | 0 | OK |
| S6 上游整天 403 | 73 | 2 | 0 | 停摆属预期 |
| **S7 同一份代码部署两处** | **109** | 3 | **8,720** | 🔴 见下面红线 |
| S8 403 持续 3 分钟后恢复 | 73 | 2 | 0 | 恢复用时 8 分钟 |

三个结论：

1. **正常运行时离事故线有 33% 余量**（73 / 109），而且这个 73 只在「补刷正好撞上 cron」的时刻出现。
2. **cron 传播延迟不会造成撞车**。CF 的 cron 可能有几十秒延迟，但 `shouldRunAt()` 是拿**当前分钟**重算的，所以延迟只会让某一跳**跳过**（少刷一轮），不会让两个区同时跑。S4 实测峰值仍是 37。
3. **S7 是唯一能到 109 的路径**：同一份代码部署两处、两边 cron 都开着，锁在各自桶里互相看不见。**全程不报任何错**。

### 🔴 部署红线：第二处必须设 `DISABLE_CRON=1`

```toml
# 灰度 / 测试部署的 wrangler.toml
[vars]
DISABLE_CRON = "1"
```

比「记得删掉 crons 配置」可靠：忘删是静默事故（你不知道它在打），忘设这个开关只是那一处不刷新，`/api/health` 里 `config.cron_disabled` 一眼能看出来。

### 这轮修掉的三个真问题

| 问题 | 原来会怎样 | 现在 |
|---|---|---|
| **cron 不看快照年龄，只检查锁** | 用户在第 4 分钟补刷过、第 5 分钟 cron 落到新时间片 → 60 秒内重扫同一区。实测一天 540 台次纯浪费 | `refreshArea` 里加「够新就跳过」（`skipped: 'fresh'`），cron 也尊重节流门槛 |
| **403 被一步退到 6 小时** | `/api/pile` 把 401/403 都标成 auth，而平台限流也常回 403。一次几分钟的限流 → 整站停更半天（实测 97% 时间全超龄） | 阶梯退避：10 分钟 → 10 分钟 → 6 小时。S8 实测临时限流 3 分钟只停 8 分钟 |
| **partial 累加 failStreak** | 「一半的台失败」是常见抖动，但数据仍然可用；累加到 60 分钟退避后实测 85% 时间四区全超龄 | partial 不累加，固定 5 分钟重试。S5 从 85% 停摆降到 1% |

另外单独处理了 `busy`：`/api/pile` 的 240 台/分预算被自己人用完后会返回 `throttled`，这是**我们自己的并发上限**，60 秒就重置 —— 当成平台故障退 5 分钟是错的，因为用户最多的时候恰好最不该停更。

### ⚠️ 一条既有风险（不属于本方案，但建议改）

`_worker.js` 里 `PILE_FRESH_BUDGET = 240 台/分钟`，而事故线是 **109 台/分**。也就是说现有站点本身允许的回源速率是事故线的 2.2 倍。平时没人能触发（一轮全量才 109），但**3 个人同时点手动刷新就能到 240**。

建议降到 **120**（仍留 10% 余量）。这是改线上文件，不在本轮范围内，先记在这里。

反过来看：我们这个快照 Worker 每分钟只占 `37 台 / 240` 的预算（约 15%），不会把用户的手动刷挤掉。

---

## 6c. 写入闸门（防并发风暴把存储打穿）

前面几节都在算「怎么少打上游」，这一节补上另一半：**怎么少打存储**。

> ⚠️ 换 D1 后，「抢锁失败也计费」这个 R2 独有的坑消失了：D1 的
> `ON CONFLICT DO NOTHING` 撞锁时 `meta.changes=0`，**不产生行写**。所以写入闸门
> 在 D1 下省的不是「写额度」（那个本来就不花），而是**并发风暴下每请求一次的
> D1 round-trip + INSERT 尝试**。它仍然值得保留：一次 100 个并发的尖峰，闸门
> 把它从「100 次 INSERT 尝试」压成「1 次尝试 + 99 次本地拒绝」，省 99 次网络往返。
>
> 如果以后切回 R2，这个闸门立刻恢复「省 412 写额度」的价值 —— 所以**别删**。

```
node audit_quota.mjs c2        # 只跑尖峰场景
```

实测（同一秒 200 个请求，4 个区都超龄）：

| | 写入 | 真刷 | 上游 |
|---|---|---|---|
| 无闸门 | **202 次/秒** | 1 | 36 台 |
| 有闸门 | **6 次/秒** | 1 | 36 台 |

写入少 **97%**，上游量**完全不变** —— 闸门砍掉的都是注定失败的抢锁尝试。

### 它怎么工作

`core.mjs` 的 `WriteGuard`，只做一件事：**同一时间片（120 秒）+ 同一分区 + 同一用途，只放行一次**。

- 位置在 `refreshArea` 的**第一行**，在任何一个 `put` 之前。放到抢锁之后就等于没放。
- 判断依据是 `lock/<area>/<slice>` 本身就保证「一片一区最多一轮」，第 2 次必然 412 ——
  所以它不限制任何**有效**刷新，只砍掉确定会失败的写入。
- 状态在 isolate 内存里，跨 isolate 不共享。这是刻意的：R2 没有便宜的原子自增原语，
  为了一个近似计数多读写一次存储，比它省下来的还贵。跨 isolate 的上界是
  `片数 × 用途数 × isolate 数`，量级远低于额度。

### 它带来一个新状态：`rate_limited`

`/api/snap` 的响应多了一个布尔字段，前端**必须**和 `refreshing` 区分开：

| 字段 | 含义 | 前端该做什么 |
|---|---|---|
| `refreshing: true` | 别人正在刷（锁被占） | 3 秒后重拉 |
| `rate_limited: true` | 本片本区已经试过一轮，这次直接给旧数据 | **别重拉**，`throttled` 也是 true，照旧数据展示 |

两个字段互斥。如果前端把 `rate_limited` 当 `refreshing` 处理，会 3 秒重拉一次、
而重拉还是同一片还是被挡 —— 等于把请求量放大三倍，正好把闸门白省下的量还回去。

### 红线：不许关，也别给 cron 加

- **`WRITE_GUARD_ENABLED` 只能为排障临时关**，关掉之后写入量不再有上界（审计里 202 次/秒）。
- **cron 不过闸门**，这是想清楚的决定：cron 一天才约 288 轮，替它省一次 412 顶多
  288 次写/天，代价却是「万一被判成重复，这一跳静默不刷」—— 数据白晚 5 分钟。
  崩溃审计里试过给 cron 开闸门，同一时间片连跑几个场景后快照不再落盘，7 条断言直接变红。

---

## 6d. 时序审计：锁是按片切的，扫描是跨片跑的

前几节的 mock 扫描器都是「调用即返回」，于是所有并发都在同一个瞬间结束 ——
恰好绕开了这套方案最脆弱的一处。**时间不会等你扫完。**

```bash
node campus-pile-kit/snapshot-worker/audit_overlap.mjs   # 10 条断言，全部用「可控释放」的假扫描器摆出来
```

### 修复前实测

| 场景 | 结果 |
|---|---|
| 一轮从本片最后一秒开始，跑到下一片 | 第 2 个请求抢到**另一个锁**，**2 轮同时扫同一批桩** |
| 三个请求跨三片 | **3 轮并发**（上游瞬时 3 倍） |
| 第 2 个请求的响应 | `refreshed/throttled/refreshing` **全是 false** —— 前端完全不知道发生了什么 |

片宽 120 秒、一轮扫描 5–18 秒，所以「压线起跑」的概率是 **18/120 = 15%**，
而且它不报错。

### 修法：`INFLIGHT_S`

抢锁之前先读**上一个时间片**的锁对象 —— 锁里存的内容本来就是那一轮的起始时间戳，
所以不新增任何写入，只多一次读：

```
上一片锁存在 && 现在 - 它的时间戳 < INFLIGHT_S(25s)  →  reason:'inflight'，跳过
```

`force`（运维持密钥）用 `ignoreFreshness` 绕过，因为它必须能插队。

`blocked_by: 'inflight'` 的语义是**「等别人刷完」**，所以 `refreshing: true` ——
前端 3 秒后重拉，那时候那份数据正好落地。这和 `rate_limited`（别重拉）相反。

### 顺带修掉的：检查顺序

原来「抢锁 → 读快照 → 判断退避/够新」，所以**每一次跳过都要先写两把锁**。
现在的顺序是：

```
写闸门 → 读快照（纯读）→ 退避短路 → 够新短路 → 在飞判断 → 抢锁 → 扫描
```

两种最常见的跳过（退避、够新）现在发生在任何一次写之前。
`audit_quota` 里 A1 的抢锁冲突从 4 降到 2，Class B 增加约 500 次/天（0.36% 额度）。

### 代价

Class B（读）每天多约 500 次 —— 因为每次尝试都要多读一次上片的锁。
读额度是写额度的 10 倍，而且这条读挡掉的是**上游 2–3 倍**的放大，非常划算。

---

## 6e. D1 专项审计（换存储后必跑）

R2 的四套审计覆盖的是「逻辑」层，D1 和 R2 共用同一套 `core.mjs`，所以那些
结论在 D1 下依然成立。但 D1 有几处 R2 没有的坑，必须单独验：

```bash
node campus-pile-kit/snapshot-worker/audit_d1.mjs   # 22 条断言
```

| 验证点 | D1 特有的坑 |
|---|---|
| 锁原子性 | `INSERT ON CONFLICT DO NOTHING` 的 `meta.changes` 是否等价 R2 的 412 |
| 锁清理 | `purgeLocks` 能否把锁表压回有界（R2 靠 lifecycle，D1 靠 DELETE） |
| 行计费 | 锁表累积会不会把「点查」变「扫表」，行读额度爆炸 |
| 读路径降级 | D1 读失败是否和 R2 一样走 degraded 而非 500 |
| 覆盖写幂等 | UPSERT 是否等价 R2 覆盖写（快照/统计行数恒定） |
| 锁覆盖写被拒 | 锁 key 走普通覆盖写会拼出 `locks(updated_at)`（表里没这列）→ 必须 fail-fast |
| rows_read 口径 | D1 的 rows_read 是「扫描行数」非「返回行数」，miss 也计 1 读；行读上界 ≈6200/天（免费 500 万的 0.12%） |
| 索引双计 | 行写是「表 1 行 + 索引 1 行」，含索引的真实上界 9,610 行/天（免费日额度的 9.6%），典型 3,096/天（3.1%） |

用 `mock.mjs` 的 `createD1()` 内存 mock 对齐 D1 真实语义（`meta.changes` / UPSERT /
无 TTL），**不连真 D1**。真正要部署后验的只有「真实 D1 的 ON CONFLICT 是否跨
isolate 强一致」—— 但那是 SQLite 的基本保证，不像 R2 最终一致需要赌。

---

## 6f. 循环审计：「更新识别」会不会自我放大（改动后必跑）

```bash
node campus-pile-kit/snapshot-worker/audit_loop.mjs   # 23 条断言
```

额度审计问「花得太多吗」，崩溃审计问「会不会挂」，这一套问第三件事：
**会不会形成正反馈回路，越挤越忙、把自己喂死。**

真正的嫌疑点有三个，都验证过了：

| 嫌疑 | 机制 | 实测结论 |
|---|---|---|
| ① 全军覆没时 `at` 不前进 | 年龄永远超限，每个来的请求都觉得自己该补刷 | 退避顶住：**654 台/天**（无退避会是 72,000 台） |
| ② 只有快照写失败 | 锁成功了去扫了上游，产物没落盘 → `retryAfter` 丢失 → 下一片再来 | **有界**：被时间片锁压住，不会每请求回源 |
| ③ 前端轮询叠加 | AUTO_REFRESH_MS=10min 的轮询 × 大量常开页面 | 请求涨不影响回源：见下表 |

**决定性证据（第 5b 节）**：把访问量拉到 Workers 免费额度允许的上限
（日 2 万访问 = 4 万次请求，是正常日的 **20 倍**），结果是 ——

```
请求放大 20×  →  上游回源只放大 1.04×  →  行写仍是常数级
```

这一条是整个方案的定盘星：**回源轮数和写入量与访问量脱钩**，不会出现
「人多 → 写多 → 更卡 → 更多人重试」的雪崩。原因是三层阀门（见下）把
「每区每个 120 秒时间片」压成一个不可再分的原子单位：

```
请求进来 → ① 内存闸门（同片同区同用途只放行一次，cross-slice 无关）
         → ② 读快照（纯读，不写；够新 / 在退避期 → 直接返回，零写入）
         → ③ inflight 检查（上一轮还在跑就跳过，纯读）
         → ④ D1 时间片锁（INSERT ON CONFLICT；撞锁 = 零行写）
         → ⑤ 才轮到打上游
```

⚠️ **但有一个 D1 特有的刹车前提要记住**：退避状态 `retryAfter` 存在**快照里**，
靠「写成功」落盘。如果 D1 处在「锁能写、快照写不了」的半故障状态，这一轮
就是白扫。此时上限是每区每片一轮（≤ 2,880 轮/天）——有界、会顶满、且伴随
D1 报警，属于运维事件，不是失控回路。**别把它当作可以长期无视的状态。**

另外两条在本审计里确认的性质：

- **D1 整体不可用时是 fail-closed**：连锁都写不进去 → 上游一次都不打（0 台），
  同时读路径仍可用，用户照样看到旧快照。宁可不动，也不裸奔。
- **并发不放大写入**：同一秒 200 个请求挤同一个区 → 只放行 1 轮，
  行写 3（含索引 6）。这是 D1 「撞锁不产生行写」的直接红利。

---

## 6g. 定时任务怎么保证「跑完」（2026-10-27 修订）

### Cloudflare 侧的保证——先把话说死

查了一轮官方专题资料，Cron Triggers 的边界是这样的（2026-10 核实）：

| 项 | Workers Free | 说明 |
|---|---|---|
| 每条 account 的 cron 数 | **5** | 本方案 4 条分区 + 1 条统计 = **正好用完**，没有余量 |
| 每次 cron 的 CPU 时间 | **10 ms** | 🔴 付费版才是 30 秒。见下方「最大隐患」 |
| Wall time | 15 分钟 | 比配置的 30 秒宽得多，`IO_TIMEOUT_MS` 那套不等式是保守的 |
| 失败重试 | **没有** | 抛异常/超 CPU 就丢了，直到下一跳 |
| 失败告警 | **没有** | 只能看 Cron Events（保最近 100 条） |
| 投递精度 | 分钟内 | 保证在那一分钟投递，**不保证第 0 秒到** |

结论很直白：**平台只负责「到点叫你」，不负责「你跑完没有」。** 所以准确性
必须由代码侧自己兜。

### 代码侧已有的兜底

- **顶层 try/catch**：任何未捕获异常都要留下日志。历史那次「页面一直转」
  就是因为失败时连「这一轮失败了」都没记下来。
- **双部署互斥**（`DISABLE_CRON=1`）：同一个账号部署两处、cron 都开着，
  会静默地把峰值从 73 台/分顶回 109 台/分。
- **缺 `SNAP_KEY` 就不跑**：否则站点回 403 → 被记成 auth → 退避 6 小时，
  一个「部署漏步骤」会被伪装成「凭证过期」的假故障。
- **时间片锁 + 够新就跳过 + 退避**：重复投递不会重扫，失败不会连环重试。

### 两处新修的问题

1. **判定时刻用错（已修）**。原来用 `Date.now()`（实际醒来的时刻）去做
   `shouldRunAt` 的分钟取模。CF 只保证分钟内投递，一旦迟几秒跨过分钟边界，
   就会被判成「不该我跑」——**整跳静默跳过**。深夜 60 分钟档每区每小时只有
   一次机会，丢一次就是数据老化到 2 小时。
   现在改用 `event.scheduledTime`（排定的整分钟），投递延迟再大也不影响判定；
   延迟超过 5 秒另外记一条 WARN。

2. **丢跳没有追赶（已修）**。CF 不重试，丢了就是丢了。现在 cron 醒来若日历
   说不该跑，会先看一眼快照实际年龄：超过「本时段间隔 + 120 秒」就认定上一跳
   没跑成，这次补上。补跑那一轮**强制占全站锁**——故障恢复后四个区会同时超龄，
   不占锁就是四区同分钟一起补跑 = 109 台/分，正是历史事故那个量级。
   开关在 `CRON_CATCHUP_ENABLED`，判定是纯函数 `catchupNeeded()`，有单测钉着。

### 🔴 部署后必须盯的一件事

**免费版每次 cron 只有 10 毫秒 CPU。** 等待 `fetch()` / D1 的时间不计入 CPU，
但我们的 JS 计算是计入的：解 ~37 台的上游响应、`JSON.parse`、`JSON.stringify`
快照等等。结算后立即看 Cron Events：

> Workers & Pages → 选 Worker → Settings → Trigger Events → View events

如果 `outcome` 出现 **`exceededCpu`**，说明这条 cron 根本没跑完，而且不会重试、
不会告警——只能升级 Workers Paid（CPU 提到 30 秒/次），或者把一轮拆小。
这是「定时任务跑不完」最可能的真实形态。

### 外部探活

`/api/health` 每个分区现在除了 `age`，还带 `interval` 和 `overdue`：

```json
{ "key": "beimen", "at": 1761580000, "age": 3835, "interval": 3600, "overdue": true }
```

外部定时探活（Uptime Kuma / Cron Radar / 另一个云的免费探针）只要盯
`overdue == true` 就够了——它等价于「该刷没刷上」，覆盖了上面所有失败形态。
接口带 60 秒缓存，加 `?fresh=1` 取实时值。

---

## 7. 参数在哪改

全部集中在 `config.mjs`：

| 常量 | 现值 | 含义 |
|---|---|---|
| `THROTTLE_S` | 120 | 快照超过这个年龄，打开页面才允许补刷一次 |
| `LOCK_SLICE_S` | 120 | 时间片宽度，等于节流门槛时一区一片最多一轮 |
| `SNAP_CACHE_S` | 60 | `/api/snap` 的 `max-age` |
| `STALE_HARD_S` | 1800 | 超过它前端先给骨架屏 |
| `STATS_KEEP` | 168 | 统计保留 7 天 |
| `GLOBAL_LOCK_ENABLED` | true | 全站锁：一个时间片只放行一个区补刷 |
| `CRON_USES_GLOBAL_LOCK` | false | cron 是否也占全站锁（见下） |
| `BACKOFF_BASE_S` / `BACKOFF_MAX_S` | 300 / 3600 | 连续失败退避基数与上限 |
| `AUTH_BACKOFF_S` | 21600 | 连续 3 次 auth 失败后认定真过期，退 6 小时 |
| `AUTH_PROBE_BACKOFF_S` | 600 | 前两次 auth 失败只退这么久（区分「临时限流」和「真过期」） |
| `AUTH_CONFIRM_STREAK` | 3 | 连续几次 auth 失败才升级到 6 小时 |
| `BUSY_BACKOFF_S` | 60 | 被自己人的回源预算挤掉时，等这么久再试 |
| `IO_TIMEOUT_MS` | 2000 | R2 单次操作超时（超了降级返回旧快照） |
| `SCAN_TIMEOUT_MS` | 18000 | 站点扫描整体超时（超了判整区失败 + 退避） |
| `SCHEDULE` | 见文件 | 24 小时时段表（**只在没人访问时生效**） |
| `WRITE_GUARD_ENABLED` | true | 写入闸门总开关（**只许排障临时关**，见 §6c） |
| `WRITE_GUARD_PER_SLICE` | 1 | 同一片 + 同一区 + 同一用途最多放行几次 |
| `WRITE_GUARD_MAX_SLICES` | 32 | 内存里最多记多少片（64 分钟，防 isolate 长时间泄漏） |
| `WRITE_COST_PER_ATTEMPT` | 3 | 一次放行的写入成本，只用于 `/api/health` 的 `est_put` 估算 |
| `INFLIGHT_S` | 25 | 「上一轮还没跑完」的判定窗口（§6d）。**必须 > `SCAN_TIMEOUT_MS/1000`** |

🔴 十三条不要碰的线：

1. **`THROTTLE_S` 别低于 90。** 60 秒换算出来是 108 台/分，正好等于历史
   那次「整片 TCP 超时」的量级。120 秒是 54 台/分，留 2 倍余量。
2. **每区设备数别超 40。** 超了 `/api/pile` 会返 `too_many_ids`，这一区
   从此永远失败，而且页面只会显示「旧记录」。要拆区，不是改上限。
3. **锁的 key 别去掉时间片。** `lock/<area>/<slice>` 里的 slice 是「锁自动过期」
   的机制（片号一变，锁 key 就变，旧锁不再被读）。去掉它就变成「一把永不失效
   的锁」，第一轮之后全场停更。
4. **锁表必须靠 `purgeLocks` 清理（D1），或配 `lock/` lifecycle（R2）。**
   两者都不能省：锁一天长 3600 行，不清的话一个月 10.8 万行，inflight 检查的
   SELECT 从点查退化成扫表，行读额度爆炸。D1 下 `purgeLocks` 已挂在统计 cron 里
   每小时清一次；R2 下配 lifecycle 1 天。**主键（kv 表 / snap 前缀）绝不能清。**
5. **`SCAN_TIMEOUT_MS + IO_TIMEOUT_MS × 4` 必须 < 28000。** cron 的
   wall-clock 上限是 30 秒，超了会被运行时直接掐掉 —— 那样连「这一轮失败」
   都记不下来，日志里什么都没有。现在是 18 + 2×4 = 26 秒，只留 4 秒余量，
   所以**调大任何一个之前先算这个不等式**（`audit_crash.mjs` 的 J2 守着它）。
6. **同一时间只能有一处部署在跑 cron。** 第二处必须设 `DISABLE_CRON=1`。
   两边锁在各自桶里互相看不见，实测会回到 109 台/分（事故量级），
   而且**全程不报错**。详见 §6b。
7. **写入闸门只能为排障临时关。** 关掉之后同一秒 200 个请求会打出 202 次
   抢锁尝试（见 §6c）。D1 下撞锁虽不花行写，但每次尝试都是一次 D1 round-trip，
   尖峰会把并发风暴原样打到数据库。另外**别顺手给 cron 也加闸门**：省 288 次
   尝试/天，代价是把「跳过一跳」变成静默的，崩溃审计会直接红 7 条。
8. **`INFLIGHT_S` 必须大于 `SCAN_TIMEOUT_MS / 1000`，而且不许删这道检查。**
   锁按时间片切、扫描跨片跑 —— 删了它，「压线起跑」的 15% 概率会让同一个区
   被 2–3 轮同时扫（§6d），上游直接翻倍，且**不报错**。
9. **统计 cron 不能落在 :00–:03。** 那四分钟正好是四个分区在跑，而统计第一件
   事就是读它们的快照。撞车的话统计点里四个区来自两个不同时刻，
   曲线出现无规律锯齿，**不会报错**。现在是 :05，selftest 直接读 toml 比对。
10. **部署必须配 `SNAP_KEY`。** 没配的话站点 `/api/pile` 会回 403，而 403 在
   `refreshArea` 里被归类成 `auth` → 连续 3 次后写 6 小时退避 → 整站停更半天，
   日志还写着「凭证失效」，运维会去白抓一次凭证。代码里已经兜住（缺密钥时
   干脆不跑），但别依赖这层兜底。
11. **上游原文（`rec.error` / `data.error`）不许进任何日志。** 它可能带 trace id、
   内部地址、token 提示。快照里只存归类码已经做到了，日志这一环也堵死了
   （`console.warn` 只打 `kinds`，`makeScanBatch` 抛错不拼原文）。
   排障看 `kinds`（auth / timeout / throttled）足够；要原文去站点 Worker 自己的日志。
12. **退避分类必须优先信 `throttled` 布尔标志，而不是文案正则。** 站点预算耗尽时
   返回 `{ throttled: true, error: '刚才查询的人太多了…' }` —— 如果只靠正则去猜
   文案，站点一改措辞（比如「请稍后再试」）分类就静默失效，把 60 秒的限流
   当成 `upstream` 退避 5 分钟。`refreshArea` 已优先消费 `r.throttled`，
   文案正则只当兜底。
13. **migration 和代码要分两次部署。** D1 有 schema（R2 没有）。改表结构时
   先 `wrangler d1 execute --remote` 跑 migration、再 deploy 代码，**绝不能
   同一个 release 一起发**：否则绑定名/表名对不上，全站瞬间 500，而且 Workers
   全球秒级生效，回滚也是另一个全球部署。首次部署的顺序就是：先建库 → 建表 →
   再 deploy Worker（README 第 1~3 步就是这个顺序）。

### `CRON_USES_GLOBAL_LOCK` 这个开关在权衡什么

| 取值 | 峰值 | 用户补刷体验 |
|---|---|---|
| `false`（当前） | 73 台/分 = cron 37 + 补刷 36 | 随时能刷到，不用等 |
| `true` | 37 台/分 | 4 条 cron 覆盖了 5 分钟里的 0/1/2/3 四分钟，补刷大概率撞锁，最坏等 120 秒 |

默认取 `false`：73 台/分 = 1.2 台/秒，历史事故线是 109 台/分 = 1.8 台/秒，
留了 33% 余量。**如果平台风控变严，改成 `true` 就能立刻收紧，一行不用动。**

### 推完新凭证后怎么立刻恢复

凭证过期会进入 6 小时退避（重试毫无意义，只会持续骚扰平台）。推完新凭证后：

```bash
curl -s "$BASE/api/snap?area=chaohui&refresh=1&force=1" \
  -H "x-snap-key: <SNAP_KEY>" | jq '{refreshed,forced,age}'
# 四个区各打一次即可，期望 refreshed=true
```

`force=1` **必须带内部密钥**才生效，浏览器拿不到 —— 否则就是一个公开的
「绕过节流打爆上游」按钮。分区锁仍然生效，所以两次 force 之间要隔 120 秒。

---

## 回退

这个 Worker 不写站点任何东西，回退成本几乎为零：

```bash
npx wrangler delete chd-snap          # 停调度
npx wrangler d1 delete chd-snap       # 要彻底清（先确认不再用）
```

前端还没接 `/api/snap` 之前，删掉它**对线上零影响**。
接了之后回退顺序是：先把页面切回 `?piledirect=1` 的旧通路，再删 Worker。

---

## 9. 为什么选 D1 而不是 R2（存储选型定案）

2026-10-27 实测核实（含官方文档与真实限流数据，非凭记忆）：

| 维度 | R2 | D1 |
|---|---|---|
| 需要支付方式 | 🔴 **要绑卡**（唯一要求绑卡的 CF 服务） | ✅ 免费计划直接开 |
| 计费单位 | Class A/B「次」 | 「行」（读 500 万/天、写 10 万/天） |
| 锁原语 | `If-None-Match:*`（**最终一致**，需部署后验证） | `INSERT ON CONFLICT DO NOTHING`（**强一致**） |
| 锁清理 | lifecycle 规则 | SQL `DELETE`（`purgeLocks`） |
| 本方案写用量 | 2.8%~6.9% | **~4.8%** |
| 核心风险 | 原子锁只能部署后赌 | 锁表累积需显式清理（已解决） |

**换 D1 的决定性理由**：R2 需要绑支付方式（银联单标储蓄卡大概率被「card type
not accepted」拒掉），而 D1 不需要卡。且 D1 是强一致 SQLite，把「R2 原子锁只能
部署后验证」这个唯一赌局直接关掉。

**D1 引入的新代价**（已全部解决）：
1. 锁表会累积行 → `purgeLocks` 每小时清一次（`audit_d1.mjs` 第 5 节验证有界）。
2. 锁表必须加 `slice` 索引 → `migrations/0001_init.sql` 已建，否则 DELETE 扫表。
3. 有 schema/migration → 必须「先 migration 后部署」分离执行（见下一条红线）。

如果以后有了 Visa/Master 卡想切回 R2，`store-d1.mjs` 换成 R2 binding 即可，
`core.mjs` 一行不用改（两者暴露同形 get/put 接口）。

/**
 * D1 存储适配层：把 core.mjs 依赖的 R2 式 get/put 接口，翻译成 D1 的 SQL。
 *
 * 为什么需要这层：core.mjs 里所有存储调用只用到 3 个原语 ——
 *   get(key)                       → 返回 { text() } 或 null
 *   put(key, value)                → 覆盖写（快照 / 统计）
 *   put(key, value, { onlyIf })    → 原子锁（If-None-Match: * 的 D1 等价物）
 *
 * R2 的 `If-None-Match: *` 是「对象不存在才创建」，D1 没有这个概念，
 * 但 D1 有更强的东西：`INSERT ... ON CONFLICT DO NOTHING` 是**强一致**的
 * 原子操作（R2 只是最终一致）。这把「锁原子性只能部署后验证」这个
 * 唯一的赌局直接关掉 —— 这是换 D1 的核心收益，见 README「为什么选 D1」。
 *
 * 数据模型（两张表，见 migrations/0001_init.sql）：
 *   kv    —— 快照 + 统计。key 是主键，覆盖写 = UPSERT，行数恒定（4 快照 + 1 统计）。
 *   locks —— 时间片锁。主键 (area_key, slice)，值里存起始时间戳 ts，
 *            供 core.inflightRecently 读「上一轮还在飞吗」。
 *
 * 🔴 锁表必须定期清理（见 purgeLocks）：R2 靠 slice 号「旧 key 不再被读」自然
 *    失效，D1 没有这种隐式过期 —— 不清的话一天 3600 行、一个月 10.8 万行，
 *    会让 inflight 检查的 SELECT 从「点查」退化成「扫表」，行读额度爆炸。
 */

import { TUNING } from './config.mjs';
import { sliceOf } from './core.mjs';

/** key → 表。锁进 locks，其余进 kv。 */
function routeKey(key) {
  if (typeof key === 'string' && key.startsWith('lock/')) return 'locks';
  return 'kv';
}

/**
 * 把 D1 的异常归一化成一个带 r2=true 标记的错误，让 core.mjs 现有的
 * 降级路径（r2Error / degraded='r2_read_failed'）原样复用，不用改逻辑。
 *
 * 为什么叫 r2：core.mjs 里读失败会标 degraded='r2_read_failed'，写失败会
 * 记 r2Error。这里沿用同一个语义标记，D1 故障和 R2 故障对上层完全等价。
 */
function d1Error(what, cause) {
  const inner = String((cause && cause.message) || cause);
  const e = new Error('D1 ' + what + ' 失败：' + inner);
  e.r2 = true;
  e.cause = cause;
  return e;
}

/**
 * 一个 D1 binding（env.SNAP）配一个 store。所有方法都返回 core.mjs 期望的形状，
 * 所以 core.mjs 一行都不用改。
 *
 * @param {D1Database} d1   env.SNAP（D1 binding）
 * @param {object} opts     { tuning, now } —— 锁清理要用时间片
 */
export function createD1Store(d1, opts = {}) {
  const tuning = opts.tuning || TUNING;
  const now = opts.now || (() => Math.floor(Date.now() / 1000));

  async function get(key) {
    const table = routeKey(key);
    let row;
    try {
      row = await d1.prepare('SELECT value FROM ' + table + ' WHERE key = ?1').bind(key).first();
    } catch (err) {
      throw d1Error('get(' + key + ')', err);
    }
    if (!row) return null;
    const text = row.value;
    /* 返回和 R2 一样的 { text() } 形状，core.mjs 的 readJson 原样可用。 */
    return { text: async () => text };
  }

  /**
   * put 兼容 R2 的两种调用：
   *   put(key, value)                        → 覆盖写（UPSERT）
   *   put(key, value, { onlyIf: Headers })   → 原子锁（If-None-Match: * 的等价物）
   *
   * onlyIf 语义：R2 的 `If-None-Match: *` 表示「不存在才写」，冲突返回 null。
   * D1 里用 `INSERT ... ON CONFLICT(key) DO NOTHING`，靠 `meta.changes` 判断：
   *   changes === 1 → 抢到锁，返回 { key }（truthy）
   *   changes === 0 → 冲突（已存在），返回 null（等价 R2 的 412）
   */
  async function put(key, value, opts) {
    const val = String(value);

    /* 原子锁路径 */
    if (opts && opts.onlyIf) {
      const inm =
        typeof opts.onlyIf.get === 'function'
          ? opts.onlyIf.get('if-none-match')
          : opts.onlyIf['If-None-Match'];
      if (inm === '*') {
        try {
          const r = await d1
            .prepare(
              'INSERT INTO locks (key, value, slice, created_at) VALUES (?1, ?2, ?3, ?4) ' +
                'ON CONFLICT(key) DO NOTHING',
            )
            .bind(key, val, parseSlice(key, tuning), Math.floor(Date.now() / 1000))
            .run();
          /* changes=1 抢到，changes=0 撞锁（等价 R2 的 412 → null） */
          return r && r.meta && r.meta.changes === 1 ? { key } : null;
        } catch (err) {
          throw d1Error('put(lock ' + key + ')', err);
        }
      }
      /* 非 If-None-Match:* 的 onlyIf 我们不用，退化为普通写 */
    }

    /* 🔴 锁 key（lock/ 前缀）唯一的合法写入方式就是上面的 onlyIf 原子锁。
     *
     * 普通覆盖写只该落到 kv 表（快照 / 统计）。这里若拿到一个 lock/ 前缀的
     * 覆盖写，说明调用方用错了 —— 锁一旦被 UPSERT 覆盖，就失去「一片一区
     * 只跑一轮」的语义，会静默放行并发、打爆上游。
     *
     * 原来的实现用 routeKey(key) 动态选表，普通覆盖写会拼出
     * `INSERT INTO locks (key, value, updated_at)`，而 locks 表根本没有
     * updated_at 列（它是 slice + created_at）—— 真实 D1 上会直接 SQL 报错。
     * 内存 mock 不校验列名，所以六套测试全绿也测不出这个坑。这里改成：
     * 锁的覆盖写直接抛错（fail-fast，宁可红日志也不静默写坏），
     * 其余一律写 kv 表。 */
    if (typeof key === 'string' && key.startsWith('lock/')) {
      const e = new Error('D1 put 拒绝覆盖写锁对象 ' + key + '（锁必须走 onlyIf 原子锁）');
      e.r2 = true;
      throw e;
    }

    /* 普通覆盖写（快照 / 统计）：UPSERT，恒写 kv 表 */
    try {
      await d1
        .prepare(
          'INSERT INTO kv (key, value, updated_at) VALUES (?1, ?2, ?3) ' +
            'ON CONFLICT(key) DO UPDATE SET value = excluded.value, updated_at = excluded.updated_at',
        )
        .bind(key, val, Math.floor(Date.now() / 1000))
        .run();
      return { key };
    } catch (err) {
      throw d1Error('put(' + key + ')', err);
    }
  }

  /**
   * 清理过期的锁行。
   *
   * 锁的 TTL 语义 = slice 号：片号 < 当前片号 - 保留窗口，就永远没人再读了。
   * R2 里这些旧 key 只是「不再被访问」（对象还在，靠 lifecycle 删）；D1 里
   * 它们会累积成行，拖慢 inflight 检查的 SELECT。所以这里用一条 DELETE 清掉。
   *
   * 保留窗口 = 当前片往前 2 片：inflightRecently 只读「上一片」（slice-1），
   * 2 片已经是 2 倍余量。更老的一律删。
   *
   * 调用时机：cron 的统计那一跳顺带清一次（每小时），成本 1 条 DELETE，
   * 换掉「行累积拖垮查询」这个 D1 独有的坑。
   */
  async function purgeLocks() {
    const current = sliceOf(now(), tuning);
    const cutoff = current - 2;
    try {
      const r = await d1
        .prepare('DELETE FROM locks WHERE slice < ?1')
        .bind(cutoff)
        .run();
      return r && r.meta ? r.meta.changes : 0;
    } catch (err) {
      throw d1Error('purgeLocks', err);
    }
  }

  return { get, put, purgeLocks };
}

/** 从锁 key 里解析 slice 号。key 形如 lock/<area>/<slice> 或 lock/_global/<slice>。 */
function parseSlice(key, tuning) {
  const m = /\/?(\d+)$/.exec(String(key));
  return m ? Number(m[1]) : 0;
}

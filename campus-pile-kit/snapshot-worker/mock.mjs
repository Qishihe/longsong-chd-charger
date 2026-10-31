/**
 * 本地自测用的假环境：内存 R2 + 可控时钟 + 假上游。
 *
 * 只实现 core.mjs 真正用到的那几个方法，语义严格对齐 Cloudflare：
 *   · put(key, value, { onlyIf: Headers('If-None-Match: *') }) 已存在时返回 null
 *   · get(key) 不存在返回 null
 * 这样 selftest 验证的是逻辑本身，而不是 mock 的宽容度。
 */

export function createBucket() {
  const store = new Map();
  /* Class A 计数：包括「撞 onlyIf 失败」的那些 —— 真实 R2 里 412 也记账，
     写入闸门的测试全靠这个数吃饭。 */
  let puts = 0;
  return {
    store,
    async get(key) {
      const v = store.get(key);
      return v === undefined ? null : { text: async () => v };
    },
    async put(key, value, opts) {
      puts += 1;
      if (opts && opts.onlyIf) {
        const inm = typeof opts.onlyIf.get === 'function' ? opts.onlyIf.get('if-none-match') : opts.onlyIf['If-None-Match'];
        if (inm === '*' && store.has(key)) return null;
      }
      store.set(key, String(value));
      return { key };
    },
    get putCount() {
      return puts;
    },
    resetPuts() {
      puts = 0;
    },
    businessKeys() {
      return [...store.keys()].filter((k) => !k.startsWith('lock/')).sort();
    },
    lockKeys() {
      return [...store.keys()].filter((k) => k.startsWith('lock/')).sort();
    },
  };
}

/** 可控时钟，单位秒。 */
export function createClock(startSec) {
  let t = startSec;
  return {
    now: () => t,
    set: (v) => {
      t = v;
    },
    tick: (d) => {
      t += d;
    },
  };
}

/**
 * 假上游。`mode` 可以切成 'ok' / 'fail' / 'some-fail'。
 * 返回的 p 串长度固定 4，0 = 空闲 —— 和真实接口的语义一致。
 */
export function createScanner({ mode = 'ok' } = {}) {
  const calls = [];
  let n = 0;
  /** 与真实 pileScan 同形：{ ports: [{ num, state }] }，state 0 = 空闲。 */
  const scanOne = async (id) => {
    calls.push(id);
    n += 1;
    if (mode === 'fail') throw new Error('平台没响应（8 秒超时）');
    if (mode === 'auth') {
      const e = new Error('凭证已失效');
      e.auth = true;
      throw e;
    }
    if (mode === 'some-fail' && n % 3 === 0) throw new Error('平台没响应（8 秒超时）');
    const ports = [1, 2, 3, 4].map((num) => ({ num, state: (n + num) % 3 === 0 ? 0 : 1 }));
    return { ports };
  };
  return {
    scanOne,
    calls,
    get count() {
      return calls.length;
    },
    reset() {
      calls.length = 0;
      n = 0;
    },
    setMode(m) {
      mode = m;
    },
  };
}

/** 把「扫一台」包成 core 需要的「扫一批」，测试里语义等价。 */
export function asBatch(scanner) {
  return async (ids) => {
    const out = [];
    for (const id of ids) {
      try {
        const r = await scanner.scanOne(id);
        out.push({ id, ports: r.ports });
      } catch (e) {
        out.push({ id, error: e.message, auth: !!e.auth });
      }
    }
    return out;
  };
}

/**
 * 内存 D1：严格对齐 Cloudflare D1 的 prepare/bind/run/first 语义。
 *
 * 只实现 store-d1.mjs 用到的那几个调用形态：
 *   SELECT value FROM <t> WHERE key = ?     → first() 返回 { value } 或 null
 *   INSERT INTO locks ... ON CONFLICT DO NOTHING → run() 返回 { meta:{changes} }
 *   INSERT INTO kv ... ON CONFLICT DO UPDATE  → run()
 *   DELETE FROM locks WHERE slice < ?         → run() 返回 { meta:{changes} }
 *
 * 不实现完整 SQL 解析，只认 store-d1.mjs 实际发出的语句形状 —— 和 R2 mock 的
 * 「只实现真正用到的方法」是同一个原则：mock 要对齐真实语义，别比真实更宽容。
 */
export function createD1() {
  /* kv: Map<key, value>；locks: Map<key, { value, slice, created_at }> */
  const kv = new Map();
  const locks = new Map();
  let reads = 0; // 行读计数（rows_read：扫描的行数，含点查 miss 也计 1）
  let writes = 0; // 行写计数（rows_written：INSERT/UPDATE/DELETE 影响的行数）

  /* 🔴 行读计费口径（2026-10-27 核对官方文档修正）：
   *
   * D1 的 rows_read 是「扫描的行数」，不是「返回的行数」。官方原话：
   *   "A query that filters on an unindexed column may return fewer rows to
   *    your Worker, but is still required to read (scan) more rows..."
   * 所以这里 miss 也计 1 行读（SQLite 主键 B-tree 查找 miss 仍遍历 1 个索引页），
   * 命中计 1 行读。DELETE 走 idx_locks_slice 索引先扫描（rows_read）再删
   * （rows_written），所以 DELETE 分支里 reads 和 writes 都累加。 */
  const stmt = {
    prepare(sql) {
      return {
        bind(...args) {
          return {
            async first() {
              let row = null;
              if (/FROM kv WHERE/.test(sql)) {
                const key = args[0];
                reads += 1; // 点查：命中或 miss 都扫描 1 行
                if (kv.has(key)) {
                  row = { key, value: kv.get(key) };
                }
              } else if (/FROM locks WHERE/.test(sql)) {
                const key = args[0];
                reads += 1; // 点查主键：命中或 miss 都扫描 1 行
                if (locks.has(key)) {
                  const l = locks.get(key);
                  row = { key, value: l.value, slice: l.slice, created_at: l.created_at };
                }
              }
              return row;
            },
            async run() {
              let changes = 0;
              if (/INSERT INTO locks/.test(sql)) {
                const [key, value, slice, created_at] = args;
                if (!locks.has(key)) {
                  locks.set(key, { value, slice, created_at });
                  changes = 1;
                  writes += 1;
                }
                /* ON CONFLICT DO NOTHING → 已存在则 changes=0，不写 */
              } else if (/INSERT INTO kv/.test(sql)) {
                const [key, value] = args;
                const existed = kv.has(key);
                kv.set(key, value);
                /* 覆盖写：新行算 1 写，更新行也算 1 写（真实 D1 UPSERT 计 1 行写） */
                writes += 1;
                changes = existed ? 1 : 1;
              } else if (/DELETE FROM locks/.test(sql)) {
                const cutoff = args[0];
                /* 真实 D1：DELETE ... WHERE slice < ? 先走 idx_locks_slice 索引
                   扫描命中行（rows_read），再删（rows_written）。这里对齐：
                   扫描的每一行都计 1 读，删掉的每一行计 1 写。 */
                for (const [key, l] of locks) {
                  if (l.slice < cutoff) {
                    reads += 1; // 索引扫描命中
                    locks.delete(key);
                    changes += 1;
                    writes += 1;
                  }
                }
              }
              return { meta: { changes, last_row_id: 0 } };
            },
          };
        },
      };
    },
  };

  const db = {
    prepare: (sql) => stmt.prepare(sql),
    /* 给测试/审计看的内部状态 */
    _kv: kv,
    _locks: locks,
    _reads: () => reads,
    _writes: () => writes,
    _resetCounters() {
      reads = 0;
      writes = 0;
    },
    lockCount: () => locks.size,
  };

  return db;
}

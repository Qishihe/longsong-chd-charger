/**
 * 时序审计：真实扫描不是瞬时的。
 *
 * 前几个审计脚本里，mock 的 scanBatch 都是「调用即返回」，于是所有并发
 * 都在同一个时间点上结束 —— 恰好绕开了这套方案里最脆弱的一件事：
 * **锁是按时间片切的，而扫描是跨时间片跑的**。
 *
 * 一片宽 120 秒，一轮扫描 5–18 秒。如果一轮从第 119 秒开始，跑到第 127 秒
 * 才结束，那么第 120 秒落进新时间片的下一个请求会抢到**另一个**锁 ——
 * 两轮同时打同一个区的同一批桩。
 *
 *   node audit_overlap.mjs
 *
 * 这个脚本用「可控释放」的假扫描器把两轮真的叠在一起，测完再放行。
 */

import { snapFor, refreshArea } from './core.mjs';
import { TUNING } from './config.mjs';
import { createBucket, createClock } from './mock.mjs';
import { PARTITIONS } from './partitions.mjs';

const area = PARTITIONS.areas[0];

/** 让时间片边界好算：T0 正好落在一片的第一秒。 */
const T0 = Math.ceil(1_793_000_040 / TUNING.LOCK_SLICE_S) * TUNING.LOCK_SLICE_S;

/**
 * 可控扫描器：每来一批就挂住，直到测试调用 release()。
 * 这样「一轮还没跑完」这个状态可以被精确地摆出来。
 */
function slowBatch(clock) {
  const starts = [];
  let pending = [];
  return {
    batch: async (ids) => {
      starts.push(clock.now());
      await new Promise((res) => pending.push(res));
      return ids.map((id) => ({ id, ports: [{ num: 1, state: 0 }, { num: 2, state: 1 }] }));
    },
    starts,
    /** 当前还有几轮挂在扫描里。 */
    get inflight() {
      return pending.length;
    },
    async release() {
      const queued = pending;
      pending = [];
      for (const r of queued) r();
      /* 让被唤醒的 await 链跑完（写快照、返回结果） */
      await new Promise((r) => setTimeout(r, 0));
      await new Promise((r) => setTimeout(r, 0));
    },
  };
}

/** 把 Promise 推到「已经进入扫描」为止。 */
async function settle() {
  for (let i = 0; i < 6; i += 1) await new Promise((r) => setTimeout(r, 0));
}

const results = [];
function check(name, pass, detail) {
  results.push({ name, pass, detail });
  console.log(`${pass ? 'OK  ' : 'FAIL'}  ${name}${detail === undefined ? '' : '   ' + detail}`);
}

/* ── A. 跨时间片重叠：一轮还没跑完，下一片开门了 ───────────────── */

{
  const bucket = createBucket();
  const clock = createClock(T0);
  const slow = slowBatch(clock);

  /* 第 1 轮：本片最后一秒开始（模拟「刚好压线」） */
  clock.set(T0 + TUNING.LOCK_SLICE_S - 1);
  const p1 = snapFor({
    bucket,
    area,
    now: clock.now,
    wantRefresh: true,
    scanBatch: slow.batch,
  });
  await settle();

  const startedAt1 = slow.starts.length;
  check('A0 第 1 轮已进入扫描', startedAt1 === 1 && slow.inflight === 1, `inflight=${slow.inflight}`);

  /* 跨过片边界，第 2 个请求到达 */
  clock.set(T0 + TUNING.LOCK_SLICE_S + 1);
  const p2 = snapFor({
    bucket,
    area,
    now: clock.now,
    wantRefresh: true,
    scanBatch: slow.batch,
  });
  await settle();

  const overlap = slow.inflight;
  check(
    'A1 跨片不会开出第二轮扫描',
    overlap === 1,
    overlap === 1 ? '仍然只有 1 轮在飞' : `🔴 有 ${overlap} 轮同时在打同一个区`,
  );

  await slow.release();
  const [r1, r2] = await Promise.all([p1, p2]);
  check(
    'A2 上游只被打一轮',
    slow.starts.length === 1,
    `扫描次数=${slow.starts.length}（正常应为 1）`,
  );
  check(
    'A3 第 2 个请求拿到「等别人刷完」的语义',
    r2.refreshing === true || r2.throttled === true,
    `refreshing=${r2.refreshing} throttled=${r2.throttled} blocked_by=${r2.blocked_by}`,
  );
  check('A4 第 1 轮正常完成', r1.refreshed === true, `refreshed=${r1.refreshed}`);
}

/* ── B. 一轮跑着的 20 秒里，接连来三个请求 ─────────────────────── */

{
  const bucket = createBucket();
  const clock = createClock(T0);
  const slow = slowBatch(clock);

  /* 第 1 轮：本片最后一秒开始（最坏压线） */
  clock.set(T0 + TUNING.LOCK_SLICE_S - 1);
  const ps = [snapFor({ bucket, area, now: clock.now, wantRefresh: true, scanBatch: slow.batch })];
  await settle();

  /* 扫描最长 18 秒，这期间跨过片边界、连来三个请求 */
  for (const dt of [2, 6, 11]) {
    clock.set(T0 + TUNING.LOCK_SLICE_S - 1 + dt);
    ps.push(snapFor({ bucket, area, now: clock.now, wantRefresh: true, scanBatch: slow.batch }));
    await settle();
  }

  check(
    'B1 一轮跑着的 11 秒里，三次请求都没开出新扫描',
    slow.inflight === 1,
    `inflight=${slow.inflight}（应为 1）`,
  );

  const startsWhileBusy = slow.starts.length;
  await slow.release();
  await Promise.all(ps);
  check('B2 合计只扫了 1 次', startsWhileBusy === 1 && slow.starts.length === 1, `扫描次数=${slow.starts.length}`);

  /* 上一轮结束很久之后，必须能正常再刷 —— 不能因为「刚才有人刷过」永久停更 */
  clock.set(T0 + TUNING.LOCK_SLICE_S * 3);
  const later = snapFor({ bucket, area, now: clock.now, wantRefresh: true, scanBatch: slow.batch });
  await settle();
  const startedLater = slow.starts.length;
  await slow.release();
  const rLater = await later;
  check(
    'B3 窗口过去后恢复补刷',
    startedLater === 2 && rLater.refreshed === true,
    `扫描次数=${startedLater} refreshed=${rLater.refreshed}`,
  );
}

/* ── C. 不误伤：上一轮早就结束了，新片必须正常放行 ─────────────── */

{
  const bucket = createBucket();
  const clock = createClock(T0);
  const slow = slowBatch(clock);

  clock.set(T0);
  const p1 = snapFor({ bucket, area, now: clock.now, wantRefresh: true, scanBatch: slow.batch });
  await settle();
  await slow.release();
  await p1;

  /* 上一轮在 T0 结束，T0+121 落进新片 —— 这必须能刷 */
  clock.set(T0 + TUNING.LOCK_SLICE_S + 1);
  const p2 = snapFor({ bucket, area, now: clock.now, wantRefresh: true, scanBatch: slow.batch });
  await settle();
  const started = slow.starts.length;
  await slow.release();
  const r2 = await p2;

  check(
    'C1 上一轮已结束 → 新片正常补刷',
    started === 2 && r2.refreshed === true,
    `扫描次数=${started} refreshed=${r2.refreshed}`,
  );
}

/* ── D. 上一轮超时挂了：不能把整个区永久锁死 ───────────────────── */

{
  const bucket = createBucket();
  const clock = createClock(T0);
  const slow = slowBatch(clock);

  clock.set(T0);
  /* 这一轮永远不 release —— 模拟「扫描接口挂了，Promise 悬挂」 */
  const hung = refreshArea({ bucket, area, now: clock.now, scanBatch: slow.batch });
  await settle();

  /* 2 分钟后再来：这时它仍然挂在飞（真实环境里 withTimeout 会兜住，
     但单测要验证的是「锁不会因此永久占住」） */
  clock.set(T0 + TUNING.LOCK_SLICE_S * 2 + 1);
  const r = await snapFor({
    bucket,
    area,
    now: clock.now,
    wantRefresh: true,
    scanBatch: slow.batch,
  });

  check(
    'D1 上一轮悬挂不会让本区永久停更',
    r.refreshing === true || r.rate_limited === true || r.refreshed === true,
    `blocked_by=${r.blocked_by}`,
  );

  await slow.release();
  await hung;
}

/* ── 汇总 ─────────────────────────────────────────────────────── */

const failed = results.filter((r) => !r.pass);
console.log(
  `\n${failed.length === 0 ? '[PASS]' : '[FAIL]'} ${results.length - failed.length} 通过 / ${failed.length} 失败`,
);
if (failed.length) {
  console.log('失败项：\n  - ' + failed.map((f) => f.name).join('\n  - '));
  process.exit(1);
}

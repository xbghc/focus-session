import { test } from "node:test";
import assert from "node:assert/strict";
import { SessionMachine, type SessionEndEvent } from "../src/content/session.ts";

const THRESHOLDS = { idleTimeoutMs: 30_000, stallTimeoutMs: 90_000, minSessionMs: 3_000, maxQuietMs: 300_000 };

/** 可控时钟 + 事件记录，让 session 划分可以被确定性断言。 */
function harness(
  overrides: Partial<typeof THRESHOLDS> = {},
  initial = { visible: true, focused: true },
  /** 当前视口文字的预计阅读时间。不给就是固定阈值的老行为。 */
  visibleExpectedMs?: () => number,
) {
  let clock = 1_000_000;
  const starts: number[] = [];
  const ends: SessionEndEvent[] = [];
  const m = new SessionMachine(
    { ...THRESHOLDS, ...overrides },
    { now: () => clock, onStart: (ts) => starts.push(ts), onEnd: (ev) => ends.push(ev), visibleExpectedMs },
    initial,
  );
  return {
    m,
    starts,
    ends,
    now: () => clock,
    advance(ms: number) {
      clock += ms;
    },
    /** 模拟定时器：每秒 tick 一次走完这段时间。 */
    run(ms: number) {
      for (let i = 0; i < ms / 1000; i++) {
        clock += 1000;
        m.tick();
      }
    },
  };
}

test("可见且有焦点时 bootstrap 立即开始计时", () => {
  const h = harness();
  h.m.bootstrap();
  assert.equal(h.starts.length, 1);
  assert.equal(h.m.isRunning, true);
  assert.equal(h.m.activeSince, h.starts[0]);
});

test("加载时页面不可见则不开始，转为可见后才开始", () => {
  const h = harness({}, { visible: false, focused: true });
  h.m.bootstrap();
  assert.equal(h.starts.length, 0);
  h.advance(5_000);
  h.m.setVisible(true);
  assert.equal(h.starts.length, 1);
});

test("持续滚动可以无限延长同一个 session", () => {
  const h = harness();
  h.m.bootstrap();
  let y = 0;
  for (let i = 0; i < 20; i++) {
    h.run(10_000);
    h.m.activity((y += 400));
  }
  assert.equal(h.ends.length, 0, "不应有任何 session 结束");
  assert.equal(h.starts.length, 1);
});

test("无任何活动信号超过 idleTimeout 则结束，且不回溯截断", () => {
  const h = harness();
  h.m.bootstrap();
  const start = h.starts[0]!;
  h.advance(5_000);
  h.m.activity(300);
  h.run(30_000);
  assert.equal(h.ends.length, 1);
  const ev = h.ends[0]!;
  assert.equal(ev.reason, "idle");
  // 阅读本身不产生输入：安静读完一屏和起身走开在信号上无从区分，
  // 回溯会把这一屏的阅读时间连同空白一起抹掉。
  assert.equal(ev.endTs, h.now(), "endTs 取当下时刻，不回溯到最后一次活动");
  assert.equal(ev.durationMs, h.now() - start);
  assert.equal(ev.discard, false);
});

test("只在翻屏时才产生信号的读者不会丢失阅读时间", () => {
  // 阅读本身不产生输入。手不碰鼠标、只在翻屏时滚动一下的读者，
  // 屏与屏之间是完全静默的。若 idle 结束时回溯到最后一次活动，
  // 每一屏都会被截成零长度再被 minSession 丢掉——读一整天记录为空。
  const simulate = (idleTimeoutMs: number) => {
    const h = harness({ idleTimeoutMs });
    h.m.bootstrap();
    const startWall = h.now();
    let y = 0;
    for (let screen = 0; screen < 30; screen++) {
      h.run(40_000); // 安静读一屏 40s
      h.m.activity((y += 800)); // 翻到下一屏
    }
    h.m.stop("unload");
    const recorded = h.ends.filter((e) => !e.discard).reduce((n, e) => n + e.durationMs, 0);
    return recorded / (h.now() - startWall);
  };

  const strict = simulate(30_000);
  assert.ok(strict > 0.6, `默认阈值下也应记录大部分阅读时间，实际只有 ${Math.round(strict * 100)}%`);

  // 阈值放宽到超过单屏阅读时长后，片段不再被切断
  const relaxed = simulate(90_000);
  assert.ok(relaxed > 0.95, `阈值宽于单屏时长时应几乎完整记录，实际 ${Math.round(relaxed * 100)}%`);
});

test("有输入但滚动位置不变超过 stallTimeout 判为发呆", () => {
  const h = harness();
  h.m.bootstrap();
  // 每 5s 动一次鼠标（滚动位置始终是 0），idle 永远不触发
  for (let i = 0; i < 24; i++) {
    h.run(5_000);
    h.m.activity(0);
  }
  assert.equal(h.ends.length, 1);
  assert.equal(h.ends[0]!.reason, "stall");
  // stall 不回溯：无法证明这段时间没在读
  assert.ok(h.ends[0]!.durationMs >= 90_000, `期望 >=90s，实际 ${h.ends[0]!.durationMs}`);
});

test("滚动会重置 stall 计时器，但鼠标移动不会", () => {
  const h = harness();
  h.m.bootstrap();
  let y = 0;
  for (let i = 0; i < 10; i++) {
    h.run(20_000); // 20s < idleTimeout？否，30s 才 idle，这里安全
    h.m.activity((y += 100)); // 滚动位置改变 → 重置 stall
  }
  assert.equal(h.ends.length, 0);
});

test("页面隐藏立即结束 session", () => {
  const h = harness();
  h.m.bootstrap();
  h.advance(10_000);
  h.m.setVisible(false);
  assert.equal(h.ends.length, 1);
  assert.equal(h.ends[0]!.reason, "hidden");
  assert.equal(h.ends[0]!.durationMs, 10_000);
  assert.equal(h.m.isRunning, false);
});

test("窗口失焦立即结束 session", () => {
  const h = harness();
  h.m.bootstrap();
  h.advance(8_000);
  h.m.setFocused(false);
  assert.equal(h.ends.length, 1);
  assert.equal(h.ends[0]!.reason, "blur");
});

test("失焦再回来会开一个新 session，无需等待活动信号", () => {
  const h = harness();
  h.m.bootstrap();
  h.advance(10_000);
  h.m.setFocused(false);
  h.advance(60_000);
  h.m.setFocused(true);
  assert.equal(h.starts.length, 2);
  assert.equal(h.starts[1], h.now());
});

test("blur 与 visibilitychange 同时到达只结束一次", () => {
  const h = harness();
  h.m.bootstrap();
  h.advance(10_000);
  h.m.setFocused(false);
  h.m.setVisible(false);
  assert.equal(h.ends.length, 1, "切标签会连续触发 blur 和 hidden，不能记两次");
});

test("idle 结束后需要新的活动信号才重新计时", () => {
  const h = harness();
  h.m.bootstrap();
  h.run(30_000);
  assert.equal(h.ends.length, 1);
  // 仅仅 tick 不会重启
  h.run(30_000);
  assert.equal(h.starts.length, 1, "静止期间不应凭空开始新 session");
  h.m.activity(500);
  assert.equal(h.starts.length, 2);
});

test("过短的 session 被标记为 discard", () => {
  const h = harness();
  h.m.bootstrap();
  h.advance(1_200);
  h.m.setVisible(false);
  assert.equal(h.ends[0]!.discard, true, "alt-tab 抖动产生的碎片应丢弃");
});

test("发呆之后，只晃鼠标不滚动不会重新开始计时", () => {
  const h = harness();
  h.m.bootstrap();
  // 盯着同一屏，每 5s 动一下鼠标，持续半小时
  for (let i = 0; i < 360; i++) {
    h.run(5_000);
    h.m.activity(0);
  }
  assert.equal(h.ends.length, 1, "半小时的发呆只应产生一个 session，而不是一串 90s 的片段");
  assert.equal(h.ends[0]!.reason, "stall");
  assert.equal(h.starts.length, 1);
  assert.ok(
    h.ends[0]!.durationMs < 100_000,
    `发呆时长不该被计入专注，实际 ${h.ends[0]!.durationMs}ms`,
  );
});

test("发呆之后出现真实滚动才重新开始计时", () => {
  const h = harness();
  h.m.bootstrap();
  for (let i = 0; i < 100 && h.ends.length === 0; i++) {
    h.run(5_000);
    h.m.activity(0);
  }
  assert.equal(h.ends[0]!.reason, "stall");
  assert.equal(h.starts.length, 1, "同位置的活动信号不应重启");

  h.m.activity(800); // 真的滚了
  assert.equal(h.starts.length, 2);
});

test("新 session 开始时重置 stall 基准，不会立刻再次判定发呆", () => {
  const h = harness();
  h.m.bootstrap();
  let y = 0;
  const nudge = () => {
    h.run(5_000);
    h.m.activity(y);
  };
  for (let i = 0; i < 100 && h.ends.length === 0; i++) nudge();
  assert.equal(h.ends[0]!.reason, "stall");

  h.m.activity((y += 400)); // 滚动恢复阅读
  assert.equal(h.starts.length, 2);
  const secondStart = h.starts[1]!;

  for (let i = 0; i < 100 && h.now() - secondStart < 60_000; i++) nudge();
  assert.equal(h.ends.length, 1, "新 session 的 stall 基准应从自身起点重新计算");

  for (let i = 0; i < 100 && h.ends.length === 1; i++) nudge();
  assert.equal(h.ends[1]!.reason, "stall");
  assert.ok(
    h.ends[1]!.endTs - secondStart >= 90_000,
    `新 session 应撑满 stall 阈值，实际 ${h.ends[1]!.endTs - secondStart}ms`,
  );
});

test("走神（idle）之后任意信号都能重新开始，不要求滚动", () => {
  const h = harness();
  h.m.bootstrap();
  h.run(30_000);
  assert.equal(h.ends[0]!.reason, "idle");
  h.m.activity(0); // 只是动了下鼠标，位置没变
  assert.equal(h.starts.length, 2, "离开后回来就是回来了，不必先滚动");
});

test("发呆后切走再切回，直接开始新 session", () => {
  const h = harness();
  h.m.bootstrap();
  for (let i = 0; i < 100 && h.ends.length === 0; i++) {
    h.run(5_000);
    h.m.activity(0);
  }
  assert.equal(h.ends[0]!.reason, "stall");
  h.m.setVisible(false);
  h.m.setVisible(true);
  assert.equal(h.starts.length, 2, "重新聚焦是明确的重新投入信号");
});

test("阈值可热更新", () => {
  const h = harness();
  h.m.bootstrap();
  h.m.updateThresholds({ idleTimeoutMs: 5_000 });
  h.run(5_000);
  assert.equal(h.ends.length, 1);
  assert.equal(h.ends[0]!.reason, "idle");
});

test("unload 时结束当前 session", () => {
  const h = harness();
  h.m.bootstrap();
  h.advance(20_000);
  h.m.stop("unload");
  assert.equal(h.ends[0]!.reason, "unload");
  assert.equal(h.ends[0]!.durationMs, 20_000);
  // 重复 stop 不应重复上报
  h.m.stop("unload");
  assert.equal(h.ends.length, 1);
});

/* ---------- 走神阈值随视口文字量自适应 ---------- */

test("视口里有一屏文字时，静默上限放宽到读完它所需时间的 1.5 倍", () => {
  // 一屏约 400 词 ≈ 100s：固定 30s 的阈值会在读到三分之一处切一刀
  const h = harness({}, undefined, () => 100_000);
  h.m.bootstrap();
  h.run(60_000);
  assert.equal(h.ends.length, 0, "60s 没输入仍在读这一屏，不该判走神");
  h.run(89_000);
  assert.equal(h.ends.length, 0, "149s 仍在 1.5 倍余量之内");
  h.run(2_000);
  assert.equal(h.ends.length, 1);
  assert.equal(h.ends[0]!.reason, "idle");
  assert.ok(h.ends[0]!.durationMs >= 150_000, `实际 ${h.ends[0]!.durationMs}`);
});

test("自适应上限被 maxQuietMs 封顶：真离开时的高估有界", () => {
  const h = harness({ maxQuietMs: 300_000 }, undefined, () => 1_000_000);
  h.m.bootstrap();
  h.run(299_000);
  assert.equal(h.ends.length, 0);
  h.run(2_000);
  assert.equal(h.ends.length, 1, "满屏密字也最多等 5 分钟");
});

test("maxQuietMs 为 0 关闭自适应，退回固定阈值", () => {
  const h = harness({ maxQuietMs: 0 }, undefined, () => 100_000);
  h.m.bootstrap();
  h.run(30_000);
  assert.equal(h.ends.length, 1);
  assert.equal(h.ends[0]!.reason, "idle");
});

test("视口里没什么字（图、评论区）时固定阈值照旧是下限", () => {
  const h = harness({}, undefined, () => 5_000); // 5s 的文字 × 1.5 = 7.5s < 30s
  h.m.bootstrap();
  h.run(30_000);
  assert.equal(h.ends.length, 1, "没东西可读，30s 没动就是走了");
});

test("发呆阈值同样随文字量放宽", () => {
  const h = harness({}, undefined, () => 100_000);
  h.m.bootstrap();
  // 每 5s 动一下鼠标、位置不变：固定阈值下 90s 判发呆
  for (let i = 0; i < 24; i++) {
    h.run(5_000);
    h.m.activity(0);
  }
  assert.equal(h.ends.length, 0, "120s 仍在读这一屏（含晃鼠标），不该判发呆");
  for (let i = 0; i < 8 && h.ends.length === 0; i++) {
    h.run(5_000);
    h.m.activity(0);
  }
  assert.equal(h.ends.length, 1);
  assert.equal(h.ends[0]!.reason, "stall");
  assert.ok(h.ends[0]!.durationMs >= 150_000, `实际 ${h.ends[0]!.durationMs}`);
});

test("quietLimits 报出此刻生效的上限，供 popup 解释", () => {
  const h = harness({}, undefined, () => 100_000);
  assert.deepEqual(h.m.quietLimits(), { idleMs: 150_000, stallMs: 150_000 });
  const fixed = harness();
  assert.deepEqual(fixed.m.quietLimits(), { idleMs: 30_000, stallMs: 90_000 }, "没有文字量信息就是固定阈值");
});

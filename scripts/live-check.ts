/*
 * 拿真 key 打一次 MiniMax，看讲解功能在真实模型上是什么样。
 *
 * 这不是单元测试的替代品——它验证的恰恰是单元测试验证不了的那部分：
 * 模型会不会照着 system prompt 的格式输出、挑出来的词值不值得讲、
 * max_tokens 在长选区上够不够。所以它**直接调 src/lib/llm.ts**，
 * 不重写一遍请求组装，否则测的就不是线上跑的那段代码了。
 *
 *   MINIMAX_API_KEY=... node --experimental-strip-types scripts/live-check.ts
 */
import { LlmError, translate, translateStream } from "../src/lib/llm.ts";
import { DEFAULT_LLM } from "../src/types.ts";
import type { LlmConfig, PartialTranslation, TranslateRequest } from "../src/types.ts";

const apiKey = process.env["MINIMAX_API_KEY"] ?? "";
if (!apiKey) {
  console.error("没有 MINIMAX_API_KEY，跳过。");
  process.exit(2);
}
const CFG: LlmConfig = { ...DEFAULT_LLM, apiKey };

const TITLE = "The Quiet Collapse of Oversight";
const SENTENCE =
  "Regulators have come under intense scrutiny for their tacit endorsement of a practice that, " +
  "in hindsight, was plainly untenable.";
const PARA =
  SENTENCE +
  " For years the agency waved through filings that nobody outside a handful of insiders could parse, " +
  "content to defer to the very institutions it was meant to police. The rationale, insofar as one was " +
  "ever articulated, amounted to a bet that the market would police itself — a bet that looks reckless " +
  "only in retrospect, though a few dissenting voices had flagged the exposure well before the unwinding " +
  "began. When the reckoning came, it arrived not as a single shock but as a slow erosion of the " +
  "assumptions that had propped up the whole edifice, leaving supervisors to explain why warnings that " +
  "now read as unambiguous had been filed away as noise.";

const req = (over: Partial<TranslateRequest>): TranslateRequest => ({
  articleId: "https://example.com/oversight",
  url: "https://example.com/oversight",
  articleTitle: TITLE,
  text: SENTENCE,
  context: PARA,
  kind: "sentence",
  explainVocab: true,
  ...over,
});

const ms = (t: number): string => `${Math.round(performance.now() - t)}ms`;

/** `--only=长` 只跑名字里带这个词的用例——重跑一条边界不必把整套都烧一遍。 */
const only = (process.argv.find((a) => a.startsWith("--only=")) ?? "").slice(7);
const want = (label: string): boolean => !only || label.includes(only);

function show(label: string, r: Awaited<ReturnType<typeof translate>>, t: number): void {
  const { result: x, usage } = r;
  console.log(`\n━━ ${label}  [${ms(t)}, in ${usage.inputTokens} / out ${usage.outputTokens} tok]`);
  console.log(`译文   : ${x.translation}`);
  console.log(`音标词性: ${[x.phonetic, x.pos, x.lemma].filter(Boolean).join(" · ") || "—"}`);
  console.log(`语境   : ${x.contextNote || "—"}`);
  console.log(`用法   : ${x.usage ?? "—"}`);
  if (x.vocab.length === 0) console.log("生词   : —");
  for (const v of x.vocab) {
    console.log(`  · ${v.word}  ${[v.phonetic, v.pos].filter(Boolean).join(" · ")}`);
    console.log(`    ${v.meaning}${v.note ? `  ｜ ${v.note}` : ""}`);
  }
}

async function one(label: string, over: Partial<TranslateRequest>): Promise<void> {
  if (!want(label)) return;
  const t = performance.now();
  try {
    show(label, await translate(req(over), CFG), t);
  } catch (err) {
    const e = err as LlmError;
    console.log(`\n━━ ${label}  ✗ ${e.kind ?? "?"}：${e.message}`);
  }
}

/** 流式那条路单独跑：要看的是"什么时候能显示什么"，不是最终结果。 */
async function stream(label: string, over: Partial<TranslateRequest>): Promise<void> {
  if (!want(label)) return;
  const t = performance.now();
  const marks: string[] = [];
  let lastVocab = 0;
  const onPartial = (p: PartialTranslation): void => {
    const bits: string[] = [];
    if (p.translation) bits.push("译文");
    if (p.phonetic || p.pos) bits.push("音标/词性");
    if (p.contextNote) bits.push("语境");
    if (p.usage) bits.push("用法");
    if (p.vocab.length > lastVocab) {
      bits.push(`生词+${p.vocab.length - lastVocab}（${p.vocab[p.vocab.length - 1]!.word}）`);
      lastVocab = p.vocab.length;
    }
    marks.push(`${ms(t).padStart(7)}  ${bits.join(" ")}`);
  };
  try {
    const r = await translateStream(req(over), CFG, onPartial);
    console.log(`\n━━ ${label}（流式）`);
    for (const m of marks) console.log("   " + m);
    show("  └ 最终", r, t);
  } catch (err) {
    const e = err as LlmError;
    console.log(`\n━━ ${label}（流式）✗ ${e.kind ?? "?"}：${e.message}`);
  }
}

await one("单词 scrutiny", { text: "scrutiny", kind: "word", context: SENTENCE });
await one("短语 under intense scrutiny", { text: "under intense scrutiny", kind: "phrase", context: SENTENCE });
await one("整句", {});
await one("整句·关掉讲解", { explainVocab: false });
await stream("整句", {});
await one("长选区（约 130 词，试 max_tokens=1024）", { text: PARA });

/*
 * 自动翻译上限（maxAutoSelectionWords = 200）这一档：
 * 划到这么多词仍然**不弹确认、直接发出去**，所以这是"顺手一划就要花的钱"的上界。
 * 阈值从 40 抬到 200 的依据就在这条：它得在 max_tokens=1024 里装得下。
 */
const AT_LIMIT = `${PARA} ${PARA.replace("Regulators", "Supervisors")}`.split(" ").slice(0, 200).join(" ");
await one(`自动翻译上限（${AT_LIMIT.split(" ").length} 词，不弹确认的最大一份）`, {
  text: AT_LIMIT,
  context: AT_LIMIT,
});

/*
 * 逼近硬上限（HARD_MAX_CHARS = 2000）的选区：这是 max_tokens 最容易撑爆的地方，
 * 而它一旦爆掉，用户看到的是「输出被 max_tokens 截断」而不是译文——
 * 讲解把输出撑长之后，这条边界必须实测。
 */
const HUGE = [PARA, PARA.replace("Regulators", "Supervisors"), PARA.slice(0, 400)].join(" ");
console.log(`
（下一条选区 ${HUGE.length} 字符，硬上限是 2000）`);
await one("逼近硬上限的选区", { text: HUGE, context: HUGE });

import { REPORT_METRIC_LABELS } from "./closerTypes";
import type {
  CallContext,
  CallOutcome,
  ObjectionHandled,
  SalesReport,
  TranscriptLine,
} from "./closerTypes";

const clamp = (v: number, lo: number, hi: number) =>
  Math.max(lo, Math.min(hi, Math.round(v)));

/** Tolerantly validate/normalize whatever the model returned. */
export function normalizeReport(raw: unknown): SalesReport | null {
  if (!raw || typeof raw !== "object") return null;
  const r = raw as Record<string, unknown>;

  const num = (v: unknown): number => clamp(Number(v) || 0, 0, 100);
  const strArr = (v: unknown): string[] =>
    Array.isArray(v) ? v.filter((x) => typeof x === "string").map(String) : [];
  const oneStr = (v: unknown): string => (typeof v === "string" ? v : "");

  const objections: ObjectionHandled[] = Array.isArray(r.objectionHandlingDetails)
    ? (r.objectionHandlingDetails as Record<string, unknown>[])
        .filter((o) => o && typeof o.objection === "string")
        .map((o) => ({
          objection: String(o.objection),
          outcome: String(o.outcome ?? ""),
          grade: ["strong", "weak", "missed"].includes(String(o.grade))
            ? (String(o.grade) as ObjectionHandled["grade"])
            : "weak",
        }))
    : [];

  return {
    overall: num(r.overall),
    clarity: num(r.clarity),
    persuasiveness: num(r.persuasiveness),
    listening: num(r.listening),
    objectionHandling: num(r.objectionHandling),
    conversationalControl: num(r.conversationalControl),
    opening: num(r.opening),
    closing: num(r.closing),
    verdict: oneStr(r.verdict) || "A solid practice call.",
    bestArgument: oneStr(r.bestArgument),
    weakestArgument: oneStr(r.weakestArgument),
    customerObjections: strArr(r.customerObjections),
    objectionHandlingDetails: objections,
    missedOpportunities: strArr(r.missedOpportunities),
    betterStrategy: oneStr(r.betterStrategy),
    specificImprovements: strArr(r.specificImprovements),
  };
}

/**
 * Deterministic fallback report — used when the report Edge Function is
 * unreachable (no key, offline, quota). Computes real metrics from the
 * transcript so the analysis screen ALWAYS has something honest to show.
 */
export function fallbackReport(
  ctx: CallContext,
  transcript: TranscriptLine[],
  durationSec: number,
  outcome: CallOutcome
): SalesReport {
  const userLines = transcript.filter((l) => l.role === "user");
  const custLines = transcript.filter((l) => l.role === "customer");
  const allUserWords = userLines.flatMap((l) =>
    l.text.split(/\s+/).filter(Boolean)
  );
  const totalUserWords = allUserWords.length;
  const totalCustWords = custLines.flatMap((l) =>
    l.text.split(/\s+/).filter(Boolean)
  ).length;
  const totalWords = totalUserWords + totalCustWords;
  const userShare = totalWords > 0 ? totalUserWords / totalWords : 0;
  const exchanges = transcript.length;
  const engagedCust = custLines.some((l) =>
    /(hmm|maybe|how much|tell me|really|interesting)/i.test(l.text)
  );
  const avgUserLen =
    userLines.length > 0 ? totalUserWords / userLines.length : 0;
  const hasContext = Boolean(ctx);

  const score = (base: number, adj: number) => clamp(base + adj, 0, 100);

  const clarity = score(90, -avgUserLen * 0.8);
  const persuasiveness = score(48, Math.min(totalUserWords / 25, 16) + (engagedCust ? 12 : 0));
  const listening = score(58, totalWords > 0 ? (userShare > 0.68 ? -18 : userShare < 0.3 ? -10 : 16) : -30);
  const objectionHandling = score(52, (engagedCust ? 10 : 0) + (outcome === "customer-hung-up" ? -10 : 0));
  const conversationalControl = score(62, Math.min(exchanges * 4, 20) + (outcome === "customer-hung-up" ? -12 : 0));
  const opening = score(66, exchanges >= 2 ? 6 : -8);
  const closing = score(45, engagedCust ? 14 : 0);

  const overall = clamp(
    (clarity + persuasiveness + listening + objectionHandling +
      conversationalControl + opening + closing) / 7,
    0,
    100
  );

  const strengths: string[] = [];
  const weaknesses: string[] = [];
  const missed: string[] = [];
  if (totalUserWords === 0) {
    weaknesses.push("You didn't get a word in — the customer never heard a pitch.");
    missed.push("N/A — no spoken pitch was captured this call. Keep speaking clearly next round.");
  } else {
    if (clarity >= 72) strengths.push("Your speech was clear and easy to follow.");
    else weaknesses.push("Speak more deliberately — slow down and finish each sentence.");
    if (listening >= 66) strengths.push("Good listening balance — you let the customer talk.");
    else if (userShare > 0.68) weaknesses.push(`You spoke ~${Math.round(userShare * 100)}% of the time — the customer barely got a word in.`);
    if (engagedCust) { strengths.push("You got the customer engaged — they were genuinely considering it."); missed.push(`The customer warmed up mid-call — that was the moment to move to a close ("If I can do X, is there any reason not to go ahead?").`); }
    else missed.push("Work on creating a hook — 'quick question' opens are getting you tuned out.");
    if (avgUserLen > 90) weaknesses.push(`Your longest pitch ran ~${Math.round(avgUserLen)} words — the customer wants short, punchy value.`);
    if (totalCustWords > 0 && userShare < 0.3) weaknesses.push("The customer did most of the talking — you need to steer the conversation.");
  }
  if (outcome === "customer-hung-up") {
    weaknesses.push("The customer hung up on you — you lost them.");
    missed.push("They tried to leave and you didn't give them a reason to stay. One concrete benefit in 10 seconds could have saved it.");
  }

  return {
    overall,
    clarity,
    persuasiveness,
    listening,
    objectionHandling,
    conversationalControl,
    opening,
    closing,
    verdict:
      overall >= 80
        ? "Strong cold call — you held your own."
        : overall >= 60
          ? "Solid base — tighten a few moments and you'll close more."
          : "Tough call — the customer walked all over you. That's exactly why you practice.",
    bestArgument: totalUserWords
      ? "Your clearest, most benefit-focused pitch — lean into concrete outcomes next round."
      : "No spoken pitch was captured to judge.",
    weakestArgument: totalUserWords
      ? "Wherever you repeated yourself or listed features without tying them to the customer's situation."
      : "N/A — no pitch was captured.",
    customerObjections: custLines.length
      ? ["Price/value", "Need", "Trust"]
      : [],
    objectionHandlingDetails: [],
    missedOpportunities: missed.length
      ? missed
      : ["Compare your open vs. your close — the gap is usually the missed opportunity."],
    betterStrategy: hasContext
      ? `Lead with one concrete benefit of ${ctx.product} tied to what the customer cares about, then qualify with an open question before pitching features. This call ran ${Math.round(durationSec)}s.`
      : "Lead with one concrete benefit tied to what the customer cares about, then qualify with an open question before pitching features.",
    specificImprovements: [
      "Open with a 'quick question' hook instead of launching into the pitch.",
      "After every objection, answer it with value before moving on.",
      "Close with a choice: 'Do you want the basic or the premium one?'",
    ],
  };
}

/** Build the 7 metrics array the UI renders from the report. */
export function reportMetrics(r: SalesReport) {
  const byLabel: Record<string, number> = {
    Clarity: r.clarity,
    Persuasiveness: r.persuasiveness,
    Listening: r.listening,
    "Objection Handling": r.objectionHandling,
    "Conversational Control": r.conversationalControl,
    Opening: r.opening,
    Closing: r.closing,
  };
  return REPORT_METRIC_LABELS.map((label) => ({
    label,
    score: byLabel[label] ?? 50,
    note: metricNote(label, byLabel[label] ?? 50),
  }));
}

function metricNote(label: string, score: number): string {
  const notes: Record<string, string> = {
    Clarity: "How cleanly each sentence landed.",
    Persuasiveness: "Did your arguments actually move them?",
    Listening: "Balance between talking and hearing them out.",
    "Objection Handling": "Turning 'no' into a conversation.",
    "Conversational Control": "Steering without steamrolling.",
    Opening: "The first 10 seconds decide the call.",
    Closing: "Moving from pitch to commitment.",
  };
  const grade = score >= 75 ? "Strong." : score >= 55 ? "Developing." : "Needs work.";
  return `${notes[label] ?? ""} ${grade}`;
}

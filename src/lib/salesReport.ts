import { isDisfluent } from "../hooks/useSpeechmaticsWS";
import { REPORT_METRIC_LABELS } from "./closerTypes";
import type {
  CallContext,
  CallOutcome,
  SalesReport,
  TranscriptLine,
} from "./closerTypes";

const clamp = (v: number, lo: number, hi: number) => Math.max(lo, Math.min(hi, Math.round(v)));

/** Tolerantly validate/normalize whatever the model returned. */
export function normalizeReport(raw: unknown): SalesReport | null {
  if (!raw || typeof raw !== "object") return null;
  const r = raw as Record<string, unknown>;

  const metrics = Array.isArray(r.metrics)
    ? (r.metrics as Record<string, unknown>[])
        .filter((m) => m && typeof m.label === "string")
        .map((m) => ({
          label: String(m.label),
          score: clamp(Number(m.score) || 0, 0, 100),
          note: String(m.note ?? ""),
        }))
    : [];

  if (!metrics.length) return null;

  const strArr = (v: unknown): string[] =>
    Array.isArray(v) ? v.filter((x) => typeof x === "string").map(String) : [];
  const oneStr = (v: unknown): string => (typeof v === "string" ? v : "");

  return {
    overall: clamp(Number(r.overall) || 0, 0, 100),
    verdict: oneStr(r.verdict) || "A solid practice call.",
    metrics,
    strengths: strArr(r.strengths),
    weaknesses: strArr(r.weaknesses),
    missedOpportunities: strArr(r.missedOpportunities),
    almostAgreed: oneStr(r.almostAgreed),
    objectionFeedback: strArr(r.objectionFeedback),
    betterResponses: strArr(r.betterResponses),
    coachNote: oneStr(r.coachNote),
    personaReveal: oneStr(r.personaReveal),
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
  const allUserWords = userLines.flatMap((l) => l.text.split(/\s+/).filter(Boolean));
  const allCustWords = custLines.flatMap((l) => l.text.split(/\s+/).filter(Boolean));
  const totalUserWords = allUserWords.length;
  const totalCustWords = allCustWords.length;
  const totalWords = totalUserWords + totalCustWords;
  const userShare = totalWords > 0 ? totalUserWords / totalWords : 0;
  const fillerCount = allUserWords.filter((w) => isDisfluent(w)).length;
  const fillerRate = totalUserWords > 0 ? fillerCount / totalUserWords : 0;
  const questions = userLines.filter((l) => /\?/.test(l.text)).length;
  const avgUserLen = userLines.length > 0 ? totalUserWords / userLines.length : 0;
  const exchanges = transcript.length;
  const engagedCust = custLines.some((l) => /(hmm|maybe|how much|tell me|really|interesting)/i.test(l.text));

  const score = (base: number, adj: number) => clamp(base + adj, 0, 100);

  const clarity = score(92, -avgUserLen * 0.9 - fillerRate * 90);
  const confidence = score(62, Math.min(totalUserWords, 600) / 14 - fillerCount * 2);
  const listening = score(58, totalWords > 0 ? (userShare > 0.68 ? -18 : userShare < 0.3 ? -10 : 16) : -30);
  const rapport = score(52, exchanges * 4 + (engagedCust ? 14 : -6));
  const flow = score(66, Math.min(exchanges * 5, 24) + (outcome === "customer-hung-up" ? -12 : 0));
  const objections = score(50, questions * 6 + (engagedCust ? 10 : 0));
  const persuasiveness = score(48, Math.min(totalUserWords / 25, 18) + questions * 3 + (engagedCust ? 12 : 0));
  const professionalism = score(70, fillerCount > 6 ? -12 : 0);
  const empathy = score(55, questions >= 1 ? 12 : -6);
  const closing = score(45, engagedCust ? 14 : 0);
  const tone = score(65, exchanges > 0 ? 6 : 0);
  const fillers = score(80, -fillerRate * 130 - fillerCount * 2);
  const interruptions = score(62, exchanges >= 4 ? 8 : 0);
  const speed = score(58, avgUserLen > 0 && avgUserLen < 40 ? 16 : avgUserLen > 90 ? -14 : 0);

  const metricList = REPORT_METRIC_LABELS.map((label) => {
    const m = {
      Persuasiveness: persuasiveness,
      Confidence: confidence,
      Clarity: clarity,
      "Handling Objections": objections,
      "Listening Skills": listening,
      Rapport: rapport,
      "Conversation Flow": flow,
      Professionalism: professionalism,
      Empathy: empathy,
      "Closing Ability": closing,
      Tone: tone,
      "Filler Words": fillers,
      "Interruptions Handled": interruptions,
      "Response Speed": speed,
    }[label];
    return { label, score: m, note: metricNote(label, m, ctx) };
  });

  const overall = clamp(
    (persuasiveness + confidence + clarity + objections + listening + rapport + flow +
      professionalism + empathy + closing + tone + fillers + interruptions + speed) / 14,
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
    if (clarity >= 75) strengths.push("Your speech was clear and easy to follow.");
    else weaknesses.push("Speak more deliberately — slow down and finish each sentence.");
    if (listening >= 68) strengths.push("Good listening balance — you let the customer talk.");
    else if (userShare > 0.68) weaknesses.push(`You spoke ~${Math.round(userShare * 100)}% of the time — the customer barely got a word in.`);
    if (questions >= 1) strengths.push(`You asked ${questions} question${questions > 1 ? "s" : ""} — qualifying questions build rapport.`);
    else { weaknesses.push("You asked no qualifying questions — discover needs before pitching."); missed.push("Ask an open question early ('What do you currently use?') to find their pain."); }
    if (engagedCust) { strengths.push("You got the customer engaged — they were genuinely considering it."); missed.push(`The customer warmed up mid-call — that was the moment to move to a close ("If I can do X, is there any reason not to go ahead?").`); }
    else missed.push("Work on creating a hook — 'quick question' opens are getting you tuned out.");
    if (fillerCount > 6) weaknesses.push(`${fillerCount} filler words — replace "um/uh/like" with a brief pause.`);
    if (avgUserLen > 90) weaknesses.push(`Your longest pitch ran ~${Math.round(avgUserLen)} words — the customer wants short, punchy value.`);
    if (totalCustWords > 0 && userShare < 0.3) weaknesses.push("The customer did most of the talking — you need to steer the conversation.");
  }
  if (outcome === "customer-hung-up") {
    weaknesses.push("The customer hung up on you — you lost them.");
    missed.push("They tried to leave and you didn't give them a reason to stay. One concrete benefit in 10 seconds could have saved it.");
  }

  return {
    overall,
    verdict: overall >= 80 ? "Strong cold call — you held your own." : overall >= 60 ? "Solid base — tighten a few moments and you'll close more." : "Tough call — the customer walked all over you. That's exactly why you practice.",
    metrics: metricList,
    strengths: strengths.length ? strengths : ["You picked up and started the call — showing up is step one."],
    weaknesses: weaknesses.length ? weaknesses : ["No obvious weaknesses captured — run another call for a deeper read."],
    missedOpportunities: missed.length ? missed : ["Compare your open vs. your close — the gap is usually the missed opportunity."],
    almostAgreed: engagedCust ? "The customer softened mid-call — a confident close could have sealed it." : "The customer never got close to agreeing.",
    objectionFeedback: ["Price and trust objections were the walls — neither got a value-based answer."],
    betterResponses: [
      "Pivot objections to value: 'Compared to what you'd spend fixing this later…'",
      "Close with a choice, not a question: 'Do you want the basic or the premium one?'",
      "Handle 'I already have one' with: 'What's it not doing for you?'",
    ],
    coachNote: `Call duration ${Math.round(durationSec)}s · ${exchanges} exchanges · ${totalUserWords} words spoken by you. Every rejection is reps — run another call and stack the small wins.`,
    personaReveal: `The customer you called was playing the role of: ${ctx.persona}. That persona shaped how they pushed back — adapt your pitch to the person, not the product.`,
  };
}

function metricNote(label: string, score: number, ctx: CallContext): string {
  const notes: Record<string, string> = {
    Persuasiveness: `Pitching ${ctx.product} against a tough customer.`,
    Confidence: "Steady and self-assured through the pitch.",
    Clarity: "How cleanly each sentence landed.",
    "Handling Objections": "Turning 'no' into a conversation.",
    "Listening Skills": "Balance between talking and hearing them out.",
    Rapport: "Did the customer warm up or stay cold?",
    "Conversation Flow": "Natural rhythm, or long awkward gaps.",
    Professionalism: "Business-appropriate even under pressure.",
    Empathy: "Acknowledging their situation before pushing.",
    "Closing Ability": "Moving from pitch to commitment.",
    Tone: "Energy and warmth in your delivery.",
    "Filler Words": "Um/uh/like noise relative to total words.",
    "Interruptions Handled": "Recovering when the customer cuts you off.",
    "Response Speed": "How quickly you replied without rambling.",
  };
  const grade = score >= 75 ? "Strong." : score >= 55 ? "Developing." : "Needs work.";
  return `${notes[label] ?? ""} ${grade}`;
}

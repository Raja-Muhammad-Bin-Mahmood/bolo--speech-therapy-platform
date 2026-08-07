/** Shared types for Closer Mode — the cold-call sales simulator. */

export type CallPhase = "idle" | "roulette" | "ringing" | "connecting" | "live" | "ended";

export type CallOutcome =
  | "user-ended"
  | "customer-hung-up"
  | "timeout"
  | "error";

export type SpeakerRole = "user" | "customer";

/** Everything that defines one simulated cold call. */
export interface CallContext {
  /** The product being sold (roulette result). */
  product: string;
  /** Random customer name shown on the phone screen. */
  customerName: string;
  /** Hidden persona the customer plays — never shown during the call. */
  persona: string;
  /** What the customer is "doing" when they answer. */
  mood: string;
}

export interface TranscriptLine {
  role: SpeakerRole;
  text: string;
  /** Seconds since the call connected. */
  atSec: number;
}

export interface ReportMetric {
  label: string;
  score: number; // 0–100
  note: string;
}

export interface SalesReport {
  overall: number;
  verdict: string;
  metrics: ReportMetric[];
  strengths: string[];
  weaknesses: string[];
  missedOpportunities: string[];
  almostAgreed: string;
  objectionFeedback: string[];
  betterResponses: string[];
  coachNote: string;
  personaReveal: string;
}

export const REPORT_METRIC_LABELS = [
  "Persuasiveness",
  "Confidence",
  "Clarity",
  "Handling Objections",
  "Listening Skills",
  "Rapport",
  "Conversation Flow",
  "Professionalism",
  "Empathy",
  "Closing Ability",
  "Tone",
  "Filler Words",
  "Interruptions Handled",
  "Response Speed",
] as const;

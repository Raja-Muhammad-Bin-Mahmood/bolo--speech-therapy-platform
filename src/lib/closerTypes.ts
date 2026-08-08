/** Shared types for Closer Mode — the cold-call sales simulator. */

/** Top-level screen phase (drives which screen CloserMode renders). */
export type CallPhase =
  | "idle"
  | "roulette"
  | "ringing"
  | "connecting"
  | "live"
  | "ending"
  | "ended"
  | "error";

/**
 * Explicit live-call state machine (the user's spec):
 * IDLE → RINGING → CONNECTING → CONNECTED → (CUSTOMER_SPEAKING | USER_SPEAKING
 * | INTERRUPTED) → ENDING → ENDED, with ERROR as a terminal state.
 */
export type LiveCallState =
  | "idle"
  | "ringing"
  | "connecting"
  | "connected"
  | "customer_speaking"
  | "user_speaking"
  | "interrupted"
  | "reconnecting"
  | "ending"
  | "ended"
  | "error";

export type CallOutcome =
  | "user-ended"
  | "customer-hung-up"
  | "timeout"
  | "connection-lost"
  | "error";

export type SpeakerRole = "user" | "customer";

/** Everything that defines one simulated cold call. */
export interface CallContext {
  /** The product being sold (roulette result). */
  product: string;
  /** Random customer name shown on the phone screen. */
  customerName: string;
  /** Hidden personality the customer plays — never shown during the call. */
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

/** One objection and how the salesperson handled it (AI-generated). */
export interface ObjectionHandled {
  objection: string;
  outcome: string;
  grade: "strong" | "weak" | "missed";
}

/** Post-call AI coaching report (the 8-score structure from the spec). */
export interface SalesReport {
  overall: number;
  clarity: number;
  persuasiveness: number;
  listening: number;
  objectionHandling: number;
  conversationalControl: number;
  opening: number;
  closing: number;
  verdict: string;
  bestArgument: string;
  weakestArgument: string;
  customerObjections: string[];
  objectionHandlingDetails: ObjectionHandled[];
  missedOpportunities: string[];
  betterStrategy: string;
  specificImprovements: string[];
}

export const REPORT_METRIC_LABELS = [
  "Clarity",
  "Persuasiveness",
  "Listening",
  "Objection Handling",
  "Conversational Control",
  "Opening",
  "Closing",
] as const;

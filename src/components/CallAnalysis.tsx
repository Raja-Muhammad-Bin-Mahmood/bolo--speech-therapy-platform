import { useEffect, useState } from "react";
import { motion } from "framer-motion";
import {
  CircleCheck,
  CircleAlert,
  Target,
  MessageSquare,
  Lightbulb,
  GraduationCap,
  Eye,
  Activity,
  Loader2,
  RotateCcw,
  ChevronLeft,
  TrendingUp,
  TrendingDown,
} from "lucide-react";
import type {
  CallContext,
  CallOutcome,
  SalesReport,
  TranscriptLine,
} from "../lib/closerTypes";
import { formatCallTime } from "./CallScreen";
import { reportMetrics } from "../lib/salesReport";

interface CallAnalysisProps {
  report: SalesReport | null;
  loading: boolean;
  error: string | null;
  context: CallContext;
  transcript: TranscriptLine[];
  outcome: CallOutcome | null;
  durationSec: number;
  onNewCall: () => void;
  onDashboard: () => void;
}

function ScoreRing({ score }: { score: number }) {
  const [offset, setOffset] = useState(339);
  useEffect(() => {
    const t = setTimeout(() => setOffset(339 - (339 * score) / 100), 200);
    return () => clearTimeout(t);
  }, [score]);

  return (
    <div className="relative w-36 h-36">
      <svg viewBox="0 0 120 120" className="w-full h-full -rotate-90">
        <circle
          cx="60"
          cy="60"
          r="54"
          fill="none"
          stroke="rgba(255,255,255,0.08)"
          strokeWidth="10"
        />
        <circle
          cx="60"
          cy="60"
          r="54"
          fill="none"
          stroke="url(#scoreGrad)"
          strokeWidth="10"
          strokeLinecap="round"
          strokeDasharray="339"
          strokeDashoffset={offset}
          style={{ transition: "stroke-dashoffset 1.2s cubic-bezier(0.22,1,0.36,1)" }}
        />
        <defs>
          <linearGradient id="scoreGrad" x1="0" y1="0" x2="1" y2="1">
            <stop offset="0%" stopColor="#c4b5fd" />
            <stop offset="100%" stopColor="#6d5cff" />
          </linearGradient>
        </defs>
      </svg>
      <div className="absolute inset-0 flex flex-col items-center justify-center">
        <span className="font-display text-4xl font-bold text-white">
          {score}
        </span>
        <span className="text-[10px] uppercase tracking-widest text-soft-gray/50">
          Overall
        </span>
      </div>
    </div>
  );
}

function MetricBar({ label, score, note }: { label: string; score: number; note: string }) {
  const color =
    score >= 75 ? "from-emerald-400/80 to-emerald-300/60" :
    score >= 55 ? "from-amber-400/80 to-amber-300/60" :
    "from-rose-400/80 to-rose-300/60";
  const textColor =
    score >= 75 ? "text-emerald-300" : score >= 55 ? "text-amber-300" : "text-rose-300";
  return (
    <div className="glass rounded-xl p-3">
      <div className="flex items-center justify-between mb-1.5">
        <span className="text-xs text-soft-gray">{label}</span>
        <span className={`font-mono text-sm font-bold ${textColor}`}>{score}</span>
      </div>
      <div className="h-1.5 rounded-full bg-white/5 overflow-hidden">
        <motion.div
          className={`h-full rounded-full bg-gradient-to-r ${color}`}
          initial={{ width: 0 }}
          animate={{ width: `${score}%` }}
          transition={{ duration: 1, ease: [0.22, 1, 0.36, 1], delay: 0.15 }}
        />
      </div>
      {note && <p className="text-[10px] text-soft-gray/40 mt-1.5 leading-snug">{note}</p>}
    </div>
  );
}

function Section({
  icon,
  title,
  children,
}: {
  icon: React.ReactNode;
  title: string;
  children: React.ReactNode;
}) {
  return (
    <motion.div
      initial={{ opacity: 0, y: 16 }}
      animate={{ opacity: 1, y: 0 }}
      transition={{ duration: 0.4, ease: [0.22, 1, 0.36, 1] }}
      className="glass rounded-2xl p-5"
    >
      <h3 className="flex items-center gap-2 font-heading text-sm font-semibold text-white mb-3">
        <span className="text-neon-purple">{icon}</span>
        {title}
      </h3>
      {children}
    </motion.div>
  );
}

function ObjectionRow({ o }: { o: { objection: string; outcome: string; grade: string } }) {
  const color =
    o.grade === "strong" ? "text-emerald-300" : o.grade === "weak" ? "text-amber-300" : "text-rose-300";
  return (
    <li className="text-sm text-white/85 flex items-start gap-2">
      <span className={`mt-1 shrink-0 ${color}`}>
        {o.grade === "strong" ? (
          <CircleCheck className="w-4 h-4" />
        ) : o.grade === "weak" ? (
          <CircleAlert className="w-4 h-4" />
        ) : (
          <TrendingDown className="w-4 h-4" />
        )}
      </span>
      <span>
        <span className="text-white/90 font-medium">{o.objection}</span>
        <span className="block text-xs text-soft-gray/60 mt-0.5">{o.outcome}</span>
      </span>
    </li>
  );
}

export default function CallAnalysis(props: CallAnalysisProps) {
  const { report, loading, error, context, transcript, outcome, durationSec, onNewCall, onDashboard } = props;

  if (loading || !report) {
    return (
      <div className="flex flex-col items-center justify-center min-h-[50vh] gap-4">
        <div className="relative">
          <div className="w-16 h-16 rounded-full glass flex items-center justify-center">
            <Loader2 className="w-7 h-7 text-neon-purple animate-spin" />
          </div>
          <motion.div
            className="absolute inset-0 rounded-full border border-neon-purple/30"
            animate={{ scale: [1, 1.6], opacity: [0.8, 0] }}
            transition={{ duration: 1.4, repeat: Infinity }}
            aria-hidden
          />
        </div>
        <p className="text-soft-gray text-sm">Analyzing your pitch…</p>
        <p className="text-soft-gray/40 text-xs max-w-xs text-center">
          Scoring 7 sales metrics and replaying every objection against the
          customer's hidden personality.
        </p>
      </div>
    );
  }

  const outcomeLabel: Record<string, string> = {
    "user-ended": "You ended the call",
    "customer-hung-up": "The customer hung up",
    timeout: "Time's up — 2 minutes",
    error: "Call ended with an error",
  };

  const metrics = reportMetrics(report);

  return (
    <motion.div
      initial={{ opacity: 0 }}
      animate={{ opacity: 1 }}
      className="space-y-5"
    >
      {/* Header */}
      <div className="text-center mb-2">
        <h1 className="font-heading text-3xl font-bold text-white">
          Call Report
        </h1>
        <p className="text-soft-gray mt-2 text-sm">
          {context.product} · {context.customerName} · {formatCallTime(durationSec)}{" "}
          · {outcome ? outcomeLabel[outcome] : ""}
        </p>
      </div>

      {error && (
        <div className="glass rounded-xl px-4 py-3 text-xs text-amber-200/90 text-center">
          The AI coach couldn't load — showing instant stats instead.
        </div>
      )}

      {/* Overall */}
      <div className="glass-strong rounded-3xl p-6 flex flex-col items-center gap-4 relative overflow-hidden">
        <div className="absolute -top-16 -right-16 w-48 h-48 rounded-full bg-neon-purple/15 blur-3xl pointer-events-none" />
        <ScoreRing score={report.overall} />
        <p className="text-center text-sm text-soft-gray max-w-sm">{report.verdict}</p>
      </div>

      {/* Hidden personality reveal */}
      <Section icon={<Eye className="w-4 h-4" />} title="Who you were actually talking to">
        <p className="text-sm text-white/90 leading-relaxed">
          {context.persona} — the customer played this personality for the whole call.
        </p>
      </Section>

      {/* Metrics */}
      <Section icon={<Activity className="w-4 h-4" />} title="The 7-point breakdown">
        <div className="grid sm:grid-cols-2 gap-3">
          {metrics.map((m) => (
            <MetricBar key={m.label} label={m.label} score={m.score} note={m.note} />
          ))}
        </div>
      </Section>

      {/* Best / weakest argument */}
      <div className="grid sm:grid-cols-2 gap-5">
        <Section icon={<TrendingUp className="w-4 h-4" />} title="Best argument">
          <p className="text-sm text-white/85 leading-relaxed">{report.bestArgument}</p>
        </Section>
        <Section icon={<TrendingDown className="w-4 h-4" />} title="Weakest argument">
          <p className="text-sm text-white/85 leading-relaxed">{report.weakestArgument}</p>
        </Section>
      </div>

      {/* Objections */}
      <Section icon={<MessageSquare className="w-4 h-4" />} title="Objections & how you handled them">
        {report.objectionHandlingDetails.length === 0 ? (
          <p className="text-sm text-soft-gray/60">No objections were captured this call.</p>
        ) : (
          <ul className="space-y-2">
            {report.objectionHandlingDetails.map((o, i) => (
              <ObjectionRow key={i} o={o} />
            ))}
          </ul>
        )}
      </Section>

      {/* Missed opportunities + better strategy */}
      <div className="grid sm:grid-cols-2 gap-5">
        <Section icon={<Target className="w-4 h-4" />} title="Missed opportunities">
          <ul className="space-y-2">
            {report.missedOpportunities.map((s, i) => (
              <li key={i} className="text-sm text-white/85 flex items-start gap-2">
                <span className="text-neon-purple mt-1">·</span>
                {s}
              </li>
            ))}
          </ul>
        </Section>
        <Section icon={<Lightbulb className="w-4 h-4" />} title="Better strategy">
          <p className="text-sm text-white/85 leading-relaxed">{report.betterStrategy}</p>
        </Section>
      </div>

      {/* Specific improvements */}
      <Section icon={<GraduationCap className="w-4 h-4" />} title="Specific improvements">
        <ul className="space-y-2">
          {report.specificImprovements.map((s, i) => (
            <li key={i} className="text-sm text-white/85 flex items-start gap-2">
              <Lightbulb className="w-4 h-4 text-amber-300 shrink-0 mt-0.5" />
              {s}
            </li>
          ))}
        </ul>
      </Section>

      {/* Transcript */}
      <Section icon={<Activity className="w-4 h-4" />} title="Full transcript">
        {transcript.length === 0 ? (
          <p className="text-sm text-soft-gray/60">
            No speech was captured this call — speak a little longer next round.
          </p>
        ) : (
          <div className="space-y-2.5 max-h-72 overflow-y-auto pr-1">
            {transcript.map((line, i) => (
              <div key={i} className="flex items-start gap-2">
                <span className="text-[10px] font-mono text-soft-gray/40 mt-1 w-9 shrink-0">
                  {formatCallTime(line.atSec)}
                </span>
                <span
                  className={`text-[10px] px-1.5 py-0.5 rounded shrink-0 mt-0.5 ${
                    line.role === "customer"
                      ? "bg-neon-purple/20 text-neon-purple"
                      : "bg-electric-violet/20 text-electric-violet"
                  }`}
                >
                  {line.role === "customer" ? "Customer" : "You"}
                </span>
                <p className="text-sm text-white/90 leading-relaxed">{line.text}</p>
              </div>
            ))}
          </div>
        )}
      </Section>

      {/* Actions */}
      <div className="flex flex-col sm:flex-row items-center justify-center gap-3 pt-2">
        <button
          onClick={onNewCall}
          className="flex items-center gap-2 bg-primary hover:bg-primary-hover text-white font-heading font-semibold px-7 py-3.5 rounded-full transition-all duration-200 active:scale-[0.97] neon-glow cursor-pointer"
        >
          <RotateCcw className="w-4 h-4" />
          New Call
        </button>
        <button
          onClick={onDashboard}
          className="flex items-center gap-2 glass text-soft-gray hover:text-white px-7 py-3.5 rounded-full transition-all duration-200 active:scale-[0.97] cursor-pointer"
        >
          <ChevronLeft className="w-4 h-4" />
          Back to Dashboard
        </button>
      </div>
    </motion.div>
  );
}

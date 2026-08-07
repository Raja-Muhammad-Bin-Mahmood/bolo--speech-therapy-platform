import { Link } from "react-router-dom";
import { motion, AnimatePresence } from "framer-motion";
import { PhoneCall, ChevronRight, ChevronLeft, Package } from "lucide-react";
import Navbar from "../components/Navbar";
import LiquidBackground from "../components/LiquidBackground";
import ProductRoulette from "../components/ProductRoulette";
import CallScreen from "../components/CallScreen";
import CallAnalysis from "../components/CallAnalysis";
import { useCloserCall } from "../hooks/useCloserCall";

export default function CloserMode() {
  const call = useCloserCall();

  return (
    <div className="min-h-screen relative overflow-hidden">
      <LiquidBackground />
      <div className="relative z-10">
        <Navbar />

        <main className="pt-24 pb-16 px-4 max-w-3xl mx-auto">
          <div className="mb-8">
            <Link
              to="/dashboard"
              className="inline-flex items-center gap-1 text-xs text-soft-gray/60 hover:text-white transition-colors"
            >
              <ChevronLeft className="w-3.5 h-3.5" />
              Back to Dashboard
            </Link>
          </div>

          <AnimatePresence mode="wait">
            {/* Screen 1 — intro card + START CALL */}
            {call.phase === "idle" && (
              <motion.div
                key="intro"
                initial={{ opacity: 0, y: 24 }}
                animate={{ opacity: 1, y: 0 }}
                exit={{ opacity: 0, scale: 0.96 }}
                transition={{ duration: 0.45, ease: [0.22, 1, 0.36, 1] }}
                className="flex flex-col items-center justify-center min-h-[60vh]"
              >
                <motion.div
                  animate={{ y: [0, -8, 0] }}
                  transition={{ duration: 4, repeat: Infinity, ease: "easeInOut" }}
                  className="w-20 h-20 rounded-[1.4rem] bg-gradient-to-br from-neon-purple/30 to-electric-violet/30 flex items-center justify-center neon-glow-sm mb-7"
                >
                  <PhoneCall className="w-9 h-9 text-neon-purple" />
                </motion.div>

                <h1 className="font-display text-4xl md:text-5xl font-bold text-white text-glow text-center">
                  Closer Mode
                </h1>
                <p className="text-soft-gray text-center max-w-md mt-4">
                  Practice realistic cold calls with AI customers. You sell, they
                  interrupt, object, and might hang up on you.
                </p>

                {/* Random product (empty until the roulette lands) */}
                <div className="mt-8 glass-strong rounded-2xl px-8 py-5 text-center min-w-[16rem] relative overflow-hidden">
                  <div className="absolute -top-10 -right-10 w-32 h-32 rounded-full bg-electric-violet/15 blur-3xl pointer-events-none" />
                  <div className="flex items-center justify-center gap-2 text-[10px] uppercase tracking-[0.3em] text-soft-gray/50 mb-2">
                    <Package className="w-3 h-3" />
                    Random product
                  </div>
                  <p className="font-heading text-2xl font-bold text-white">
                    {call.context ? call.context.product : "—"}
                  </p>
                </div>

                <button
                  onClick={call.beginRoulette}
                  className="group mt-8 flex items-center gap-2 bg-primary hover:bg-primary-hover text-white font-heading font-semibold px-10 py-4 rounded-full text-lg transition-all duration-200 active:scale-[0.97] neon-glow cursor-pointer"
                >
                  START CALL
                  <ChevronRight className="w-5 h-5 group-hover:translate-x-1 transition-transform" />
                </button>

                <div className="mt-8 flex flex-wrap justify-center gap-2 max-w-md">
                  {["Random product", "Realistic AI customer", "2-minute cap", "Full sales report"].map((f) => (
                    <span key={f} className="text-[10px] px-2.5 py-1 rounded-full bg-white/5 text-soft-gray/60">
                      {f}
                    </span>
                  ))}
                </div>
              </motion.div>
            )}

            {/* Screen 2 — product roulette */}
            {call.phase === "roulette" && (
              <motion.div
                key="roulette"
                initial={{ opacity: 0 }}
                animate={{ opacity: 1 }}
                exit={{ opacity: 0 }}
                transition={{ duration: 0.3 }}
              >
                <ProductRoulette onLand={call.onRouletteLand} />
              </motion.div>
            )}

            {/* Screen 3 — the phone call */}
            {(call.phase === "ringing" ||
              call.phase === "connecting" ||
              call.phase === "live") &&
              call.context && (
                <CallScreen
                  key="call"
                  phase={call.phase}
                  context={call.context}
                  elapsed={call.elapsed}
                  transcript={call.transcript}
                  customerPartial={call.customerPartial}
                  customerSpeaking={call.customerSpeaking}
                  speakingLevel={call.speakingLevel}
                  interruptedAt={call.interruptedAt}
                  liveError={call.liveError}
                  micMissing={call.micMissing}
                  sttNote={call.sttNote}
                  liveStatus={call.liveStatus}
                  onEnd={call.endCallByUser}
                />
              )}

            {/* Screen 4 — analysis */}
            {call.phase === "ended" && call.context && (
              <CallAnalysis
                key="analysis"
                report={call.report}
                loading={call.reportLoading}
                error={call.reportError}
                context={call.context}
                transcript={call.transcript}
                outcome={call.outcome}
                durationSec={call.elapsed}
                onNewCall={call.reset}
                onDashboard={() => {
                  window.location.href = "/dashboard";
                }}
              />
            )}
          </AnimatePresence>
        </main>
      </div>
    </div>
  );
}

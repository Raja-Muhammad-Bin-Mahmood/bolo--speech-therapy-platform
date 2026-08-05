import { useState } from "react";
import { motion, AnimatePresence } from "framer-motion";
import { X, Mail, Lock, User, Eye, EyeOff, Sparkles } from "lucide-react";
import { useAuth } from "../context/AuthContext";

interface AuthModalProps {
  open: boolean;
  onClose: () => void;
  /** If 'demo' is visible, show demo login option */
  allowDemo?: boolean;
}

export default function AuthModal({ open, onClose, allowDemo = true }: AuthModalProps) {
  const { signUp, signIn, demoLogin } = useAuth();
  const [mode, setMode] = useState<"login" | "signup">("login");
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [displayName, setDisplayName] = useState("");
  const [showPw, setShowPw] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    setError(null);
    setLoading(true);

    let err: string | null;
    if (mode === "login") {
      err = await signIn(email, password);
    } else {
      if (!displayName.trim()) {
        setError("Please enter your name");
        setLoading(false);
        return;
      }
      err = await signUp(email, password, displayName.trim());
    }

    setLoading(false);
    if (err) {
      setError(err);
    } else {
      onClose();
    }
  };

  const handleDemo = () => {
    demoLogin(displayName.trim() || undefined);
    onClose();
  };

  return (
    <AnimatePresence>
      {open && (
        <motion.div
          initial={{ opacity: 0 }}
          animate={{ opacity: 1 }}
          exit={{ opacity: 0 }}
          transition={{ duration: 0.2 }}
          className="fixed inset-0 z-[100] flex items-center justify-center p-4"
          onClick={onClose}
        >
          {/* Backdrop */}
          <div className="absolute inset-0 bg-deeper-space/80 backdrop-blur-sm" />

          {/* Modal */}
          <motion.div
            initial={{ opacity: 0, scale: 0.95, y: 20 }}
            animate={{ opacity: 1, scale: 1, y: 0 }}
            exit={{ opacity: 0, scale: 0.95, y: 20 }}
            transition={{ type: "spring", stiffness: 200, damping: 25 }}
            onClick={e => e.stopPropagation()}
            className="relative w-full max-w-md glass-strong rounded-3xl p-8 neon-glow overflow-hidden"
          >
            {/* Inner glow */}
            <div className="absolute -top-24 -right-24 w-48 h-48 rounded-full bg-neon-purple/5 blur-3xl pointer-events-none" />
            <div className="absolute -bottom-24 -left-24 w-48 h-48 rounded-full bg-vibrant-indigo/5 blur-3xl pointer-events-none" />

            {/* Close */}
            <button
              onClick={onClose}
              className="absolute top-4 right-4 text-soft-gray/40 hover:text-white transition-colors cursor-pointer"
            >
              <X className="w-5 h-5" />
            </button>

            {/* Header */}
            <div className="text-center mb-6 relative z-10">
              <div className="w-12 h-12 rounded-full bg-gradient-to-br from-neon-purple/20 to-vibrant-indigo/20 flex items-center justify-center mx-auto mb-3">
                <Sparkles className="w-6 h-6 text-neon-purple" />
              </div>
              <h2 className="font-heading text-xl font-bold text-white">
                {mode === "login" ? "Welcome Back" : "Join BOLO"}
              </h2>
              <p className="text-sm text-soft-gray/60 mt-1">
                {mode === "login"
                  ? "Sign in to continue your practice"
                  : "Create an account to track your progress"}
              </p>
            </div>

            {/* Form */}
            <form onSubmit={handleSubmit} className="space-y-4 relative z-10">
              {mode === "signup" && (
                <div className="relative">
                  <User className="absolute left-3.5 top-1/2 -translate-y-1/2 w-4 h-4 text-soft-gray/40" />
                  <input
                    type="text"
                    value={displayName}
                    onChange={e => setDisplayName(e.target.value)}
                    placeholder="Your name"
                    className="w-full bg-white/5 border border-white/10 rounded-xl pl-10 pr-4 py-3 text-sm text-white placeholder-soft-gray/30 outline-none focus:border-neon-purple/40 transition-colors"
                  />
                </div>
              )}

              <div className="relative">
                <Mail className="absolute left-3.5 top-1/2 -translate-y-1/2 w-4 h-4 text-soft-gray/40" />
                <input
                  type="email"
                  value={email}
                  onChange={e => setEmail(e.target.value)}
                  placeholder="Email address"
                  required
                  className="w-full bg-white/5 border border-white/10 rounded-xl pl-10 pr-4 py-3 text-sm text-white placeholder-soft-gray/30 outline-none focus:border-neon-purple/40 transition-colors"
                />
              </div>

              <div className="relative">
                <Lock className="absolute left-3.5 top-1/2 -translate-y-1/2 w-4 h-4 text-soft-gray/40" />
                <input
                  type={showPw ? "text" : "password"}
                  value={password}
                  onChange={e => setPassword(e.target.value)}
                  placeholder="Password"
                  required
                  minLength={6}
                  className="w-full bg-white/5 border border-white/10 rounded-xl pl-10 pr-10 py-3 text-sm text-white placeholder-soft-gray/30 outline-none focus:border-neon-purple/40 transition-colors"
                />
                <button
                  type="button"
                  onClick={() => setShowPw(!showPw)}
                  className="absolute right-3.5 top-1/2 -translate-y-1/2 text-soft-gray/40 hover:text-white transition-colors cursor-pointer"
                >
                  {showPw ? <EyeOff className="w-4 h-4" /> : <Eye className="w-4 h-4" />}
                </button>
              </div>

              {error && (
                <p className="text-xs text-red-400/80 text-center">{error}</p>
              )}

              <button
                type="submit"
                disabled={loading}
                className="w-full bg-primary hover:bg-primary-hover text-white font-medium py-3 rounded-xl transition-all duration-200 active:scale-[0.97] text-sm cursor-pointer disabled:opacity-50 disabled:cursor-not-allowed"
              >
                {loading
                  ? "Please wait…"
                  : mode === "login"
                  ? "Sign In"
                  : "Create Account"}
              </button>
            </form>

            {/* Toggle mode */}
            <p className="text-xs text-soft-gray/50 text-center mt-4 relative z-10">
              {mode === "login" ? "Don't have an account?" : "Already have an account?"}{" "}
              <button
                onClick={() => { setMode(mode === "login" ? "signup" : "login"); setError(null); }}
                className="text-neon-purple hover:text-neon-purple/80 transition-colors cursor-pointer"
              >
                {mode === "login" ? "Sign up" : "Log in"}
              </button>
            </p>

            {/* Demo divider */}
            {allowDemo && (
              <>
                <div className="flex items-center gap-3 my-4 relative z-10">
                  <div className="h-px flex-1 bg-white/5" />
                  <span className="text-[10px] text-soft-gray/30">or</span>
                  <div className="h-px flex-1 bg-white/5" />
                </div>
                <button
                  onClick={handleDemo}
                  className="w-full glass text-soft-gray hover:text-white text-sm font-medium py-3 rounded-xl transition-all duration-200 active:scale-[0.97] cursor-pointer relative z-10"
                >
                  Continue as Guest (Demo)
                </button>
              </>
            )}
          </motion.div>
        </motion.div>
      )}
    </AnimatePresence>
  );
}
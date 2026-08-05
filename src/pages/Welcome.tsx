import { useState, useEffect, useRef } from "react";
import { Link } from "react-router-dom";
import { ArrowRight, Sparkles, ChevronRight } from "lucide-react";
import Navbar from "../components/Navbar";
import Background from "../components/Background";
import CarouselDots from "../components/CarouselDots";
import AuthModal from "../components/AuthModal";
import { useAuth } from "../context/AuthContext";

const promptSuggestions = [
  "Give me a script for a stutter relaxation exercise",
  "Tips for managing a speech block in conversation",
  "How to practice the 'th' sound for better clarity",
  "Easy onset exercises for stuttering",
  "Pacing strategies for fluent speech",
  "Practicing the 'r' sound in everyday words",
];

export default function Welcome() {
  const { user } = useAuth();
  const [promptIndex, setPromptIndex] = useState(0);
  const [promptText, setPromptText] = useState("");
  const [displayText, setDisplayText] = useState("");
  const [isUserInteracting, setIsUserInteracting] = useState(false);
  const [authOpen, setAuthOpen] = useState(false);
  const inputRef = useRef<HTMLInputElement>(null);
  const typingRef = useRef<ReturnType<typeof setInterval> | null>(null);

  // ─── Magic Loop Auto-Type Effect ──────────────────────────────
  useEffect(() => {
    if (isUserInteracting) return;

    let currentTarget = promptSuggestions[promptIndex];
    let charIndex = 0;
    let isDeleting = false;

    const tick = () => {
      if (isUserInteracting) return;

      if (!isDeleting) {
        // Typing
        if (charIndex < currentTarget.length) {
          setDisplayText(currentTarget.slice(0, charIndex + 1));
          charIndex++;
        } else {
          // Pause, then delete
          setTimeout(() => { isDeleting = true; }, 2000);
          return;
        }
      } else {
        // Deleting
        if (charIndex > 0) {
          setDisplayText(currentTarget.slice(0, charIndex - 1));
          charIndex--;
        } else {
          isDeleting = false;
          // Move to next prompt
          setPromptIndex((prev) => (prev + 1) % promptSuggestions.length);
          currentTarget = promptSuggestions[(promptIndex + 1) % promptSuggestions.length];
          return;
        }
      }
    };

    const speed = isDeleting ? 30 : 50;
    const timer = setInterval(tick, speed);
    typingRef.current = timer;

    return () => {
      if (typingRef.current) clearInterval(typingRef.current);
    };
  }, [promptIndex, isUserInteracting]);

  // Sync promptText with displayText when user interacts
  const handleInputChange = (e: React.ChangeEvent<HTMLInputElement>) => {
    setPromptText(e.target.value);
    setDisplayText(e.target.value);
  };

  const handleInputFocus = () => {
    setIsUserInteracting(true);
    setPromptText(displayText);
  };

  const handleSubmit = () => {
    if (!user) {
      setAuthOpen(true);
    } else {
      // Navigate with the prompt
      window.location.href = `/session?prompt=${encodeURIComponent(promptText || displayText)}`;
    }
  };

  const handleKeyDown = (e: React.KeyboardEvent) => {
    if (e.key === "Enter") {
      handleSubmit();
    }
  };

  const handlePromptChange = (delta: number) => {
    const next = (promptIndex + delta + promptSuggestions.length) % promptSuggestions.length;
    setPromptIndex(next);
    setIsUserInteracting(false);
  };

  return (
    <div className="min-h-screen relative overflow-hidden">
      <Background />

      {/* Content layer */}
      <div className="relative z-10">
        <Navbar />

        {/* Hero Section */}
        <section className="flex flex-col items-center justify-center min-h-screen px-4 pt-24 pb-16 text-center">
          {/* Tagline */}
          <div className="glass rounded-full px-4 py-1.5 mb-6 inline-flex items-center gap-2 text-xs text-soft-gray animate-fade-in">
            <Sparkles className="w-3 h-3 text-neon-purple" />
            <span>AI-Powered Speech Pathology</span>
          </div>

          {/* Hero Title */}
          <h1 className="font-display text-7xl md:text-9xl lg:text-[10rem] font-bold tracking-tight text-white text-glow animate-slide-up">
            BOLO
          </h1>

          {/* Tagline */}
          <p className="text-2xl md:text-3xl font-heading font-medium text-white mt-2 animate-slide-up" style={{ animationDelay: "0.1s" }}>
            Free your voice.
          </p>

          {/* Subtitle */}
          <p className="text-soft-gray text-lg mt-3 max-w-md animate-slide-up" style={{ animationDelay: "0.2s" }}>
            Designed to help you speak — at your pace.
          </p>

          {/* CTA Buttons */}
          <div className="flex items-center gap-4 mt-8 animate-slide-up" style={{ animationDelay: "0.3s" }}>
            <Link
              to={user ? "/dashboard" : "#"}
              onClick={(e) => { if (!user) { e.preventDefault(); setAuthOpen(true); } }}
              className="group flex items-center gap-2 bg-primary hover:bg-primary-hover text-white font-medium px-6 py-3 rounded-full transition-all duration-200 active:scale-[0.97] neon-glow-sm"
            >
              Get Started
              <ArrowRight className="w-4 h-4 group-hover:translate-x-0.5 transition-transform" />
            </Link>
            <a href="#features" className="glass text-soft-gray hover:text-white font-medium px-6 py-3 rounded-full transition-all duration-200 active:scale-[0.97]">
              Learn More
            </a>
          </div>

          {/* Subtext */}
          <p className="text-sm text-soft-gray/60 mt-4 animate-slide-up" style={{ animationDelay: "0.4s" }}>
            Ask BOLO anything about your speech…
          </p>

          {/* Interactive "Ask BOLO" Input Bar */}
          <div className="mt-10 w-full max-w-lg animate-slide-up" style={{ animationDelay: "0.5s" }}>
            <div className="glass-strong rounded-2xl p-6 neon-glow relative overflow-hidden">
              {/* Inner glow */}
              <div className="absolute -top-20 -left-20 w-40 h-40 rounded-full bg-neon-purple/10 blur-3xl pointer-events-none" />
              <div className="absolute -bottom-20 -right-20 w-40 h-40 rounded-full bg-vibrant-indigo/10 blur-3xl pointer-events-none" />

              {/* Prompt Input */}
              <div className="relative flex items-center gap-3">
                <div className="flex-1 relative">
                  <input
                    ref={inputRef}
                    type="text"
                    value={isUserInteracting ? promptText : displayText}
                    onChange={handleInputChange}
                    onFocus={handleInputFocus}
                    onKeyDown={handleKeyDown}
                    className="w-full bg-white/5 border border-white/5 rounded-xl px-4 py-3 text-white text-lg placeholder-soft-gray/30 font-light outline-none focus:border-neon-purple/30 transition-all"
                    placeholder="Ask BOLO anything..."
                  />
                  {/* Blinking cursor (only during auto-type) */}
                  {!isUserInteracting && (
                    <span className="absolute right-4 top-1/2 -translate-y-1/2 w-[2px] h-5 bg-neon-purple/60 animate-pulse" />
                  )}
                </div>
                <button
                  onClick={handleSubmit}
                  className="shrink-0 w-10 h-10 rounded-full bg-primary hover:bg-primary-hover flex items-center justify-center transition-all duration-200 active:scale-[0.93] cursor-pointer"
                >
                  <ArrowRight className="w-4 h-4 text-white" />
                </button>
              </div>

              {/* Divider */}
              <div className="h-px bg-gradient-to-r from-transparent via-white/10 to-transparent my-4" />

              {/* Carousel arrows */}
              <div className="flex items-center justify-between">
                <button
                  onClick={() => handlePromptChange(-1)}
                  className="text-soft-gray/40 hover:text-white transition-colors p-1"
                  aria-label="Previous prompt"
                >
                  <ChevronRight className="w-4 h-4 rotate-180" />
                </button>
                <CarouselDots total={promptSuggestions.length} active={promptIndex} />
                <button
                  onClick={() => handlePromptChange(1)}
                  className="text-soft-gray/40 hover:text-white transition-colors p-1"
                  aria-label="Next prompt"
                >
                  <ChevronRight className="w-4 h-4" />
                </button>
              </div>
            </div>
          </div>
        </section>

        {/* Features Section */}
        <section id="features" className="px-4 pb-24 max-w-5xl mx-auto">
          <div className="text-center mb-12">
            <h2 className="font-heading text-3xl md:text-4xl font-bold text-white">
              How BOLO Works
            </h2>
            <p className="text-soft-gray mt-3 max-w-md mx-auto">
              Three practice modes designed by Speech-Language Pathologists.
            </p>
          </div>

          <div className="grid md:grid-cols-3 gap-6">
            {[
              {
                title: "Unprompted",
                desc: "1-minute spontaneous speaking on AI-generated topics. Real-time waveform feedback.",
                color: "from-neon-purple/20 to-vibrant-indigo/20",
              },
              {
                title: "Script",
                desc: "Read targeted text with SLP phonetic annotations. Perfect for structured practice.",
                color: "from-electric-violet/20 to-neon-indigo/20",
              },
              {
                title: "Debate",
                desc: "AI conversational debate designed to gently exercise stumble words.",
                color: "from-vibrant-indigo/20 to-neon-purple/20",
              },
            ].map((card, i) => (
              <div
                key={card.title}
                className="glass rounded-2xl p-6 transition-all duration-300 hover:translate-y-[-2px] hover:neon-glow-sm group"
                style={{ animationDelay: `${0.1 * i}s` }}
              >
                <div
                  className={`w-10 h-10 rounded-lg bg-gradient-to-br ${card.color} mb-4 flex items-center justify-center`}
                >
                  <div className="w-3 h-3 rounded-full bg-neon-purple/60" />
                </div>
                <h3 className="font-heading text-lg font-semibold text-white mb-2">
                  {card.title}
                </h3>
                <p className="text-sm text-soft-gray leading-relaxed">
                  {card.desc}
                </p>
              </div>
            ))}
          </div>
        </section>

        {/* Footer */}
        <footer className="border-t border-white/5 py-8 px-4">
          <div className="max-w-5xl mx-auto flex flex-col md:flex-row items-center justify-between gap-4">
            <p className="text-sm text-soft-gray/40">
              © 2025 BOLO — Free your voice.
            </p>
            <div className="flex items-center gap-6 text-xs text-soft-gray/40">
              <span>Privacy</span>
              <span>Terms</span>
              <span>Contact</span>
            </div>
          </div>
        </footer>
      </div>

      <AuthModal open={authOpen} onClose={() => setAuthOpen(false)} allowDemo />
    </div>
  );
}
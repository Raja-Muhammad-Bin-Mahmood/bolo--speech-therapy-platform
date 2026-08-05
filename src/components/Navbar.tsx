import { useState } from "react";
import { Link, useLocation } from "react-router-dom";
import { Mic, Flame, LogOut, User } from "lucide-react";
import { motion } from "framer-motion";
import { useAuth } from "../context/AuthContext";
import AuthModal from "./AuthModal";

const navLinks = [
  { label: "Features", href: "#features" },
  { label: "Resources", href: "#resources" },
  { label: "About", href: "#about" },
];

const appLinks = [
  { label: "Dashboard", href: "/dashboard" },
  { label: "Practice", href: "/session" },
  { label: "Analysis", href: "/analysis" },
];

export default function Navbar() {
  const location = useLocation();
  const isHome = location.pathname === "/";
  const { user, isLocal, streak, signOut } = useAuth();
  const [authOpen, setAuthOpen] = useState(false);

  const displayName = user
    ? isLocal
      ? (user as any).displayName || "Demo User"
      : (user as any).user_metadata?.display_name || (user as any).email?.split("@")[0] || "User"
    : null;

  return (
    <>
      <nav className="fixed top-0 left-0 right-0 z-50 flex justify-center pt-4 px-4">
        <motion.div
          initial={{ y: -20, opacity: 0 }}
          animate={{ y: 0, opacity: 1 }}
          transition={{ duration: 0.5, ease: [0.22, 1, 0.36, 1] }}
          className="glass rounded-full px-5 py-2.5 flex items-center gap-4 md:gap-8 max-w-[800px] w-full shadow-[0_8px_32px_rgba(0,0,0,0.4)] border border-white/[0.08]"
        >
          {/* Logo */}
          <Link
            to="/"
            className="flex items-center gap-2 font-display text-xl font-bold tracking-tight text-white group"
          >
            <div className="relative">
              <Mic className="w-5 h-5 text-electric-violet group-hover:text-neon-purple transition-colors duration-300" />
              <div className="absolute -inset-2 rounded-full bg-neon-purple/0 group-hover:bg-neon-purple/10 transition-all duration-500 blur-md" />
            </div>
            <span className="group-hover:text-glow-strong transition-all duration-500">
              BOLO
            </span>
          </Link>

          {/* Nav links */}
          {isHome ? (
            <div className="hidden md:flex items-center gap-5 text-sm text-soft-gray">
              {navLinks.map((link) => (
                <a
                  key={link.label}
                  href={link.href}
                  className="hover:text-white transition-colors duration-200"
                >
                  {link.label}
                </a>
              ))}
            </div>
          ) : (
            <div className="hidden md:flex items-center gap-1 text-sm text-soft-gray bg-white/[0.03] rounded-full p-0.5">
              {appLinks.map((link) => {
                const isActive = location.pathname === link.href ||
                  (link.href !== "/dashboard" && location.pathname.startsWith(link.href));
                return (
                  <Link
                    key={link.label}
                    to={link.href}
                    className={`px-3 py-1.5 rounded-full transition-all duration-200 ${
                      isActive
                        ? "bg-primary/20 text-white font-medium"
                        : "text-soft-gray/60 hover:text-white"
                    }`}
                  >
                    {link.label}
                  </Link>
                );
              })}
            </div>
          )}

          {/* Spacer */}
          <div className="flex-1" />

          {/* Auth area */}
          <div className="flex items-center gap-2">
            {user ? (
              <>
                {/* Streak badge */}
                {streak > 0 && (
                  <div className="hidden sm:flex items-center gap-1 text-xs text-amber-400/80 bg-amber-400/10 px-2 py-1 rounded-full">
                    <Flame className="w-3 h-3" />
                    <span>{streak}</span>
                  </div>
                )}

                {/* User avatar */}
                <div className="flex items-center gap-2 text-xs text-soft-gray/60">
                  <div className="w-6 h-6 rounded-full bg-gradient-to-br from-neon-purple to-vibrant-indigo flex items-center justify-center">
                    <User className="w-3 h-3 text-white" />
                  </div>
                  <span className="hidden sm:inline max-w-[80px] truncate">{displayName}</span>
                </div>

                <button
                  onClick={signOut}
                  className="p-1.5 text-soft-gray/40 hover:text-white transition-colors cursor-pointer"
                  title="Sign out"
                >
                  <LogOut className="w-3.5 h-3.5" />
                </button>
              </>
            ) : (
              <>
                <button
                  onClick={() => setAuthOpen(true)}
                  className="hidden sm:block text-sm text-soft-gray hover:text-white px-3 py-1.5 transition-colors duration-200 cursor-pointer"
                >
                  Log In
                </button>
                {isHome ? (
                  <button
                    onClick={() => setAuthOpen(true)}
                    className="text-sm font-medium bg-primary hover:bg-primary-hover text-white px-4 py-1.5 rounded-full transition-all duration-200 active:scale-[0.97] neon-glow-sm cursor-pointer"
                  >
                    Get Started
                  </button>
                ) : (
                  <Link
                    to="/dashboard"
                    className="text-sm font-medium bg-primary hover:bg-primary-hover text-white px-4 py-1.5 rounded-full transition-all duration-200 active:scale-[0.97] neon-glow-sm"
                  >
                    Dashboard
                  </Link>
                )}
              </>
            )}
          </div>
        </motion.div>
      </nav>

      <AuthModal open={authOpen} onClose={() => setAuthOpen(false)} allowDemo />
    </>
  );
}
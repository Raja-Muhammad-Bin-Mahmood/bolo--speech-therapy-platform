/**
 * BOLO — PulseDots
 *
 * Subtle pulsing ellipsis shown at the transcript cursor while an event is
 * OPEN/WAITING — "BOLO is actively analyzing this struggle". Disappears the
 * moment the event resolves (word anchored or fallback done). Respects
 * prefers-reduced-motion.
 */
export default function PulseDots({ title }: { title?: string }) {
  return (
    <span
      className="inline-flex items-center gap-0.5 align-middle mx-0.5 select-none"
      title={title ?? "BOLO is analyzing…"}
      aria-label="Analyzing speech"
      role="status"
    >
      <span className="w-1 h-1 rounded-full bg-neon-purple/70 animate-bounce motion-reduce:animate-none motion-reduce:opacity-60" style={{ animationDelay: "0ms" }} />
      <span className="w-1 h-1 rounded-full bg-neon-purple/70 animate-bounce motion-reduce:animate-none motion-reduce:opacity-60" style={{ animationDelay: "140ms" }} />
      <span className="w-1 h-1 rounded-full bg-neon-purple/70 animate-bounce motion-reduce:animate-none motion-reduce:opacity-60" style={{ animationDelay: "280ms" }} />
    </span>
  );
}

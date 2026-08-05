interface CarouselDotsProps {
  total: number;
  active: number;
  className?: string;
}

export default function CarouselDots({
  total,
  active,
  className = "",
}: CarouselDotsProps) {
  return (
    <div className={`flex items-center justify-center gap-2 ${className}`}>
      {Array.from({ length: total }, (_, i) => (
        <div
          key={i}
          className={`rounded-full transition-all duration-300 ${
            i === active
              ? "w-6 h-1.5 bg-neon-purple"
              : "w-1.5 h-1.5 bg-white/20"
          }`}
        />
      ))}
    </div>
  );
}
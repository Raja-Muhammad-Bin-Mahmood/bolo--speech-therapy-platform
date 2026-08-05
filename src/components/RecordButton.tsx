import { useState, useEffect } from "react";
import { Mic, Square } from "lucide-react";

interface RecordButtonProps {
  onStart?: () => void;
  onStop?: () => void;
  size?: "sm" | "md" | "lg";
  disabled?: boolean;
}

export default function RecordButton({
  onStart,
  onStop,
  size = "lg",
  disabled = false,
}: RecordButtonProps) {
  const [isRecording, setIsRecording] = useState(false);

  useEffect(() => {
    return () => {
      setIsRecording(false);
    };
  }, []);

  const handleClick = () => {
    if (disabled) return;
    if (isRecording) {
      setIsRecording(false);
      onStop?.();
    } else {
      setIsRecording(true);
      onStart?.();
    }
  };

  const sizeMap = {
    sm: "w-12 h-12",
    md: "w-16 h-16",
    lg: "w-20 h-20",
  };

  const iconMap = {
    sm: "w-5 h-5",
    md: "w-6 h-6",
    lg: "w-8 h-8",
  };

  return (
    <button
      onClick={handleClick}
      disabled={disabled}
      className={`${sizeMap[size]} rounded-full flex items-center justify-center transition-all duration-300 active:scale-[0.93] relative ${
        disabled ? "opacity-40 cursor-not-allowed" : "cursor-pointer"
      }`}
      aria-label={isRecording ? "Stop recording" : "Start recording"}
    >
      {/* Outer glow ring */}
      <div
        className={`absolute inset-0 rounded-full transition-all duration-500 ${
          isRecording
            ? "bg-red-500/20 animate-pulse shadow-[0_0_30px_rgba(255,80,80,0.4)]"
            : "bg-neon-indigo/20 shadow-[0_0_20px_rgba(109,86,255,0.3)]"
        }`}
      />

      {/* Inner button */}
      <div
        className={`absolute inset-1 rounded-full flex items-center justify-center transition-all duration-300 ${
          isRecording
            ? "bg-gradient-to-br from-red-500 to-red-600"
            : "bg-gradient-to-br from-neon-indigo to-primary hover:from-primary hover:to-electric-violet"
        }`}
      >
        {isRecording ? (
          <Square className={`${iconMap[size]} text-white fill-white`} />
        ) : (
          <Mic className={`${iconMap[size]} text-white`} />
        )}
      </div>
    </button>
  );
}
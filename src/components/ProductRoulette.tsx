import { useEffect, useRef, useState } from "react";
import { motion } from "framer-motion";
import { ShoppingBag, Loader2 } from "lucide-react";
import { PRODUCTS, pickProduct } from "../data/closerCatalog";

const SPIN_MS = 2500;

/**
 * Slot-machine product randomizer. Rapidly cycles products (~20/s),
 * gradually slowing down, then lands on a fresh random product.
 */
export default function ProductRoulette({
  onLand,
}: {
  onLand: (product: string) => void;
}) {
  const [current, setCurrent] = useState(PRODUCTS[0]);
  const doneRef = useRef(false);

  useEffect(() => {
    const start = performance.now();
    let timer: ReturnType<typeof setTimeout> | null = null;

    const tick = () => {
      if (doneRef.current) return;
      const t = (performance.now() - start) / SPIN_MS;
      if (t >= 1) {
        doneRef.current = true;
        onLand(pickProduct());
        return;
      }
      setCurrent(PRODUCTS[Math.floor(Math.random() * PRODUCTS.length)]);
      // Ease-out: interval grows from ~45ms (fast blur) to ~295ms (settling).
      const eased = 1 - Math.pow(1 - t, 3);
      timer = setTimeout(tick, 45 + eased * 250);
    };

    timer = setTimeout(tick, 16);
    return () => {
      if (timer) clearTimeout(timer);
    };
  }, [onLand]);

  return (
    <div className="relative flex flex-col items-center justify-center min-h-[60vh] px-6">
      <motion.div
        initial={{ opacity: 0, scale: 0.92 }}
        animate={{ opacity: 1, scale: 1 }}
        transition={{ duration: 0.4, ease: [0.22, 1, 0.36, 1] }}
        className="text-center"
      >
        <div className="mx-auto w-16 h-16 rounded-2xl bg-gradient-to-br from-neon-purple/30 to-electric-violet/30 flex items-center justify-center mb-6 neon-glow-sm">
          <ShoppingBag className="w-8 h-8 text-neon-purple" />
        </div>

        <p className="text-[10px] uppercase tracking-[0.35em] text-soft-gray/60 mb-3">
          Now selling
        </p>

        <div className="h-24 flex items-center justify-center overflow-hidden">
          <motion.div
            key={current}
            initial={{ y: 42, opacity: 0, filter: "blur(8px)" }}
            animate={{ y: 0, opacity: 1, filter: "blur(0px)" }}
            transition={{ duration: 0.08 }}
            className="font-display text-4xl md:text-6xl font-bold text-white text-glow px-2"
          >
            {current}
          </motion.div>
        </div>

        <p className="mt-5 text-sm text-soft-gray/50">Picking your product…</p>
        <div className="flex items-center justify-center gap-2 mt-2 text-neon-purple/70 text-xs">
          <Loader2 className="w-3.5 h-3.5 animate-spin" />
          Randomizing
        </div>
      </motion.div>
    </div>
  );
}

"use client";

import { cn } from "@/lib/utils";
import { motion } from "motion/react";
import type { CSSProperties, ElementType } from "react";
import { memo, useEffect, useMemo, useRef, useState } from "react";

const motionElements = {
  p: motion.p,
  span: motion.span,
  div: motion.div,
} as const;

export interface TextShimmerProps {
  children: string;
  as?: keyof typeof motionElements;
  className?: string;
  duration?: number;
  spread?: number;
}

const ShimmerComponent = ({
  children,
  as = "p",
  className,
  duration = 2,
  spread = 2,
}: TextShimmerProps) => {
  const dynamicSpread = useMemo(
    () => (children?.length ?? 0) * spread,
    [children, spread]
  );

  const MotionComponent = motionElements[as] ?? motion.p;

  return (
    <MotionComponent
      animate={{ backgroundPosition: "0% center" }}
      className={cn(
        "relative inline-block bg-[length:250%_100%,auto] bg-clip-text text-transparent",
        "[--bg:linear-gradient(90deg,#0000_calc(50%-var(--spread)),var(--color-background),#0000_calc(50%+var(--spread)))] [background-repeat:no-repeat,padding-box]",
        className
      )}
      initial={{ backgroundPosition: "100% center" }}
      style={
        {
          "--spread": `${dynamicSpread}px`,
          backgroundImage:
            "var(--bg), linear-gradient(var(--color-muted-foreground), var(--color-muted-foreground))",
        } as CSSProperties
      }
      transition={{
        duration,
        ease: "linear",
        // Loop the shimmer sweep forever. `repeatType: "loop"` keeps the
        // background-position sweep continuous (no reverse/ease-out bounce).
        repeatType: "loop",
        repeat: Infinity,
      }}
    >
      {children}
    </MotionComponent>
  );
};

export const Shimmer = memo(ShimmerComponent);

export interface RotatingShimmerProps extends Omit<TextShimmerProps, "children"> {
  /**
   * Phrases shown one at a time, cycling on `intervalMs`. Gives an idle
   * "warming up" state a sense of activity without the literal bouncing dots.
   * When a single phrase is supplied, it is shown statically (no timer).
   */
  phrases: string[];
  /** Milliseconds each phrase is displayed before rotating to the next. */
  intervalMs?: number;
}

/**
 * Rotates through `phrases` on an interval, each rendered through `Shimmer`.
 *
 * The phrase text lives in element state rather than `Shimmer`'s props so the
 * shimmer sweep animation (driven by the motion element, not its children) is
 * never restarted when the text changes — only the visible string swaps.
 */
export function RotatingShimmer({
  phrases,
  intervalMs = 2400,
  ...shimmerProps
}: RotatingShimmerProps) {
  const stablePhrases = useMemo(
    () => (phrases.length > 0 ? phrases : ["…"]),
    [phrases]
  );
  const [index, setIndex] = useState(0);
  const indexRef = useRef(0);

  useEffect(() => {
    if (stablePhrases.length <= 1) return;
    const timer = setInterval(() => {
      indexRef.current = (indexRef.current + 1) % stablePhrases.length;
      setIndex(indexRef.current);
    }, intervalMs);
    return () => clearInterval(timer);
  }, [stablePhrases, intervalMs]);

  return <Shimmer {...shimmerProps}>{stablePhrases[index]}</Shimmer>;
}

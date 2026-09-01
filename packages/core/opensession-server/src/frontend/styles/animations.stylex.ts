import * as stylex from "@stylexjs/stylex";

const spin = stylex.keyframes({ to: { transform: "rotate(360deg)" } });
const pulse = stylex.keyframes({ "50%": { opacity: 0.5 } });

export const motionStyles = stylex.create({
  spin: {
    animationName: spin,
    animationDuration: "1s",
    animationTimingFunction: "linear",
    animationIterationCount: "infinite",
  },
  pulse: {
    animationName: pulse,
    animationDuration: "2s",
    animationTimingFunction: "cubic-bezier(0.4, 0, 0.6, 1)",
    animationIterationCount: "infinite",
  },
});

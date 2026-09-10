import type { ViewerInput } from "../../simulator-portal/protocol";

/** Account for object-contain letterboxing before mapping to device points. */
export function simulatorPointer(input: {
  clientX: number;
  clientY: number;
  rect: { left: number; top: number; width: number; height: number };
  width: number;
  height: number;
}): { x: number; y: number } | null {
  const { rect, width, height } = input;
  const scale = Math.min(rect.width / width, rect.height / height);
  if (!Number.isFinite(scale) || scale <= 0) return null;
  const x =
    (input.clientX - rect.left - (rect.width - width * scale) / 2) /
    (width * scale);
  const y =
    (input.clientY - rect.top - (rect.height - height * scale) / 2) /
    (height * scale);
  return x >= 0 && x <= 1 && y >= 0 && y <= 1 ? { x, y } : null;
}

export function simulatorGesture(
  start: { x: number; y: number; time: number },
  end: { x: number; y: number },
  now: number,
): ViewerInput {
  if (Math.hypot(end.x - start.x, end.y - start.y) < 0.01)
    return { type: "tap", x: end.x, y: end.y };
  return {
    type: "swipe",
    x: start.x,
    y: start.y,
    endX: end.x,
    endY: end.y,
    duration: Math.max(0.05, Math.min(2, (now - start.time) / 1_000)),
  };
}

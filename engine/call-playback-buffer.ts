export function adaptivePlaybackPrebufferMs(
  frameDurationMs: number,
  arrivalDeltasMs: readonly number[],
): number {
  const frameMs = Number.isFinite(frameDurationMs) && frameDurationMs > 0
    ? frameDurationMs
    : 20;
  const deltas = arrivalDeltasMs
    .filter((value) => Number.isFinite(value) && value > 0 && value < 1_000)
    .slice(-12)
    .sort((a, b) => a - b);
  const cadenceMs = deltas.length ? percentile(deltas, 0.5) : frameMs;
  const deviations = deltas
    .map((value) => Math.abs(value - cadenceMs))
    .sort((a, b) => a - b);
  const jitterMs = deviations.length ? percentile(deviations, 0.9) : 0;

  // Two packets of headroom is enough on stable links; bursty links earn more
  // automatically. Bounds are generic safety limits, not per-device tuning.
  const target = Math.max(frameMs * 2, cadenceMs * 2) + jitterMs * 3;
  return Math.round(clamp(target, 40, 240) / 10) * 10;
}

function percentile(sorted: readonly number[], q: number): number {
  if (!sorted.length) return 0;
  const index = Math.max(0, Math.min(sorted.length - 1, Math.ceil(sorted.length * q) - 1));
  return sorted[index] ?? 0;
}

function clamp(value: number, min: number, max: number): number {
  return Math.min(max, Math.max(min, value));
}

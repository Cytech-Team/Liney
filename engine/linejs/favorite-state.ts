/** Resolve the favorite timestamp without treating omitted API fields as an unfavorite. */
export function resolveFavoriteTime(
  remoteValue: unknown,
  cachedValue: unknown,
): number {
  if (remoteValue === undefined || remoteValue === null) {
    const cached = Number(cachedValue ?? 0);
    return Number.isFinite(cached) && cached > 0 ? cached : 0;
  }
  const remote = Number(remoteValue);
  return Number.isFinite(remote) && remote > 0 ? remote : 0;
}

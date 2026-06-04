/** Returns ms until the 3h45m warning and the hard auto-stop (spec §5 hard caps). */
export function capTimings(maxSessionHours: number): { warnAfterMs: number; stopAfterMs: number } {
  const stopAfterMs = maxSessionHours * 3600 * 1000;
  const warnAfterMs = Math.max(stopAfterMs - 15 * 60 * 1000, 0); // 15 min before the cap (3h45m for 4h)
  return { warnAfterMs, stopAfterMs };
}

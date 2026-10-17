/**
 * Reads an integer setting from the environment and refuses to start on a bad
 * value. A typo in a host's variables (HISTORY_SAMPLE_INTERVAL_MS=5m, say)
 * would otherwise turn into NaN and fail silently: setInterval(NaN) fires about
 * every millisecond and hammers the RPC, and a NaN retention makes every
 * history request answer 400.
 *
 * @param {string} name Environment variable name.
 * @param {number} fallback Used when the variable is unset or empty.
 * @param {{ min: number, max: number }} range Inclusive bounds.
 */
export function intEnv(name, fallback, { min, max }) {
  const raw = process.env[name];
  if (raw === undefined || raw.trim() === "") return fallback;
  const value = Number(raw);
  if (!Number.isInteger(value) || value < min || value > max) {
    throw new Error(`${name} must be an integer between ${min} and ${max}, got "${raw}"`);
  }
  return value;
}

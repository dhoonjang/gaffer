export const START_MAX_WALLET = 10_000_000;
const WALLET_STEP = 10_000;

export function clampStartingWallet(raw = 0): number {
  if (!Number.isFinite(raw)) return 0;
  return Math.round(Math.max(0, Math.min(START_MAX_WALLET, raw)) / WALLET_STEP) * WALLET_STEP;
}

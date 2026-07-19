/**
 * Sleep prediction ("SweetSpot"-style) engine.
 *
 * Predicts the optimal window for a baby's next sleep (nap or bedtime) from
 * their logged sleep history, blended with age-appropriate wake-window norms.
 *
 * The module is intentionally free of any framework/database/Prisma imports so
 * the logic can be unit-tested in isolation. All times are epoch milliseconds
 * (absolute UTC instants); wake-window math is therefore timezone-agnostic. A
 * `timeZone` is only used to bucket sleeps into local calendar days for
 * nap counting and nap-vs-bedtime detection.
 */

export type SleepKind = 'NAP' | 'NIGHT_SLEEP';

export interface SleepSample {
  /** Sleep start (epoch ms). */
  start: number;
  /** Sleep end (epoch ms), or null when the sleep is still ongoing. */
  end: number | null;
  type: SleepKind;
}

export type SleepPredictionConfidence = 'low' | 'medium' | 'high';

export interface SleepPredictionResult {
  state: 'prediction';
  /** Whether the next sleep is expected to be a nap or the night's bedtime. */
  kind: 'nap' | 'bedtime';
  /** Optimal window bounds (epoch ms). */
  windowStart: number;
  windowEnd: number;
  /** Window midpoint — the single best estimate (epoch ms). */
  center: number;
  /** Where `now` sits relative to the window. */
  status: 'upcoming' | 'now' | 'overdue';
  /** Minutes from now until the window opens (<= 0 once inside/after it). */
  minutesUntilStart: number;
  confidence: SleepPredictionConfidence;
  /** Start of the current wake period (most recent sleep end, epoch ms). */
  lastWakeAt: number;
  basis: {
    /** Number of personal wake-window samples used. */
    sampleCount: number;
    /** Wake window actually applied (minutes). */
    predictedWakeWindowMinutes: number;
    /** Age-based baseline wake window (minutes). */
    baselineWakeWindowMinutes: number;
    source: 'age-based' | 'blended' | 'personalized';
  };
}

export type SleepPrediction =
  | SleepPredictionResult
  | { state: 'asleep'; since: number }
  | { state: 'insufficient' };

export interface PredictionTuning {
  /** How many days of history to personalize from. */
  historyDays: number;
  /** Shrinkage prior strength: personal weight = n / (n + priorStrength). */
  priorStrength: number;
  /** Minimum / maximum / fallback half-width of the window (minutes). */
  minHalfWidthMin: number;
  maxHalfWidthMin: number;
  defaultHalfWidthMin: number;
}

export const DEFAULT_TUNING: PredictionTuning = {
  historyDays: 14,
  priorStrength: 5,
  minHalfWidthMin: 10,
  maxHalfWidthMin: 30,
  defaultHalfWidthMin: 20,
};

export interface PredictNextSleepInput {
  sleeps: SleepSample[];
  /** Current instant (epoch ms). */
  now: number;
  /** Baby age in months (fractional allowed). */
  ageMonths: number;
  /** IANA timezone used to bucket sleeps into local days (e.g. 'America/New_York'). */
  timeZone: string;
  /** Optional tuning overrides (primarily for tests). */
  options?: Partial<PredictionTuning>;
}

const MINUTE_MS = 60_000;
const DAY_MS = 24 * 60 * MINUTE_MS;
/** Average month length in ms — good enough for age-bracket selection. */
const MONTH_MS = 30.4375 * DAY_MS;

/** Baby age in months from birth date and reference instant (both epoch ms). */
export function ageInMonths(birthDateMs: number, nowMs: number): number {
  return Math.max(0, (nowMs - birthDateMs) / MONTH_MS);
}

/**
 * Age-appropriate average wake window in minutes. Based on widely used
 * pediatric wake-window guidance; blended with the child's own data downstream.
 */
export function ageBaselineWakeWindowMinutes(ageMonths: number): number {
  if (ageMonths < 1) return 50;
  if (ageMonths < 2) return 65;
  if (ageMonths < 3) return 80;
  if (ageMonths < 4) return 95;
  if (ageMonths < 5) return 110;
  if (ageMonths < 7) return 135;
  if (ageMonths < 10) return 165;
  if (ageMonths < 14) return 205;
  if (ageMonths < 18) return 255;
  if (ageMonths < 36) return 300;
  return 345;
}

/** Typical number of naps per day for the given age (used to detect bedtime). */
export function expectedNapsPerDay(ageMonths: number): number {
  if (ageMonths < 3) return 5;
  if (ageMonths < 4) return 4;
  if (ageMonths < 6) return 3;
  if (ageMonths < 8) return 3;
  if (ageMonths < 15) return 2;
  return 1;
}

function mean(xs: number[]): number {
  if (xs.length === 0) return 0;
  return xs.reduce((a, b) => a + b, 0) / xs.length;
}

function stdDev(xs: number[]): number {
  if (xs.length < 2) return 0;
  const m = mean(xs);
  const variance = xs.reduce((a, b) => a + (b - m) * (b - m), 0) / (xs.length - 1);
  return Math.sqrt(variance);
}

function clamp(value: number, lo: number, hi: number): number {
  return Math.min(hi, Math.max(lo, value));
}

/**
 * Valid wake windows (minutes) between consecutive completed sleeps. A wake
 * window must be positive and no longer than `capMinutes` (which filters out
 * gaps created by missing logs).
 */
export function computeWakeWindows(sleeps: SleepSample[], capMinutes: number): number[] {
  const completed = sleeps
    .filter((s) => s.end != null)
    .sort((a, b) => a.start - b.start);
  const windows: number[] = [];
  for (let i = 0; i < completed.length - 1; i++) {
    const gapMin = (completed[i + 1].start - (completed[i].end as number)) / MINUTE_MS;
    if (gapMin > 0 && gapMin <= capMinutes) windows.push(gapMin);
  }
  return windows;
}

/** Local calendar-day key (YYYY-MM-DD) for an instant in the given timezone. */
export function localDayKey(ms: number, timeZone: string): string {
  const parts = new Intl.DateTimeFormat('en-US', {
    timeZone,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
  }).formatToParts(new Date(ms));
  const get = (type: string) => parts.find((p) => p.type === type)?.value ?? '';
  return `${get('year')}-${get('month')}-${get('day')}`;
}

/**
 * Predict the optimal window for the next sleep.
 *
 * Returns `{ state: 'asleep' }` while a sleep is ongoing, `{ state:
 * 'insufficient' }` when there is no completed sleep to anchor from, otherwise a
 * full prediction result.
 */
export function predictNextSleep(input: PredictNextSleepInput): SleepPrediction {
  const tuning: PredictionTuning = { ...DEFAULT_TUNING, ...input.options };
  const { sleeps, now, ageMonths, timeZone } = input;

  if (!sleeps || sleeps.length === 0) return { state: 'insufficient' };

  // Currently asleep — no "next sleep" to predict yet.
  const ongoing = sleeps.find((s) => s.end == null);
  if (ongoing) return { state: 'asleep', since: ongoing.start };

  const completed = sleeps
    .filter((s) => s.end != null)
    .sort((a, b) => (a.end as number) - (b.end as number));
  if (completed.length === 0) return { state: 'insufficient' };

  const lastWakeAt = completed[completed.length - 1].end as number;

  const baseline = ageBaselineWakeWindowMinutes(ageMonths);
  const capMinutes = Math.max(360, baseline * 2.5);

  // Personalize from recent history.
  const historyStart = now - tuning.historyDays * DAY_MS;
  const recent = sleeps.filter((s) => s.end != null && (s.end as number) >= historyStart);
  const windows = computeWakeWindows(recent, capMinutes);
  const sampleCount = windows.length;
  const personalMean = sampleCount > 0 ? mean(windows) : baseline;
  const personalStd = stdDev(windows);

  // Shrink personal estimate toward the age baseline by sample size.
  const personalWeight = sampleCount / (sampleCount + tuning.priorStrength);
  const blended = personalWeight * personalMean + (1 - personalWeight) * baseline;

  // Count naps already taken today (local day) to place us in the day.
  const todayKey = localDayKey(now, timeZone);
  const napsToday = sleeps.filter(
    (s) => s.type === 'NAP' && s.end != null && localDayKey(s.start, timeZone) === todayKey,
  ).length;
  const expectedNaps = expectedNapsPerDay(ageMonths);

  // Nap vs bedtime: once the day's naps are used up, the next sleep is bedtime.
  const isBedtime = napsToday >= expectedNaps;
  const kind: 'nap' | 'bedtime' = isBedtime ? 'bedtime' : 'nap';

  // Wake windows grow across the day; the pre-bedtime one is the longest.
  let positionFactor: number;
  if (isBedtime) {
    positionFactor = 1.25;
  } else {
    const denom = Math.max(1, expectedNaps - 1);
    positionFactor = 0.9 + 0.25 * clamp(napsToday / denom, 0, 1); // 0.90 -> 1.15
  }

  const predictedWakeWindow = clamp(blended * positionFactor, 20, capMinutes);

  const center = lastWakeAt + predictedWakeWindow * MINUTE_MS;
  const halfWidthMin = clamp(
    personalStd > 0 ? personalStd : tuning.defaultHalfWidthMin,
    tuning.minHalfWidthMin,
    tuning.maxHalfWidthMin,
  );
  const windowStart = center - halfWidthMin * MINUTE_MS;
  const windowEnd = center + halfWidthMin * MINUTE_MS;

  const status: 'upcoming' | 'now' | 'overdue' =
    now < windowStart ? 'upcoming' : now <= windowEnd ? 'now' : 'overdue';
  const minutesUntilStart = Math.round((windowStart - now) / MINUTE_MS);

  // Confidence from sample size and consistency (coefficient of variation).
  const cv = personalMean > 0 ? personalStd / personalMean : 1;
  let confidence: SleepPredictionConfidence = 'low';
  if (sampleCount >= 8 && cv < 0.35) confidence = 'high';
  else if (sampleCount >= 4) confidence = 'medium';

  const source: SleepPredictionResult['basis']['source'] =
    sampleCount === 0 ? 'age-based' : personalWeight >= 0.7 ? 'personalized' : 'blended';

  return {
    state: 'prediction',
    kind,
    windowStart,
    windowEnd,
    center,
    status,
    minutesUntilStart,
    confidence,
    lastWakeAt,
    basis: {
      sampleCount,
      predictedWakeWindowMinutes: Math.round(predictedWakeWindow),
      baselineWakeWindowMinutes: baseline,
      source,
    },
  };
}

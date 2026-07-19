/**
 * Sleep prediction ("SweetSpot"-style) engine.
 *
 * Predicts the optimal window for a baby's next sleep (nap or bedtime), and the
 * full remaining-day schedule, from their logged sleep history blended with
 * age-appropriate wake-window norms, with a sleep-debt nudge from how today's
 * naps have actually gone.
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

/** A single predicted sleep window (used for the day schedule). */
export interface PredictedSleep {
  kind: 'nap' | 'bedtime';
  /** Optimal window bounds (epoch ms). */
  windowStart: number;
  windowEnd: number;
  /** Window midpoint — the single best estimate (epoch ms). */
  center: number;
}

export interface SleepPredictionResult extends PredictedSleep {
  state: 'prediction';
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
    /**
     * Sleep-debt multiplier applied to the wake window from today's naps so far
     * (<1 = shortened because naps ran short, >1 = lengthened after long naps,
     * 1 = neutral / no naps yet today).
     */
    napAdjustmentFactor: number;
  };
}

export type SleepPrediction =
  | SleepPredictionResult
  | { state: 'asleep'; since: number }
  | { state: 'insufficient' };

/** Next sleep plus the projected remaining-day schedule. */
export interface DaySchedule {
  next: SleepPrediction;
  /**
   * Predicted sleeps for the rest of the local day, earliest first. The first
   * entry mirrors `next` when `next` is a prediction; empty otherwise.
   */
  schedule: PredictedSleep[];
}

export interface PredictionTuning {
  /** How many days of history to personalize from. */
  historyDays: number;
  /** Shrinkage prior strength: personal weight = n / (n + priorStrength). */
  priorStrength: number;
  /** Minimum / maximum / fallback half-width of the window (minutes). */
  minHalfWidthMin: number;
  maxHalfWidthMin: number;
  defaultHalfWidthMin: number;
  /** Safety cap on how many sleeps a day schedule may project. */
  maxScheduleSleeps: number;
}

export const DEFAULT_TUNING: PredictionTuning = {
  historyDays: 14,
  priorStrength: 5,
  minHalfWidthMin: 10,
  maxHalfWidthMin: 30,
  defaultHalfWidthMin: 20,
  maxScheduleSleeps: 8,
};

export interface PredictNextSleepInput {
  sleeps: SleepSample[];
  /** Current instant (epoch ms). */
  now: number;
  /** Baby age in months (fractional allowed). */
  ageMonths: number;
  /** IANA timezone used to bucket sleeps into local days (e.g. 'America/New_York'). */
  timeZone: string;
  /**
   * Optional per-baby average wake window (minutes). When set, it replaces the
   * age-based baseline as the prior the prediction personalizes from.
   */
  wakeWindowOverrideMinutes?: number | null;
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
 * Population sleep norms by age, used to calibrate the cold-start priors below
 * (before a baby has enough logged history to personalize from). Grounded in
 * published normative data:
 *   - AASM consensus recommendations for total sleep / 24h — infants 4–12mo
 *     12–16h, children 1–2y 11–14h (aasm.org child sleep duration advisory).
 *   - Iglowstein et al., Pediatrics 2003 — percentile curves for total/day/night
 *     sleep; documents the 2→1 nap transition at ~15–18 months.
 *   - Galland et al., Sleep Medicine Reviews 2012 — meta-analysis (0–12y, 34
 *     studies) of total sleep, nap number, and daytime sleep by age.
 *   - National Sleep Foundation — 0–3mo ~14–17h (the youngest band, which AASM
 *     leaves unspecified due to wide variation).
 * These are population midpoints with wide individual spread; the engine blends
 * them toward each baby's own logged data (see buildContext).
 */
export interface AgeSleepNorm {
  /** Exclusive upper bound of the band, in months. */
  maxMonths: number;
  /** Typical naps per day. */
  naps: number;
  /** Typical total sleep per 24h, minutes. */
  totalSleepMin: number;
  /** Typical daytime (nap) sleep, minutes. */
  daytimeSleepMin: number;
}

export const NORMATIVE_SLEEP: readonly AgeSleepNorm[] = [
  { maxMonths: 3, naps: 4, totalSleepMin: 930, daytimeSleepMin: 390 }, // 0–3mo  ~15.5h / ~6.5h day
  { maxMonths: 6, naps: 3, totalSleepMin: 870, daytimeSleepMin: 225 }, // 3–6mo  ~14.5h / ~3.75h
  { maxMonths: 9, naps: 3, totalSleepMin: 840, daytimeSleepMin: 195 }, // 6–9mo  ~14h   / ~3.25h
  { maxMonths: 12, naps: 2, totalSleepMin: 825, daytimeSleepMin: 180 }, // 9–12mo ~13.75h/ ~3h
  { maxMonths: 15, naps: 2, totalSleepMin: 810, daytimeSleepMin: 165 }, // 12–15mo ~13.5h/ ~2.75h
  { maxMonths: 18, naps: 1, totalSleepMin: 780, daytimeSleepMin: 150 }, // 15–18mo ~13h  / ~2.5h
  { maxMonths: 24, naps: 1, totalSleepMin: 750, daytimeSleepMin: 120 }, // 18–24mo ~12.5h/ ~2h
  { maxMonths: 36, naps: 1, totalSleepMin: 720, daytimeSleepMin: 105 }, // 2–3y   ~12h  / ~1.75h
  { maxMonths: Infinity, naps: 1, totalSleepMin: 690, daytimeSleepMin: 75 }, // 3y+ ~11.5h
];

function normFor(ageMonths: number): AgeSleepNorm {
  return (
    NORMATIVE_SLEEP.find((n) => ageMonths < n.maxMonths) ??
    NORMATIVE_SLEEP[NORMATIVE_SLEEP.length - 1]
  );
}

/** Population target for total sleep per 24h (minutes) at the given age. */
export function totalSleepTargetMinutes(ageMonths: number): number {
  return normFor(ageMonths).totalSleepMin;
}

/** Typical number of naps per day for the given age (used to detect bedtime). */
export function expectedNapsPerDay(ageMonths: number): number {
  return normFor(ageMonths).naps;
}

/**
 * Age-appropriate typical nap length in minutes (used to advance the day
 * schedule). Smoothed from the daytime-sleep ÷ nap-count norms above — naps
 * consolidate and lengthen with age toward a single ~2h toddler nap.
 */
export function ageNapDurationMinutes(ageMonths: number): number {
  if (ageMonths < 4) return 60;
  if (ageMonths < 9) return 75;
  if (ageMonths < 18) return 90;
  return 120;
}

/**
 * Age-appropriate average wake window in minutes. Wake windows are not directly
 * published in the normative literature (there is no official AAP chart), so
 * these are the widely used pediatric-consensus midpoints, cross-checked for
 * multi-nap ages against (24h − total sleep) ÷ (naps + 1) from NORMATIVE_SLEEP.
 * Documented consensus ranges are shown per band. Blended with the child's own
 * data downstream, so exact values matter less than the shape.
 */
export function ageBaselineWakeWindowMinutes(ageMonths: number): number {
  if (ageMonths < 1) return 50; // 45–60
  if (ageMonths < 2) return 70; // 60–90
  if (ageMonths < 3) return 85; // 75–90
  if (ageMonths < 4) return 100; // 75–120
  if (ageMonths < 5) return 120; // 105–135
  if (ageMonths < 7) return 150; // 120–180
  if (ageMonths < 10) return 175; // 150–195
  if (ageMonths < 14) return 210; // 180–240
  if (ageMonths < 18) return 255; // 210–270
  if (ageMonths < 36) return 300; // 240–330
  return 345; // 300–360
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
 * Estimate a typical nap length (minutes) from recent naps, falling back to an
 * age-appropriate default. Used to advance the simulated day schedule.
 */
export function estimateNapDurationMinutes(
  sleeps: SleepSample[],
  now: number,
  ageMonths: number,
  historyDays: number,
): number {
  const historyStart = now - historyDays * DAY_MS;
  const durations = sleeps
    .filter((s) => s.type === 'NAP' && s.end != null && s.start >= historyStart)
    .map((s) => ((s.end as number) - s.start) / MINUTE_MS)
    .filter((d) => d >= 10 && d <= 6 * 60);
  if (durations.length >= 3) return Math.round(mean(durations));
  return ageNapDurationMinutes(ageMonths);
}

/**
 * Sleep-debt multiplier for the next wake window based on how today's naps have
 * gone versus the baby's typical nap length. Short naps (accumulated sleep debt)
 * pull the next window earlier; long naps push it a little later. Neutral (1)
 * when there are no naps yet today. Bounded to a gentle ±10–15% so it nudges
 * rather than dominates.
 */
export function napDebtFactor(todayNapDurationsMin: number[], typicalNapMin: number): number {
  if (todayNapDurationsMin.length === 0 || typicalNapMin <= 0) return 1;
  const avg = mean(todayNapDurationsMin);
  const ratio = avg / typicalNapMin;
  return clamp(1 + 0.3 * (ratio - 1), 0.85, 1.1);
}

/**
 * Decide whether to send a "sleep window opening soon" notification.
 *
 * Fires once when the predicted window is about to open (within `leadMinutes`
 * and not yet reached), and not again for the same window: a window is
 * considered the same as the last notified one when their starts are within
 * `toleranceMinutes` (predictions drift slightly as new data arrives).
 */
export function sleepWindowNotifyDecision(params: {
  windowStartMs: number;
  nowMs: number;
  leadMinutes: number;
  lastNotifiedWindowStartMs: number | null;
  toleranceMinutes?: number;
}): boolean {
  const { windowStartMs, nowMs, leadMinutes, lastNotifiedWindowStartMs } = params;
  const toleranceMinutes = params.toleranceMinutes ?? 45;
  const minutesUntil = (windowStartMs - nowMs) / MINUTE_MS;
  if (minutesUntil < 0 || minutesUntil > leadMinutes) return false;
  if (lastNotifiedWindowStartMs == null) return true;
  return Math.abs(windowStartMs - lastNotifiedWindowStartMs) > toleranceMinutes * MINUTE_MS;
}

/** Wake windows grow across the day; the pre-bedtime one is the longest. */
function positionFactor(napsBefore: number, expectedNaps: number, isBedtime: boolean): number {
  if (isBedtime) return 1.25;
  const denom = Math.max(1, expectedNaps - 1);
  return 0.9 + 0.25 * clamp(napsBefore / denom, 0, 1); // 0.90 -> 1.15
}

/** Precomputed, history-derived context shared by every window in a day. */
interface PredictionContext {
  baseline: number;
  capMinutes: number;
  blendedBase: number;
  personalMean: number;
  personalStd: number;
  sampleCount: number;
  personalWeight: number;
  expectedNaps: number;
  halfWidthMin: number;
}

function buildContext(input: PredictNextSleepInput, tuning: PredictionTuning): PredictionContext {
  const { sleeps, now, ageMonths } = input;
  // A per-baby override replaces the age baseline as the prior; the engine still
  // personalizes toward the baby's own logged wake windows on top of it.
  const baseline =
    input.wakeWindowOverrideMinutes != null && input.wakeWindowOverrideMinutes > 0
      ? input.wakeWindowOverrideMinutes
      : ageBaselineWakeWindowMinutes(ageMonths);
  const capMinutes = Math.max(360, baseline * 2.5);

  const historyStart = now - tuning.historyDays * DAY_MS;
  const recent = sleeps.filter((s) => s.end != null && (s.end as number) >= historyStart);
  const windows = computeWakeWindows(recent, capMinutes);
  const sampleCount = windows.length;
  const personalMean = sampleCount > 0 ? mean(windows) : baseline;
  const personalStd = stdDev(windows);

  const personalWeight = sampleCount / (sampleCount + tuning.priorStrength);
  const blendedBase = personalWeight * personalMean + (1 - personalWeight) * baseline;

  const halfWidthMin = clamp(
    personalStd > 0 ? personalStd : tuning.defaultHalfWidthMin,
    tuning.minHalfWidthMin,
    tuning.maxHalfWidthMin,
  );

  return {
    baseline,
    capMinutes,
    blendedBase,
    personalMean,
    personalStd,
    sampleCount,
    personalWeight,
    expectedNaps: expectedNapsPerDay(ageMonths),
    halfWidthMin,
  };
}

/** Build a single sleep window given the wake start and naps already taken. */
function buildWindow(
  lastWakeAt: number,
  napsBefore: number,
  ctx: PredictionContext,
  debtFactor = 1,
): PredictedSleep & { predictedWakeWindowMinutes: number } {
  const isBedtime = napsBefore >= ctx.expectedNaps;
  const factor = positionFactor(napsBefore, ctx.expectedNaps, isBedtime);
  const predictedWakeWindow = clamp(ctx.blendedBase * factor * debtFactor, 20, ctx.capMinutes);
  const center = lastWakeAt + predictedWakeWindow * MINUTE_MS;
  return {
    kind: isBedtime ? 'bedtime' : 'nap',
    center,
    windowStart: center - ctx.halfWidthMin * MINUTE_MS,
    windowEnd: center + ctx.halfWidthMin * MINUTE_MS,
    predictedWakeWindowMinutes: Math.round(predictedWakeWindow),
  };
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
  const { sleeps, now, timeZone } = input;

  if (!sleeps || sleeps.length === 0) return { state: 'insufficient' };

  // Currently asleep — no "next sleep" to predict yet.
  const ongoing = sleeps.find((s) => s.end == null);
  if (ongoing) return { state: 'asleep', since: ongoing.start };

  const completed = sleeps
    .filter((s) => s.end != null)
    .sort((a, b) => (a.end as number) - (b.end as number));
  if (completed.length === 0) return { state: 'insufficient' };

  const lastWakeAt = completed[completed.length - 1].end as number;
  const ctx = buildContext(input, tuning);

  const todayKey = localDayKey(now, timeZone);
  const todayNaps = sleeps.filter(
    (s) => s.type === 'NAP' && s.end != null && localDayKey(s.start, timeZone) === todayKey,
  );
  const napsToday = todayNaps.length;

  // Sleep-debt nudge: compare today's naps so far to the baby's typical nap
  // length and shift the next window earlier (short naps) or later (long naps).
  const typicalNapMin = estimateNapDurationMinutes(sleeps, now, input.ageMonths, tuning.historyDays);
  const debtFactor = napDebtFactor(
    todayNaps.map((s) => ((s.end as number) - s.start) / MINUTE_MS),
    typicalNapMin,
  );

  const window = buildWindow(lastWakeAt, napsToday, ctx, debtFactor);

  const status: 'upcoming' | 'now' | 'overdue' =
    now < window.windowStart ? 'upcoming' : now <= window.windowEnd ? 'now' : 'overdue';
  const minutesUntilStart = Math.round((window.windowStart - now) / MINUTE_MS);

  const cv = ctx.personalMean > 0 ? ctx.personalStd / ctx.personalMean : 1;
  let confidence: SleepPredictionConfidence = 'low';
  if (ctx.sampleCount >= 8 && cv < 0.35) confidence = 'high';
  else if (ctx.sampleCount >= 4) confidence = 'medium';

  const source: SleepPredictionResult['basis']['source'] =
    ctx.sampleCount === 0 ? 'age-based' : ctx.personalWeight >= 0.7 ? 'personalized' : 'blended';

  return {
    state: 'prediction',
    kind: window.kind,
    windowStart: window.windowStart,
    windowEnd: window.windowEnd,
    center: window.center,
    status,
    minutesUntilStart,
    confidence,
    lastWakeAt,
    basis: {
      sampleCount: ctx.sampleCount,
      predictedWakeWindowMinutes: window.predictedWakeWindowMinutes,
      baselineWakeWindowMinutes: ctx.baseline,
      source,
      napAdjustmentFactor: debtFactor,
    },
  };
}

/**
 * Predict the next sleep plus the projected remaining-day schedule (all
 * upcoming naps and bedtime for the current local day). Each subsequent sleep
 * is projected by advancing past the previous nap using an estimated nap length.
 * Projection stops at bedtime or when it would cross into the next local day.
 */
export function predictDaySchedule(input: PredictNextSleepInput): DaySchedule {
  const tuning: PredictionTuning = { ...DEFAULT_TUNING, ...input.options };
  const next = predictNextSleep(input);

  if (next.state !== 'prediction') return { next, schedule: [] };

  const ctx = buildContext(input, tuning);
  const napDurationMin = estimateNapDurationMinutes(
    input.sleeps,
    input.now,
    input.ageMonths,
    tuning.historyDays,
  );
  const todayKey = localDayKey(input.now, input.timeZone);

  const schedule: PredictedSleep[] = [
    { kind: next.kind, windowStart: next.windowStart, windowEnd: next.windowEnd, center: next.center },
  ];

  // Recompute naps-so-far to advance the simulation from the same starting point.
  let napsBefore = input.sleeps.filter(
    (s) => s.type === 'NAP' && s.end != null && localDayKey(s.start, input.timeZone) === todayKey,
  ).length;
  let cursor: PredictedSleep = schedule[0];

  while (cursor.kind === 'nap' && schedule.length < tuning.maxScheduleSleeps) {
    // The current nap runs its estimated length, then the baby is awake again.
    const wakeAt = cursor.center + napDurationMin * MINUTE_MS;
    napsBefore += 1;
    const w = buildWindow(wakeAt, napsBefore, ctx);
    if (localDayKey(w.center, input.timeZone) !== todayKey) break;
    const entry: PredictedSleep = {
      kind: w.kind,
      windowStart: w.windowStart,
      windowEnd: w.windowEnd,
      center: w.center,
    };
    schedule.push(entry);
    cursor = entry;
  }

  return { next, schedule };
}

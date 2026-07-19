import { describe, expect, it } from 'vitest';
import {
  ageBaselineWakeWindowMinutes,
  ageInMonths,
  computeWakeWindows,
  expectedNapsPerDay,
  localDayKey,
  predictNextSleep,
  type SleepSample,
} from '@/src/utils/sleepPrediction';

const MIN = 60_000;
const HOUR = 60 * MIN;

/** Build a completed sleep from epoch-ms start + duration in minutes. */
function sleep(start: number, durationMin: number, type: SleepSample['type'] = 'NAP'): SleepSample {
  return { start, end: start + durationMin * MIN, type };
}

describe('ageInMonths', () => {
  it('computes roughly one year for a 365-day span', () => {
    const birth = Date.UTC(2025, 0, 15);
    const now = Date.UTC(2026, 0, 15);
    expect(ageInMonths(birth, now)).toBeCloseTo(12, 0);
  });

  it('never returns negative age', () => {
    expect(ageInMonths(Date.UTC(2026, 5, 1), Date.UTC(2026, 0, 1))).toBe(0);
  });
});

describe('ageBaselineWakeWindowMinutes', () => {
  it('increases with age across brackets', () => {
    expect(ageBaselineWakeWindowMinutes(0.5)).toBe(50);
    expect(ageBaselineWakeWindowMinutes(2.5)).toBe(80);
    expect(ageBaselineWakeWindowMinutes(8)).toBe(165);
    expect(ageBaselineWakeWindowMinutes(13)).toBe(205);
    expect(ageBaselineWakeWindowMinutes(24)).toBe(300);
    expect(ageBaselineWakeWindowMinutes(40)).toBe(345);
  });

  it('is monotonically non-decreasing', () => {
    let prev = 0;
    for (let m = 0; m <= 48; m += 0.5) {
      const v = ageBaselineWakeWindowMinutes(m);
      expect(v).toBeGreaterThanOrEqual(prev);
      prev = v;
    }
  });
});

describe('expectedNapsPerDay', () => {
  it('falls from many naps as a newborn to one for toddlers', () => {
    expect(expectedNapsPerDay(2)).toBe(5);
    expect(expectedNapsPerDay(5)).toBe(3);
    expect(expectedNapsPerDay(12)).toBe(2);
    expect(expectedNapsPerDay(24)).toBe(1);
  });
});

describe('computeWakeWindows', () => {
  it('returns gaps between consecutive completed sleeps', () => {
    const t = Date.UTC(2026, 0, 15, 8, 0, 0);
    const sleeps = [
      sleep(t, 60), // ends t+60m
      sleep(t + 180 * MIN, 60), // 120m gap
      sleep(t + 360 * MIN, 60), // 120m gap
    ];
    expect(computeWakeWindows(sleeps, 360)).toEqual([120, 120]);
  });

  it('filters out non-positive and over-cap gaps (missing logs)', () => {
    const t = Date.UTC(2026, 0, 15, 8, 0, 0);
    const sleeps = [
      sleep(t, 60), // ends t+60m
      sleep(t + 90 * MIN, 60), // 30m gap kept; ends t+150m
      sleep(t + 120 * MIN, 60), // starts before previous end -> negative gap, dropped; ends t+180m
      sleep(t + 180 * MIN + 20 * HOUR, 60), // 20h gap > cap, dropped
    ];
    expect(computeWakeWindows(sleeps, 360)).toEqual([30]);
  });

  it('ignores ongoing (unfinished) sleeps', () => {
    const t = Date.UTC(2026, 0, 15, 8, 0, 0);
    const sleeps: SleepSample[] = [
      sleep(t, 60),
      { start: t + 180 * MIN, end: null, type: 'NAP' },
    ];
    expect(computeWakeWindows(sleeps, 360)).toEqual([]);
  });
});

describe('localDayKey', () => {
  it('buckets by the given timezone, not UTC', () => {
    const instant = Date.UTC(2026, 0, 15, 3, 0, 0); // 03:00 UTC
    expect(localDayKey(instant, 'UTC')).toBe('2026-01-15');
    // 03:00 UTC is 22:00 on Jan 14 in New York (UTC-5)
    expect(localDayKey(instant, 'America/New_York')).toBe('2026-01-14');
  });
});

describe('predictNextSleep', () => {
  it('reports insufficient data when there are no sleeps', () => {
    const now = Date.UTC(2026, 0, 15, 9, 0, 0);
    expect(predictNextSleep({ sleeps: [], now, ageMonths: 8, timeZone: 'UTC' })).toEqual({
      state: 'insufficient',
    });
  });

  it('reports asleep while a sleep is ongoing', () => {
    const now = Date.UTC(2026, 0, 15, 9, 0, 0);
    const since = now - 30 * MIN;
    const result = predictNextSleep({
      sleeps: [{ start: since, end: null, type: 'NAP' }],
      now,
      ageMonths: 8,
      timeZone: 'UTC',
    });
    expect(result).toEqual({ state: 'asleep', since });
  });

  it('falls back to an age-based prediction with no wake-window history', () => {
    const now = Date.UTC(2026, 0, 15, 9, 0, 0);
    // One completed night sleep ended 30 min ago; no naps yet today.
    const nightStart = Date.UTC(2026, 0, 14, 19, 0, 0);
    const lastWake = Date.UTC(2026, 0, 15, 8, 30, 0);
    const result = predictNextSleep({
      sleeps: [{ start: nightStart, end: lastWake, type: 'NIGHT_SLEEP' }],
      now,
      ageMonths: 8,
      timeZone: 'UTC',
    });
    expect(result.state).toBe('prediction');
    if (result.state !== 'prediction') return;
    expect(result.kind).toBe('nap');
    expect(result.basis.sampleCount).toBe(0);
    expect(result.basis.source).toBe('age-based');
    expect(result.basis.baselineWakeWindowMinutes).toBe(165);
    // First wake window of the day: baseline * 0.9 = 148.5 -> center at lastWake+148.5m
    expect(result.basis.predictedWakeWindowMinutes).toBe(149);
    expect(result.confidence).toBe('low');
    expect(result.status).toBe('upcoming');
    expect(result.lastWakeAt).toBe(lastWake);
    expect(result.windowStart).toBeLessThan(result.center);
    expect(result.center).toBeLessThan(result.windowEnd);
    expect(result.minutesUntilStart).toBeGreaterThan(0);
  });

  it('personalizes and is confident with consistent recent history', () => {
    const now = Date.UTC(2026, 0, 15, 9, 0, 0);
    // 16 naps chained with a constant 120-min wake window (15 samples).
    const sleeps: SleepSample[] = [];
    let cursor = now - 6 * 24 * HOUR;
    for (let i = 0; i < 16; i++) {
      sleeps.push(sleep(cursor, 60));
      cursor += (60 + 120) * MIN; // 60m asleep + 120m awake
    }
    const result = predictNextSleep({ sleeps, now, ageMonths: 8, timeZone: 'UTC' });
    expect(result.state).toBe('prediction');
    if (result.state !== 'prediction') return;
    expect(result.basis.sampleCount).toBe(15);
    expect(result.basis.source).toBe('personalized');
    expect(result.confidence).toBe('high');
    // Prediction pulled toward the personal 120-min window (baseline is 165).
    expect(result.basis.predictedWakeWindowMinutes).toBeGreaterThan(100);
    expect(result.basis.predictedWakeWindowMinutes).toBeLessThan(165);
    expect(result.windowStart).toBeLessThan(result.windowEnd);
  });

  it('flags an overdue window when the sweet spot has already passed', () => {
    const now = Date.UTC(2026, 0, 15, 16, 0, 0);
    // Woke 6 hours ago as a toddler (long baseline) still puts center in the past.
    const lastWake = now - 6 * HOUR;
    const result = predictNextSleep({
      sleeps: [{ start: lastWake - HOUR, end: lastWake, type: 'NIGHT_SLEEP' }],
      now,
      ageMonths: 8,
      timeZone: 'UTC',
    });
    expect(result.state).toBe('prediction');
    if (result.state !== 'prediction') return;
    expect(result.status).toBe('overdue');
    expect(result.minutesUntilStart).toBeLessThan(0);
  });

  it('reports a "now" status when inside the sweet spot', () => {
    const now = Date.UTC(2026, 0, 15, 12, 0, 0);
    // baseline 165 * 0.9 (first window) = 148.5m before now => center == now.
    const lastWake = now - 148.5 * MIN;
    const result = predictNextSleep({
      sleeps: [{ start: lastWake - HOUR, end: lastWake, type: 'NIGHT_SLEEP' }],
      now,
      ageMonths: 8,
      timeZone: 'UTC',
    });
    expect(result.state).toBe('prediction');
    if (result.state !== 'prediction') return;
    expect(result.status).toBe('now');
  });

  it('predicts bedtime once the day\'s naps are used up', () => {
    const now = Date.UTC(2026, 0, 15, 16, 0, 0);
    // Toddler (12mo -> 2 naps/day) who already napped twice today.
    const nap1 = sleep(Date.UTC(2026, 0, 15, 9, 0, 0), 90);
    const nap2 = sleep(Date.UTC(2026, 0, 15, 13, 0, 0), 90);
    const result = predictNextSleep({
      sleeps: [nap1, nap2],
      now,
      ageMonths: 12,
      timeZone: 'UTC',
    });
    expect(result.state).toBe('prediction');
    if (result.state !== 'prediction') return;
    expect(result.kind).toBe('bedtime');
  });
});

import { describe, expect, it } from 'vitest';
import {
  ageBaselineWakeWindowMinutes,
  ageInMonths,
  ageNapDurationMinutes,
  computeWakeWindows,
  estimateNapDurationMinutes,
  expectedNapsPerDay,
  localDayKey,
  napDebtFactor,
  NORMATIVE_SLEEP,
  predictDaySchedule,
  predictNextSleep,
  sleepWindowNotifyDecision,
  totalSleepTargetMinutes,
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
    expect(ageBaselineWakeWindowMinutes(2.5)).toBe(85);
    expect(ageBaselineWakeWindowMinutes(8)).toBe(175);
    expect(ageBaselineWakeWindowMinutes(13)).toBe(210);
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
    expect(expectedNapsPerDay(2)).toBe(4);
    expect(expectedNapsPerDay(5)).toBe(3);
    expect(expectedNapsPerDay(12)).toBe(2);
    expect(expectedNapsPerDay(24)).toBe(1);
  });
});

describe('normative sleep table', () => {
  it('naps and total sleep are non-increasing with age', () => {
    let prevNaps = Infinity;
    let prevTotal = Infinity;
    for (const band of NORMATIVE_SLEEP) {
      expect(band.naps).toBeLessThanOrEqual(prevNaps);
      expect(band.totalSleepMin).toBeLessThanOrEqual(prevTotal);
      expect(band.daytimeSleepMin).toBeLessThan(band.totalSleepMin);
      prevNaps = band.naps;
      prevTotal = band.totalSleepMin;
    }
  });

  it('total-sleep target sits within the AASM consensus ranges', () => {
    // AASM: infants 4–12mo 12–16h (720–960 min); children 1–2y 11–14h (660–840 min).
    expect(totalSleepTargetMinutes(8)).toBeGreaterThanOrEqual(720);
    expect(totalSleepTargetMinutes(8)).toBeLessThanOrEqual(960);
    expect(totalSleepTargetMinutes(18)).toBeGreaterThanOrEqual(660);
    expect(totalSleepTargetMinutes(18)).toBeLessThanOrEqual(840);
    // Target decreases from infancy to toddlerhood.
    expect(totalSleepTargetMinutes(2)).toBeGreaterThan(totalSleepTargetMinutes(30));
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
    expect(result.basis.baselineWakeWindowMinutes).toBe(175);
    // First wake window of the day: baseline(175) * 0.9 = 157.5 -> 158 (rounded)
    expect(result.basis.predictedWakeWindowMinutes).toBe(158);
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
    // Prediction pulled below the age baseline toward the personal 120-min window.
    expect(result.basis.predictedWakeWindowMinutes).toBeGreaterThan(100);
    expect(result.basis.predictedWakeWindowMinutes).toBeLessThan(ageBaselineWakeWindowMinutes(8));
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
    // baseline 175 * 0.9 (first window) = 157.5m before now => center == now.
    const lastWake = now - 157.5 * MIN;
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

describe('estimateNapDurationMinutes', () => {
  const now = Date.UTC(2026, 0, 15, 12, 0, 0);

  it('falls back to the age default with fewer than 3 recent naps', () => {
    const sleeps = [sleep(now - 3 * HOUR, 50, 'NAP')];
    expect(estimateNapDurationMinutes(sleeps, now, 8, 14)).toBe(ageNapDurationMinutes(8));
  });

  it('uses the mean of recent nap durations once there are enough', () => {
    const sleeps = [
      sleep(now - 3 * 24 * HOUR, 60, 'NAP'),
      sleep(now - 2 * 24 * HOUR, 60, 'NAP'),
      sleep(now - 1 * 24 * HOUR, 90, 'NAP'),
    ];
    expect(estimateNapDurationMinutes(sleeps, now, 8, 14)).toBe(70);
  });
});

describe('predictDaySchedule', () => {
  it('returns an empty schedule when there is no prediction', () => {
    const now = Date.UTC(2026, 0, 15, 9, 0, 0);
    const result = predictDaySchedule({ sleeps: [], now, ageMonths: 8, timeZone: 'UTC' });
    expect(result.next.state).toBe('insufficient');
    expect(result.schedule).toEqual([]);
  });

  it('projects naps then bedtime for the rest of the day, in order', () => {
    const now = Date.UTC(2026, 0, 15, 7, 0, 0);
    // 12mo -> 2 naps/day; night sleep ended this morning, no naps yet.
    const sleeps: SleepSample[] = [
      { start: Date.UTC(2026, 0, 14, 19, 0, 0), end: Date.UTC(2026, 0, 15, 6, 30, 0), type: 'NIGHT_SLEEP' },
    ];
    const { next, schedule } = predictDaySchedule({ sleeps, now, ageMonths: 12, timeZone: 'UTC' });

    expect(next.state).toBe('prediction');
    // nap, nap, bedtime
    expect(schedule.map((s) => s.kind)).toEqual(['nap', 'nap', 'bedtime']);
    // first entry mirrors `next`
    if (next.state === 'prediction') expect(schedule[0].center).toBe(next.center);
    // chronological, each after the previous
    for (let i = 1; i < schedule.length; i++) {
      expect(schedule[i].center).toBeGreaterThan(schedule[i - 1].center);
      expect(schedule[i].windowStart).toBeLessThan(schedule[i].windowEnd);
    }
    // all windows land on the same local day
    for (const s of schedule) {
      expect(localDayKey(s.center, 'UTC')).toBe('2026-01-15');
    }
  });

  it('honors the maxScheduleSleeps cap', () => {
    const now = Date.UTC(2026, 0, 15, 7, 0, 0);
    // Young baby (many naps) so bedtime is far off; cap the projection at 3.
    const sleeps: SleepSample[] = [
      { start: Date.UTC(2026, 0, 15, 5, 30, 0), end: Date.UTC(2026, 0, 15, 6, 30, 0), type: 'NIGHT_SLEEP' },
    ];
    const { schedule } = predictDaySchedule({
      sleeps,
      now,
      ageMonths: 2,
      timeZone: 'UTC',
      options: { maxScheduleSleeps: 3 },
    });
    expect(schedule.length).toBe(3);
    expect(schedule.every((s) => s.kind === 'nap')).toBe(true);
  });
});

describe('per-baby wake-window override', () => {
  const now = Date.UTC(2026, 0, 15, 9, 0, 0);
  const lastWake = Date.UTC(2026, 0, 15, 8, 30, 0);
  const sleeps: SleepSample[] = [
    { start: Date.UTC(2026, 0, 14, 19, 0, 0), end: lastWake, type: 'NIGHT_SLEEP' },
  ];

  it('uses the override as the baseline instead of the age default', () => {
    const withOverride = predictNextSleep({
      sleeps,
      now,
      ageMonths: 8,
      timeZone: 'UTC',
      wakeWindowOverrideMinutes: 240,
    });
    const withoutOverride = predictNextSleep({ sleeps, now, ageMonths: 8, timeZone: 'UTC' });
    expect(withOverride.state).toBe('prediction');
    expect(withoutOverride.state).toBe('prediction');
    if (withOverride.state !== 'prediction' || withoutOverride.state !== 'prediction') return;
    expect(withOverride.basis.baselineWakeWindowMinutes).toBe(240);
    expect(withoutOverride.basis.baselineWakeWindowMinutes).toBe(ageBaselineWakeWindowMinutes(8));
    // A larger baseline pushes the predicted window later.
    expect(withOverride.basis.predictedWakeWindowMinutes).toBeGreaterThan(
      withoutOverride.basis.predictedWakeWindowMinutes,
    );
  });

  it('ignores a null override and falls back to the age baseline', () => {
    const r = predictNextSleep({
      sleeps,
      now,
      ageMonths: 8,
      timeZone: 'UTC',
      wakeWindowOverrideMinutes: null,
    });
    expect(r.state).toBe('prediction');
    if (r.state !== 'prediction') return;
    expect(r.basis.baselineWakeWindowMinutes).toBe(ageBaselineWakeWindowMinutes(8));
  });
});

describe('napDebtFactor', () => {
  it('is neutral with no naps yet today', () => {
    expect(napDebtFactor([], 90)).toBe(1);
  });

  it('is neutral when today\'s naps match the typical length', () => {
    expect(napDebtFactor([90, 90], 90)).toBe(1);
  });

  it('shortens the window after short naps (bounded at 0.85)', () => {
    expect(napDebtFactor([30], 90)).toBe(0.85); // ratio 0.33 -> clamped
    expect(napDebtFactor([72], 90)).toBeCloseTo(0.94, 5); // ratio 0.8 -> 1 + 0.3*(-0.2)
  });

  it('lengthens the window after long naps (bounded at 1.1)', () => {
    expect(napDebtFactor([150], 90)).toBe(1.1); // ratio 1.67 -> clamped
  });
});

describe('sleep-debt effect on prediction', () => {
  const base = Date.UTC(2026, 0, 15, 13, 0, 0);
  // 8-month-old, one completed nap earlier today (start 10:00), awake since.
  function withNapMinutes(napMin: number) {
    const napStart = Date.UTC(2026, 0, 15, 10, 0, 0);
    return predictNextSleep({
      sleeps: [{ start: napStart, end: napStart + napMin * 60_000, type: 'NAP' }],
      now: base,
      ageMonths: 8,
      timeZone: 'UTC',
    });
  }

  it('predicts an earlier next window after a short nap than after a long nap', () => {
    const shortNap = withNapMinutes(30);
    const longNap = withNapMinutes(120);
    expect(shortNap.state).toBe('prediction');
    expect(longNap.state).toBe('prediction');
    if (shortNap.state !== 'prediction' || longNap.state !== 'prediction') return;
    expect(shortNap.basis.napAdjustmentFactor).toBeLessThan(1);
    expect(longNap.basis.napAdjustmentFactor).toBeGreaterThan(1);
    expect(shortNap.basis.predictedWakeWindowMinutes).toBeLessThan(
      longNap.basis.predictedWakeWindowMinutes,
    );
  });
});

describe('sleepWindowNotifyDecision', () => {
  const now = Date.UTC(2026, 0, 15, 12, 0, 0);
  const lead = 15;

  it('fires when the window opens within the lead time and none sent yet', () => {
    expect(
      sleepWindowNotifyDecision({
        windowStartMs: now + 10 * MIN,
        nowMs: now,
        leadMinutes: lead,
        lastNotifiedWindowStartMs: null,
      }),
    ).toBe(true);
  });

  it('does not fire when the window is still further off than the lead time', () => {
    expect(
      sleepWindowNotifyDecision({
        windowStartMs: now + 40 * MIN,
        nowMs: now,
        leadMinutes: lead,
        lastNotifiedWindowStartMs: null,
      }),
    ).toBe(false);
  });

  it('does not fire once the window has already opened', () => {
    expect(
      sleepWindowNotifyDecision({
        windowStartMs: now - 5 * MIN,
        nowMs: now,
        leadMinutes: lead,
        lastNotifiedWindowStartMs: null,
      }),
    ).toBe(false);
  });

  it('does not re-fire for the same window already notified', () => {
    const windowStart = now + 10 * MIN;
    expect(
      sleepWindowNotifyDecision({
        windowStartMs: windowStart,
        nowMs: now,
        leadMinutes: lead,
        lastNotifiedWindowStartMs: windowStart + 5 * MIN, // within default 45m tolerance
      }),
    ).toBe(false);
  });

  it('fires again for a genuinely new window', () => {
    expect(
      sleepWindowNotifyDecision({
        windowStartMs: now + 10 * MIN,
        nowMs: now,
        leadMinutes: lead,
        lastNotifiedWindowStartMs: now - 3 * HOUR, // an earlier, different window
      }),
    ).toBe(true);
  });
});

'use client';

import React, { useCallback, useEffect, useState } from 'react';
import { Moon, Sun, AlarmClock } from 'lucide-react';
import { cn } from '@/src/lib/utils';
import { useLocalization } from '@/src/context/localization';
import { sleepPredictionCard, sleepPredictionStyles as s } from './sleep-prediction.styles';
import { SleepPredictionCardProps, SleepPrediction } from './sleep-prediction.types';
import './sleep-prediction.css';

/** Format an epoch-ms instant as a short local clock time (e.g. "2:05 PM"). */
function formatClock(ms: number): string {
  return new Date(ms).toLocaleTimeString(undefined, { hour: 'numeric', minute: '2-digit' });
}

/** Human "35 min" / "1 hr 5 min" from a minute count. */
function formatCountdown(mins: number, t: (key: string) => string): string {
  const safe = Math.max(0, mins);
  if (safe < 60) return `${safe} ${t('min')}`;
  const h = Math.floor(safe / 60);
  const m = safe % 60;
  return m === 0 ? `${h} ${t('hr')}` : `${h} ${t('hr')} ${m} ${t('min')}`;
}

/**
 * Dashboard card showing the predicted "sweet spot" window for the baby's next
 * sleep. Fetches from /api/sleep/prediction and derives the live countdown /
 * status from the returned window so it stays current between refetches. Renders
 * nothing while the baby is asleep or when there isn't enough data yet.
 */
export function SleepPredictionCard({ babyId, refreshTrigger, className }: SleepPredictionCardProps) {
  const { t } = useLocalization();
  const [prediction, setPrediction] = useState<SleepPrediction | null>(null);
  const [nowTs, setNowTs] = useState<number>(() => Date.now());

  const load = useCallback(async () => {
    if (!babyId) return;
    try {
      const token = localStorage.getItem('authToken');
      const res = await fetch(`/api/sleep/prediction?babyId=${encodeURIComponent(babyId)}`, {
        headers: token ? { Authorization: `Bearer ${token}` } : {},
      });
      if (!res.ok) return;
      const data = await res.json();
      if (data?.success) setPrediction(data.data as SleepPrediction);
    } catch {
      // Non-critical feature — stay silent on failure.
    }
  }, [babyId]);

  useEffect(() => {
    load();
  }, [load, refreshTrigger]);

  // Keep the countdown/status live, and refetch periodically so other
  // caretakers' logged sleeps are reflected without a manual refresh.
  useEffect(() => {
    const tick = setInterval(() => setNowTs(Date.now()), 30_000);
    const refetch = setInterval(() => load(), 5 * 60_000);
    return () => {
      clearInterval(tick);
      clearInterval(refetch);
    };
  }, [load]);

  if (!prediction) return null;

  if (prediction.state === 'insufficient') {
    return (
      <div className={cn(s.hint, className)}>
        <Moon className="h-4 w-4 shrink-0" aria-hidden="true" />
        <span>{t('Log a few more sleeps to unlock nap predictions.')}</span>
      </div>
    );
  }
  if (prediction.state === 'asleep') return null;

  const { windowStart, windowEnd, kind } = prediction;
  const status: 'upcoming' | 'now' | 'overdue' =
    nowTs < windowStart ? 'upcoming' : nowTs <= windowEnd ? 'now' : 'overdue';
  const minutesUntil = Math.round((windowStart - nowTs) / 60_000);

  const label = kind === 'bedtime' ? t('Bedtime sweet spot') : t('Next nap');
  const windowText = `${formatClock(windowStart)} – ${formatClock(windowEnd)}`;

  let countdownMain: string;
  let countdownSub: string;
  if (status === 'now') {
    countdownMain = t('Now');
    countdownSub = t('Great time to wind down');
  } else if (status === 'overdue') {
    countdownMain = t('Overdue');
    countdownSub = t('May be overtired');
  } else {
    countdownMain = `${t('in')} ${formatCountdown(minutesUntil, t)}`;
    countdownSub =
      prediction.confidence === 'high'
        ? t('High confidence')
        : prediction.confidence === 'medium'
          ? t('Medium confidence')
          : t('Low confidence');
  }

  const Icon = status === 'overdue' ? AlarmClock : kind === 'bedtime' ? Moon : Sun;

  return (
    <div className={cn(sleepPredictionCard({ status }), className)} role="status" aria-live="polite">
      <div className={s.iconWrap}>
        <Icon className="h-5 w-5" aria-hidden="true" />
      </div>
      <div className={s.body}>
        <span className={s.label}>{label}</span>
        <span className={s.window}>{windowText}</span>
      </div>
      <div className={s.countdown}>
        <div className={s.countdownValue}>{countdownMain}</div>
        <div className={s.meta}>{countdownSub}</div>
      </div>
    </div>
  );
}

export default SleepPredictionCard;

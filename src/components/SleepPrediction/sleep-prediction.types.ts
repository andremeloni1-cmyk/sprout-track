import type { SleepPrediction } from '@/src/utils/sleepPrediction';

export interface SleepPredictionCardProps {
  /** Baby to predict the next sleep for. */
  babyId: string;
  /**
   * Change this value to force an immediate refetch (e.g. after a sleep is
   * logged or ended on the dashboard).
   */
  refreshTrigger?: number | string;
  /** Optional extra classes applied to the root element. */
  className?: string;
}

export type { SleepPrediction };

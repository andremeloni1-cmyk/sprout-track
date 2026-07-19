import { cva } from 'class-variance-authority';

/**
 * Sleep-prediction ("SweetSpot") card container. Light-mode Tailwind variants
 * live here; dark-mode overrides use the `html.dark` selectors in
 * sleep-prediction.css keyed off the class names below.
 */
export const sleepPredictionCard = cva(
  'sleep-prediction-card flex items-center gap-3 rounded-2xl border px-4 py-3 my-2 transition-colors',
  {
    variants: {
      status: {
        upcoming: 'sleep-prediction-upcoming border-indigo-100 bg-indigo-50/70 text-indigo-900',
        now: 'sleep-prediction-now border-violet-200 bg-violet-100 text-violet-900',
        overdue: 'sleep-prediction-overdue border-amber-200 bg-amber-50 text-amber-900',
      },
    },
    defaultVariants: { status: 'upcoming' },
  },
);

export const sleepPredictionStyles = {
  iconWrap:
    'sleep-prediction-icon flex h-9 w-9 shrink-0 items-center justify-center rounded-full bg-white/70 text-indigo-600',
  body: 'flex min-w-0 flex-1 flex-col',
  label: 'text-[11px] font-medium uppercase tracking-wide opacity-70',
  window: 'text-sm font-semibold leading-tight',
  adjustment: 'mt-0.5 text-[11px] font-medium opacity-70',
  countdown: 'ml-auto shrink-0 pl-2 text-right',
  countdownValue: 'text-sm font-semibold leading-tight',
  meta: 'text-xs opacity-80',
  hint:
    'sleep-prediction-hint flex items-center gap-2 rounded-2xl border border-dashed border-slate-200 px-4 py-2.5 my-2 text-xs text-slate-500',
  // "Later today" projected schedule
  schedule:
    'sleep-prediction-schedule -mt-1 mb-2 rounded-2xl border border-slate-100 bg-slate-50/70 px-4 py-2 text-slate-600',
  scheduleTitle: 'mb-1 text-[11px] font-medium uppercase tracking-wide opacity-60',
  scheduleList: 'flex flex-col gap-1',
  scheduleItem: 'flex items-center gap-2 text-xs',
  scheduleKind: 'font-medium',
  scheduleTime: 'ml-auto tabular-nums opacity-70',
} as const;

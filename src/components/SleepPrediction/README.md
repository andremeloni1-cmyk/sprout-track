# SleepPredictionCard

A dashboard card that shows a "SweetSpot"-style predicted **window** for the
baby's next sleep (nap or bedtime), inspired by Huckleberry's SweetSpot, plus a
compact **"Later today"** projection of the remaining naps and bedtime.

## Usage

```tsx
import { SleepPredictionCard } from '@/src/components/SleepPrediction';

<SleepPredictionCard babyId={selectedBaby.id} refreshTrigger={refreshTrigger} />
```

## Props

| Prop | Type | Description |
|------|------|-------------|
| `babyId` | `string` | Baby to predict for (required). |
| `refreshTrigger` | `number \| string` | Change to force an immediate refetch (e.g. after logging a sleep). |
| `className` | `string` | Extra classes on the root element. |

## Behavior

- Fetches `GET /api/sleep/prediction?babyId=...` (JWT via `Authorization`
  header), which returns `{ next, schedule }`.
- Renders the `next` window as the main card and the rest of `schedule` (the
  remaining naps + bedtime for today) as a compact "Later today" list.
- Derives the live status/countdown client-side from the returned absolute
  window, ticking every 30s, and refetches every 5 minutes so other caretakers'
  logged sleeps appear without a manual refresh.
- Renders **nothing** while the baby is asleep (`state: 'asleep'`).
- Shows a subtle onboarding hint when there isn't enough history yet
  (`state: 'insufficient'`).
- Otherwise shows the window (e.g. `2:00 – 2:30 PM`), a nap/bedtime label, and a
  countdown that turns into a "Now" / "Overdue" state as time passes.

## Prediction model

The prediction itself is computed by the pure, unit-tested engine in
[`src/utils/sleepPrediction.ts`](../../utils/sleepPrediction.ts): a blend of the
baby's own recent wake windows and age-appropriate wake-window norms, with
nap-vs-bedtime detection and a confidence level. See that module and
`tests/sleepPrediction.test.ts` for details.

## Styling

Light mode uses Tailwind via CVA in `sleep-prediction.styles.ts`; dark mode uses
`html.dark` overrides in `sleep-prediction.css` (controlled by the app theme
toggle, per the project styling conventions).

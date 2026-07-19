import { NextRequest, NextResponse } from 'next/server';
import prisma from '../../db';
import { ApiResponse } from '../../types';
import { withAuthContext, AuthResult } from '../../utils/auth';
import { getSystemTimezone } from '../../utils/timezone';
import {
  ageInMonths,
  predictDaySchedule,
  type DaySchedule,
  type SleepSample,
} from '@/src/utils/sleepPrediction';

/** Days of sleep history to personalize the prediction from. */
const HISTORY_DAYS = 16;

/**
 * GET /api/sleep/prediction?babyId=...
 *
 * Returns a "SweetSpot"-style prediction of the baby's next sleep window plus
 * the projected remaining-day schedule (`{ next, schedule }`), scoped to the
 * authenticated user's family. The heavy logic lives in the pure, unit-tested
 * src/utils/sleepPrediction module; this handler only loads data.
 */
async function handleGet(req: NextRequest, authContext: AuthResult) {
  try {
    const { familyId: userFamilyId } = authContext;
    if (!userFamilyId) {
      return NextResponse.json<ApiResponse<null>>(
        { success: false, error: 'User is not associated with a family.' },
        { status: 403 },
      );
    }

    const babyId = new URL(req.url).searchParams.get('babyId');
    if (!babyId) {
      return NextResponse.json<ApiResponse<null>>(
        { success: false, error: 'babyId is required' },
        { status: 400 },
      );
    }

    // Verify the baby belongs to the caller's family before reading its data.
    const baby = await prisma.baby.findFirst({
      where: { id: babyId, familyId: userFamilyId },
      select: { birthDate: true, wakeWindowOverrideMinutes: true },
    });
    if (!baby) {
      return NextResponse.json<ApiResponse<null>>(
        { success: false, error: 'Baby not found in this family.' },
        { status: 404 },
      );
    }

    const now = Date.now();
    const since = new Date(now - HISTORY_DAYS * 24 * 60 * 60 * 1000);

    const logs = await prisma.sleepLog.findMany({
      where: {
        babyId,
        familyId: userFamilyId,
        deletedAt: null,
        startTime: { gte: since },
      },
      select: { startTime: true, endTime: true, type: true },
      orderBy: { startTime: 'asc' },
    });

    const sleeps: SleepSample[] = logs.map((log) => ({
      start: log.startTime.getTime(),
      end: log.endTime ? log.endTime.getTime() : null,
      type: log.type,
    }));

    const prediction = predictDaySchedule({
      sleeps,
      now,
      ageMonths: ageInMonths(baby.birthDate.getTime(), now),
      timeZone: getSystemTimezone(),
      wakeWindowOverrideMinutes: baby.wakeWindowOverrideMinutes,
    });

    return NextResponse.json<ApiResponse<DaySchedule>>({ success: true, data: prediction });
  } catch (error) {
    console.error('Error predicting next sleep:', error);
    return NextResponse.json<ApiResponse<null>>(
      { success: false, error: 'Failed to predict next sleep' },
      { status: 500 },
    );
  }
}

export const GET = withAuthContext(handleGet);

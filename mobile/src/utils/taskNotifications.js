/**
 * DO task reminders (src/utils/taskNotifications.js).
 * WHAT: Schedules local morning/evening notifications for temperature tasks.
 * WHY: Operators should not miss shift checks when the app is in the background.
 * HOW: cancelAll + scheduleAt fixed IDs when refreshTaskReminders runs from Dashboard.
 */
import * as Notifications from 'expo-notifications';
import { ensureNotificationPermission } from './permissions';

const DATE_TRIGGER =
  Notifications.SchedulableTriggerInputTypes?.DATE || 'date';

export const MORNING_NOTIF_ID = 'reeferon-morning-task';
export const EVENING_NOTIF_ID = 'reeferon-evening-task';

function nextOccurrence(hour, minute) {
  const when = new Date();
  when.setSeconds(0, 0);
  when.setHours(hour, minute, 0, 0);
  if (when.getTime() <= Date.now()) {
    when.setDate(when.getDate() + 1);
  }
  return when;
}

function tomorrowAt(hour, minute) {
  const when = new Date();
  when.setDate(when.getDate() + 1);
  when.setHours(hour, minute, 0, 0);
  when.setSeconds(0, 0);
  return when;
}

function clientsLabel(count) {
  const n = Math.max(0, Number(count) || 0);
  return `${n} client${n === 1 ? '' : 's'}`;
}

function buildMorningBody(clientCount) {
  const n = Math.max(0, Number(clientCount) || 0);
  if (n <= 0) {
    return 'Your morning temperature tasks are ready. Tap to complete your tasks.';
  }
  return `Please complete morning temperature checks for ${clientsLabel(n)}. Tap to complete your tasks.`;
}

function buildEveningBody(eveningClientCount, morningPendingCount) {
  const eveningN = Math.max(0, Number(eveningClientCount) || 0);
  const morningDue = Math.max(0, Number(morningPendingCount) || 0);
  let body =
    eveningN > 0
      ? `Please complete evening temperature checks for ${clientsLabel(eveningN)}.`
      : 'Your evening temperature tasks are ready.';
  if (morningDue > 0) {
    body += ` Morning tasks are still pending for ${clientsLabel(morningDue)}.`;
  }
  body += ' Tap to complete your tasks.';
  return body;
}

async function scheduleAt(identifier, content, when) {
  await Notifications.scheduleNotificationAsync({
    identifier,
    content: {
      ...content,
      sound: true
    },
    trigger: {
      type: DATE_TRIGGER,
      date: when,
      channelId: 'task-reminders'
    }
  });
}

/**
 * @param {{
 *   morningCompleted?: boolean,
 *   eveningCompleted?: boolean,
 *   morningClientCount?: number,
 *   eveningClientCount?: number,
 *   morningPendingCount?: number
 * }} opts
 */
/**
 * WHAT: Rebuilds morning/evening notification schedule from current task completion counts.
 * WHY: Skip alerts when that shift is already done; reschedule for tomorrow.
 * HOW: ensureNotificationPermission then scheduleAt with computed body text.
 */
export async function refreshTaskReminders({
  morningCompleted = false,
  eveningCompleted = false,
  morningClientCount = 0,
  eveningClientCount = 0,
  morningPendingCount = 0
} = {}) {
  const granted = await ensureNotificationPermission();
  if (!granted) return;

  try {
    await Notifications.cancelAllScheduledNotificationsAsync();
  } catch (err) {
    console.warn('cancel scheduled notifications failed:', err?.message || err);
  }

  try {
    // Morning 10:00 — skip today if morning already done
    const morningDate = morningCompleted ? tomorrowAt(10, 0) : nextOccurrence(10, 0);
    // If scheduling for tomorrow (already done today), use full client total again
    const morningBodyCount = morningClientCount;
    await scheduleAt(
      MORNING_NOTIF_ID,
      {
        title: 'Morning tasks reminder',
        body: buildMorningBody(morningBodyCount),
        data: {
          shift: 'Morning',
          type: 'task_reminder',
          clientCount: morningBodyCount
        }
      },
      morningDate
    );
    console.log(
      morningCompleted
        ? `🔔 Morning notify skipped today (completed) → next at ${morningDate.toISOString()}`
        : `🔔 Morning notify scheduled at ${morningDate.toISOString()} (${morningBodyCount} clients)`
    );

    // Evening 16:00 — skip today if evening already done
    const eveningDate = eveningCompleted ? tomorrowAt(16, 0) : nextOccurrence(16, 0);
    // Morning-due note only when evening fires today and morning still pending
    const includeMorningDue =
      !eveningCompleted && eveningDate.toDateString() === new Date().toDateString()
        ? morningPendingCount
        : 0;
    await scheduleAt(
      EVENING_NOTIF_ID,
      {
        title: 'Evening tasks reminder',
        body: buildEveningBody(eveningClientCount, includeMorningDue),
        data: {
          shift: 'Evening',
          type: 'task_reminder',
          clientCount: eveningClientCount,
          morningPendingCount: includeMorningDue
        }
      },
      eveningDate
    );
    console.log(
      eveningCompleted
        ? `🔔 Evening notify skipped today (completed) → next at ${eveningDate.toISOString()}`
        : `🔔 Evening notify scheduled at ${eveningDate.toISOString()} (${eveningClientCount} clients, morning due ${includeMorningDue})`
    );
  } catch (err) {
    console.warn('refreshTaskReminders failed:', err?.message || err);
  }
}

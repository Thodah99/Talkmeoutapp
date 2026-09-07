/**
 * STREAK-AT-RISK PUSH NOTIFICATION
 * -------------------------------------------------------------------------
 * This is the backend half of "Streak protection" in Talk Me Out Of It.
 * It has to live here (a scheduled Cloud Function), not in the client
 * app, because it needs to fire a real push notification while the app
 * is closed — the client-side code has no way to run once the tab/app
 * isn't open.
 *
 * There's no Settings toggle for this — it's on by default for anyone
 * who has push notifications enabled at all (i.e. has an fcmToken saved
 * from the notifications prompt or the Wait check-ins / reminders flow).
 * If someone has never granted notification permission, this silently
 * does nothing for them (see the `!profile.fcmToken` check below).
 *
 * WHAT IT DOES
 * Every 30 minutes, this function looks at every user with a saved push
 * token. For anyone with an active day-streak who hasn't logged anything
 * (a purchase check-in or a spending entry) yet today, and for whom it's
 * currently evening in their local time — per-person, from
 * `profile.timezone` (see below) — it sends one push notification
 * reminding them their streak ends tonight, and never sends a second one
 * on the same calendar day.
 *
 * WHERE THIS GOES
 * Add this file next to your other Cloud Functions files (the existing
 * comment in Index.html references `scheduled-reminders-functions.js`,
 * so this can live alongside that one, or be merged into it) and export
 * it from your functions project's index.js, e.g.:
 *
 *   exports.streakAtRiskCheck = require("./streak-protection-function").streakAtRiskCheck;
 *
 * Then deploy with:
 *   firebase deploy --only functions:streakAtRiskCheck
 *
 * REQUIRED SETUP
 * - firebase-admin and firebase-functions must already be dependencies of
 *   your functions project (they will be, if you have other functions).
 * - Firestore security rules don't need any changes for this — Admin SDK
 *   calls from Cloud Functions bypass Firestore security rules entirely.
 * - This assumes every user doc lives at `users/{uid}` with the same
 *   shape the client writes: `spendingLog` (an array field on the doc),
 *   `fcmToken`, and a `users/{uid}/purchases` subcollection with
 *   `createdAt` (a millisecond epoch number, matching Date.now() from
 *   the client).
 *
 * TIME ZONE
 * The client saves `Intl.DateTimeFormat().resolvedOptions().timeZone`
 * onto each profile automatically on login (see the useEffect in
 * Index.html near the theme/accent sync effect), so this function reads
 * `profile.timezone` per user. DEFAULT_TIMEZONE below is only a fallback
 * for accounts that predate that change and haven't logged in since —
 * it'll disappear on its own as people open the app again.
 */

const functions = require("firebase-functions");
const admin = require("firebase-admin");

if (admin.apps.length === 0) {
  admin.initializeApp();
}

const db = admin.firestore();

// Fallback time zone, only used for accounts with no profile.timezone
// yet (see the TIME ZONE note above the top of this file).
const DEFAULT_TIMEZONE = "America/Chicago";

// The reminder is only allowed to fire within this local-hour window, so
// it reads as "it's evening and your streak is about to end tonight"
// rather than an odd-hours ping.
const EVENING_WINDOW_START_HOUR = 19; // 7pm local
const EVENING_WINDOW_END_HOUR = 23; // 11pm local

function localDateKeyAndHour(timezone) {
  const now = new Date();
  const parts = new Intl.DateTimeFormat("en-US", {
    timeZone: timezone,
    year: "numeric", month: "2-digit", day: "2-digit", hour: "2-digit", hour12: false,
  }).formatToParts(now);
  const get = (type) => parts.find((p) => p.type === type)?.value;
  const dateKey = `${get("year")}-${get("month")}-${get("day")}`;
  // "24" shows up for midnight in some environments' formatToParts output;
  // normalize it to 0 so hour comparisons below behave.
  const hour = parseInt(get("hour"), 10) % 24;
  return { dateKey, hour };
}

// Mirrors dateKey()/computeDayStreak() in Index.html, translated to Node
// so the server can tell whether "today" (in the user's local time) has
// any logged activity yet, without needing to load the client bundle.
function dateKeyFromMillis(ms, timezone) {
  const parts = new Intl.DateTimeFormat("en-US", {
    timeZone: timezone,
    year: "numeric", month: "2-digit", day: "2-digit",
  }).formatToParts(new Date(ms));
  const get = (type) => parts.find((p) => p.type === type)?.value;
  return `${get("year")}-${get("month")}-${get("day")}`;
}

async function computeDayStreakAndTodayActivity(uid, profile, timezone) {
  const purchasesSnap = await db.collection("users").doc(uid).collection("purchases").get();
  const days = new Set();
  purchasesSnap.docs.forEach((doc) => {
    const p = doc.data();
    if (p.createdAt) days.add(dateKeyFromMillis(p.createdAt, timezone));
  });
  (profile.spendingLog || []).forEach((entry) => {
    // entry.date is already a "YYYY-MM-DD" string set client-side via
    // new Date().toISOString().slice(0, 10) — treated as-is here rather
    // than re-parsed, to match what the client itself considers "today".
    if (entry.date) days.add(entry.date);
  });

  const { dateKey: todayKey } = localDateKeyAndHour(timezone);
  const hasLoggedToday = days.has(todayKey);

  // Walk backward from yesterday (today doesn't count yet, since the
  // whole point is checking whether today is still empty) to see how
  // long a streak is actively at risk of breaking tonight.
  let streak = 0;
  const cursor = new Date();
  const cursorTz = (offsetDays) => {
    const d = new Date(cursor);
    d.setDate(d.getDate() - offsetDays);
    return dateKeyFromMillis(d.getTime(), timezone);
  };
  let offset = hasLoggedToday ? 0 : 1; // if today's already logged, no reminder needed anyway
  while (days.has(cursorTz(offset))) {
    streak++;
    offset++;
  }
  return { streak, hasLoggedToday };
}

exports.streakAtRiskCheck = functions.pubsub
  .schedule("every 30 minutes")
  .onRun(async () => {
    // No preference field to filter on anymore — this is on by default
    // for anyone who has a push token at all. `!=` against null catches
    // both "field is a real token" and skips docs where it's explicitly
    // null or missing.
    const usersSnap = await db
      .collection("users")
      .where("fcmToken", "!=", null)
      .get();

    if (usersSnap.empty) return null;

    const results = await Promise.allSettled(
      usersSnap.docs.map((doc) => processUser(doc.id, doc.data()))
    );

    results.forEach((r, i) => {
      if (r.status === "rejected") {
        console.error(`streakAtRiskCheck failed for user ${usersSnap.docs[i].id}:`, r.reason);
      }
    });
    return null;
  });

async function processUser(uid, profile) {
  if (!profile.fcmToken) return; // nothing to push to

  const timezone = profile.timezone || DEFAULT_TIMEZONE;
  const { dateKey: todayKey, hour } = localDateKeyAndHour(timezone);

  if (hour < EVENING_WINDOW_START_HOUR || hour >= EVENING_WINDOW_END_HOUR) return;
  if (profile.streakPushSentFor === todayKey) return; // already reminded today

  const { streak, hasLoggedToday } = await computeDayStreakAndTodayActivity(uid, profile, timezone);
  if (hasLoggedToday || streak <= 0) return;

  const message = {
    token: profile.fcmToken,
    notification: {
      title: "Your streak ends tonight",
      body: `You're on a ${streak}-day streak — log something before midnight to keep it alive.`,
    },
    webpush: {
      fcmOptions: { link: "/" },
    },
  };

  try {
    await admin.messaging().send(message);
    await db.collection("users").doc(uid).set(
      { streakPushSentFor: todayKey },
      { merge: true }
    );
  } catch (err) {
    // A stale/invalid token is expected over time (uninstalls, cleared
    // site data, etc.) — clear it so future runs stop retrying it.
    if (
      err.code === "messaging/registration-token-not-registered" ||
      err.code === "messaging/invalid-registration-token"
    ) {
      await db.collection("users").doc(uid).set({ fcmToken: null }, { merge: true });
    } else {
      throw err;
    }
  }
}

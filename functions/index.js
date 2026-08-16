const { onSchedule } = require("firebase-functions/v2/scheduler");
const { onRequest } = require("firebase-functions/v2/https");
const { defineSecret } = require("firebase-functions/params");
const admin = require("firebase-admin");
admin.initializeApp();

const db = admin.firestore();
const messaging = admin.messaging();

// ---------------------------------------------------------------
// REMINDERS (Gen 2 scheduled functions)
// ---------------------------------------------------------------
exports.sendReminders = onSchedule("every day 10:00", async (event) => {
  const usersSnap = await db.collection("users").get();
  const now = Date.now();
  const sevenDaysMs = 7 * 24 * 60 * 60 * 1000;

  const sends = [];

  usersSnap.forEach((doc) => {
    const user = doc.data();
    if (!user.fcmToken) return;

    const prefs = user.notificationPrefs || {};
    const lastActive = user.lastActiveAt ? user.lastActiveAt.toMillis() : 0;
    const inactiveTooLong = (now - lastActive) > sevenDaysMs;

    if (prefs.inactivityReminders && inactiveTooLong) {
      sends.push(messaging.send({
        token: user.fcmToken,
        notification: {
          title: "Talk Me Out Of It",
          body: "Haven't seen you in a while â€” check in on your goals!",
        },
      }).catch((err) => console.error("Send failed for", doc.id, err)));
    }
  });

  await Promise.all(sends);
  console.log(`Checked ${usersSnap.size} users, sent ${sends.length} reminders.`);
});

exports.sendContributionReminders = onSchedule("every day 10:30", async (event) => {
  const usersSnap = await db.collection("users").get();
  const now = Date.now();
  const threeDaysMs = 3 * 24 * 60 * 60 * 1000;

  const sends = [];

  usersSnap.forEach((doc) => {
    const user = doc.data();
    if (!user.fcmToken) return;

    const prefs = user.notificationPrefs || {};
    if (!prefs.contributionReminders) return;

    const goals = user.goals || [];
    goals.forEach((goal) => {
      if (!goal.targetDate) return;
      if (goal.currentAmount >= goal.targetAmount) return;

      const targetMs = goal.targetDate.toMillis ? goal.targetDate.toMillis() : new Date(goal.targetDate).getTime();
      const msUntilDue = targetMs - now;

      const isComingUpSoon = msUntilDue > 0 && msUntilDue <= threeDaysMs;
      const isOverdue = msUntilDue < 0;

      if (isComingUpSoon || isOverdue) {
        const body = isOverdue
          ? `Your "${goal.name}" goal payment is overdue.`
          : `Your "${goal.name}" goal payment is coming up soon.`;

        sends.push(messaging.send({
          token: user.fcmToken,
          notification: {
            title: "Talk Me Out Of It",
            body: body,
          },
        }).catch((err) => console.error("Send failed for", doc.id, err)));
      }
    });
  });

  await Promise.all(sends);
  console.log(`Checked ${usersSnap.size} users, sent ${sends.length} contribution reminders.`);
});

// ---------------------------------------------------------------
// STRIPE â€” Payment Links now handle checkout itself (no more
// createCheckoutSession); this webhook just confirms payment and
// upgrades the right user. Secrets come from Secret Manager
// (firebase functions:secrets:set STRIPE_SECRET_KEY /
// STRIPE_WEBHOOK_SECRET) â€” Gen 2 reads them via defineSecret().
// ---------------------------------------------------------------
const Stripe = require("stripe");

const stripeSecretKeyParam = defineSecret("STRIPE_SECRET_KEY");
const stripeWebhookSecretParam = defineSecret("STRIPE_WEBHOOK_SECRET");

exports.stripeWebhook = onRequest(
  { secrets: [stripeSecretKeyParam, stripeWebhookSecretParam] },
  async (req, res) => {
    const stripe = Stripe(stripeSecretKeyParam.value());
    const sig = req.headers["stripe-signature"];

    let event;
    try {
      event = stripe.webhooks.constructEvent(req.rawBody, sig, stripeWebhookSecretParam.value());
    } catch (err) {
      console.error("Webhook signature verification failed:", err.message);
      res.status(400).send(`Webhook Error: ${err.message}`);
      return;
    }

    try {
      if (event.type === "checkout.session.completed") {
        const session = event.data.object;
        const uid = session.client_reference_id || session.metadata?.uid;

        if (uid) {
          await db.collection("users").doc(uid).set(
            {
              subscription: "premium",
              stripeCustomerId: session.customer,
              stripeSubscriptionId: session.subscription,
            },
            { merge: true }
          );
        }
      }

      if (event.type === "customer.subscription.deleted") {
        const subscription = event.data.object;
        const snap = await db
          .collection("users")
          .where("stripeSubscriptionId", "==", subscription.id)
          .limit(1)
          .get();

        if (!snap.empty) {
          await snap.docs[0].ref.set({ subscription: "free" }, { merge: true });
        }
      }

      res.status(200).send("ok");
    } catch (err) {
      console.error("Webhook handling failed:", err);
      res.status(500).send("Internal error");
    }
  }
);

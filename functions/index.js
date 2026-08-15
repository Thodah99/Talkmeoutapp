/**
 * Talk Me Out Of It â€” Cloud Functions backend
 * -------------------------------------------
 * Two features live here:
 *   1. Stripe (stripeWebhook â€” Payment Links handle checkout itself now,
 *      this function just confirms payment and upgrades the user)
 *   2. Push notifications (registerFcmToken + sendDailyReminders)
 *
 * SETUP â€” run these once from your project root before deploying:
 *
 *   cd functions
 *   npm install stripe firebase-admin firebase-functions
 *
 *   firebase functions:secrets:set STRIPE_SECRET_KEY
 *   firebase functions:secrets:set STRIPE_WEBHOOK_SECRET
 *
 * Then deploy:
 *   firebase deploy --only functions
 */

const functions = require("firebase-functions");
const admin = require("firebase-admin");
admin.initializeApp();

const db = admin.firestore();

// ---------------------------------------------------------------
// STRIPE SETUP
// ---------------------------------------------------------------
// Reads secrets set via `firebase functions:secrets:set` (Secret
// Manager) â€” exposed as environment variables at runtime. Every
// exported function below that needs Stripe declares
// .runWith({ secrets: [...] }) so these are actually populated.
function stripeSecretKey() {
  return process.env.STRIPE_SECRET_KEY;
}
function stripeWebhookSecret() {
  return process.env.STRIPE_WEBHOOK_SECRET;
}

const Stripe = require("stripe");

// ---------------------------------------------------------------
// 1. stripeWebhook â€” HTTP function, called by Stripe (not your frontend)
//    You're using Stripe Payment Links now, so checkout itself happens
//    entirely on Stripe's side â€” this function just listens for the
//    payment confirmation and upgrades the right Firebase user.
//    Register this URL in the Stripe Dashboard â†’ Developers â†’ Webhooks:
//      https://<region>-<project-id>.cloudfunctions.net/stripeWebhook
//    Subscribe it to: checkout.session.completed,
//                      customer.subscription.deleted
//    Payment Links support ?client_reference_id=<uid> appended to the
//    URL â€” that's what lets this function know which user paid.
// ---------------------------------------------------------------
exports.stripeWebhook = functions
  .runWith({ secrets: ["STRIPE_SECRET_KEY", "STRIPE_WEBHOOK_SECRET"] })
  .https.onRequest(async (req, res) => {
    const stripe = Stripe(stripeSecretKey());
    const sig = req.headers["stripe-signature"];

    let event;
    try {
      // req.rawBody is required for signature verification â€” this only
      // works if this function receives the raw body, which onRequest
      // gives you automatically (don't add a body-parsing middleware).
      event = stripe.webhooks.constructEvent(req.rawBody, sig, stripeWebhookSecret());
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
        // Find the user by their stored subscription id and downgrade them.
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
  });

// ---------------------------------------------------------------
// 2. registerFcmToken â€” callable function
//    Not currently used by the client (it writes the token to
//    Firestore directly), but left here in case that changes later.
//    Tokens are stored as an array since a person may open the app
//    on more than one device.
// ---------------------------------------------------------------
exports.registerFcmToken = functions.https.onCall(async (data, context) => {
  if (!context.auth) {
    throw new functions.https.HttpsError("unauthenticated", "You must be signed in.");
  }
  const { token } = data;
  if (!token) {
    throw new functions.https.HttpsError("invalid-argument", "Missing token.");
  }

  const uid = context.auth.uid;
  await db
    .collection("users")
    .doc(uid)
    .set(
      { fcmTokens: admin.firestore.FieldValue.arrayUnion(token) },
      { merge: true }
    );

  return { ok: true };
});

// ---------------------------------------------------------------
// 3. sendDailyReminders â€” scheduled function
//    Runs once a day, looks at each user's notification prefs, and
//    sends a push to anyone who's opted in and due for a nudge.
//    Adjust the schedule string to whatever time makes sense for you.
// ---------------------------------------------------------------
exports.sendDailyReminders = functions.pubsub
  .schedule("every day 09:00")
  .timeZone("America/Chicago")
  .onRun(async () => {
    const usersSnap = await db.collection("users").get();
    const now = Date.now();
    const oneWeekMs = 7 * 24 * 60 * 60 * 1000;

    const sends = [];

    usersSnap.forEach((doc) => {
      const profile = doc.data();
      const tokens = profile.fcmTokens;
      if (!tokens || tokens.length === 0) return;

      const prefs = profile.notificationPrefs || {};
      let title = null;
      let body = null;

      // Inactivity reminder â€” nudge if they haven't logged a purchase in a week.
      if (prefs.inactivityReminders && profile.lastLoginDate) {
        const lastLogin = new Date(profile.lastLoginDate).getTime();
        if (now - lastLogin > oneWeekMs) {
          title = "Haven't seen you in a while";
          body = "Log a purchase or check in on your goals in Talk Me Out Of It.";
        }
      }

      // Contribution reminders would need each group goal's due dates
      // pulled in here too â€” left as a follow-up since group goals
      // aren't in Firestore yet (see the comment near firebaseConfig
      // in Index.html).

      if (title && body) {
        sends.push(
          admin.messaging().sendEachForMulticast({
            tokens,
            notification: { title, body },
          })
        );
      }
    });

    await Promise.all(sends);
    return null;
  });

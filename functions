/**
 * Talk Me Out Of It — Cloud Functions backend
 * -------------------------------------------
 * Two features live here:
 *   1. Stripe Checkout (createCheckoutSession + stripeWebhook)
 *   2. Push notifications (registerFcmToken + sendDailyReminders)
 *
 * SETUP — run these once from your project root before deploying:
 *
 *   cd functions
 *   npm install stripe firebase-admin firebase-functions
 *
 *   firebase functions:config:set stripe.secret="sk_test_..." stripe.webhook_secret="whsec_..."
 *
 *   (If you're on functions v2 / newer firebase-tools, use secrets instead —
 *   see the note above stripeSecretKey() below.)
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
// Pulls your secret key from Firebase config (set via the CLI command
// in the header comment above). Never hardcode this key in source.
function stripeSecretKey() {
  return functions.config().stripe?.secret;
}
function stripeWebhookSecret() {
  return functions.config().stripe?.webhook_secret;
}

const Stripe = require("stripe");

// ---------------------------------------------------------------
// 1. createCheckoutSession — callable function
//    Frontend calls this via functions.httpsCallable("createCheckoutSession")
// ---------------------------------------------------------------
exports.createCheckoutSession = functions.https.onCall(async (data, context) => {
  if (!context.auth) {
    throw new functions.https.HttpsError("unauthenticated", "You must be signed in to upgrade.");
  }

  const stripe = Stripe(stripeSecretKey());
  const { priceId, returnUrl } = data;

  if (!priceId || !returnUrl) {
    throw new functions.https.HttpsError("invalid-argument", "Missing priceId or returnUrl.");
  }

  const uid = context.auth.uid;

  try {
    const session = await stripe.checkout.sessions.create({
      mode: "subscription",
      payment_method_types: ["card"],
      line_items: [{ price: priceId, quantity: 1 }],
      // client_reference_id lets the webhook know which Firebase user
      // this checkout belongs to, without trusting anything the client sends.
      client_reference_id: uid,
      metadata: { uid },
      success_url: `${returnUrl}?upgraded=true`,
      cancel_url: returnUrl,
    });

    return { url: session.url };
  } catch (err) {
    console.error("Stripe session creation failed:", err);
    throw new functions.https.HttpsError("internal", "Could not create checkout session.");
  }
});

// ---------------------------------------------------------------
// 2. stripeWebhook — HTTP function, called by Stripe (not your frontend)
//    Register this URL in the Stripe Dashboard → Developers → Webhooks:
//      https://<region>-<project-id>.cloudfunctions.net/stripeWebhook
//    Subscribe it to: checkout.session.completed,
//                      customer.subscription.deleted
// ---------------------------------------------------------------
exports.stripeWebhook = functions.https.onRequest(async (req, res) => {
  const stripe = Stripe(stripeSecretKey());
  const sig = req.headers["stripe-signature"];

  let event;
  try {
    // req.rawBody is required for signature verification — this only
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
// 3. registerFcmToken — callable function
//    Frontend calls this after getting a device token from FCM, so we
//    have somewhere to send pushes to. Tokens are stored as an array
//    since a person may open the app on more than one device.
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
// 4. sendDailyReminders — scheduled function
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

      // Inactivity reminder — nudge if they haven't logged a purchase in a week.
      if (prefs.inactivityReminders && profile.lastLoginDate) {
        const lastLogin = new Date(profile.lastLoginDate).getTime();
        if (now - lastLogin > oneWeekMs) {
          title = "Haven't seen you in a while";
          body = "Log a purchase or check in on your goals in Talk Me Out Of It.";
        }
      }

      // Contribution reminders would need each group goal's due dates
      // pulled in here too — left as a follow-up since group goals
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

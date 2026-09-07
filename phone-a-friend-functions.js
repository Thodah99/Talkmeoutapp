// Phone a Friend push notifications.
// Merge these into your existing Cloud Functions project — the same one
// that already has callCompanion, stripeWebhook, sendReminders, and
// sendContributionReminders — then `firebase deploy --only functions`.
//
// Two Firestore triggers on the top-level `feedPosts` collection:
//   1. onCreate  — a new post goes up  -> notify active users ("come vote")
//   2. onUpdate  — votes change on a post -> notify the poster, but only
//      the first time it goes from 0 votes to having any (avoids a push
//      per vote, which would get spammy fast)
//
// Written as 2nd Gen (firebase-functions/v2/firestore) to match the rest
// of this project — 1st Gen triggers don't support the Node 24 runtime.
//
// Requires the `feedPosts` Firestore rule from the app code comment,
// and reuses the same `fcmToken` field on each user doc that your
// existing sendReminders function already relies on.

const { onDocumentCreated, onDocumentUpdated } = require("firebase-functions/v2/firestore");
const admin = require("firebase-admin");
if (!admin.apps.length) admin.initializeApp();
const db = admin.firestore();

// 1. New post -> notify active users that someone needs a vote.
// Broad "everyone with a token" for now, same call you made with
// sendReminders when the user base is small — swap to "past voters
// only" (query users who have voterUids entries somewhere, or add a
// dedicated notificationPrefs.phoneAFriendAlerts flag) once volume
// picks up and this starts feeling noisy.
exports.notifyNewFeedPost = onDocumentCreated("feedPosts/{postId}", async (event) => {
  const post = event.data.data();
  const postId = event.params.postId;

  const usersSnap = await db.collection("users")
    .where("fcmToken", "!=", null)
    .get();

  const tokens = usersSnap.docs
    .filter((d) => d.id !== post.uid) // don't notify the poster about their own post
    .map((d) => d.data().fcmToken)
    .filter(Boolean);

  if (tokens.length === 0) return;

  const message = {
    notification: {
      title: "Talk Me Out Of It",
      body: "You've been summoned — got a sec?",
    },
    data: { type: "phone_a_friend_new_post", postId },
    tokens,
  };

  try {
    await admin.messaging().sendEachForMulticast(message);
  } catch (e) {
    console.error("notifyNewFeedPost failed:", e);
  }
});

// 2. Votes land on your post -> notify just the poster, once, the
// first time it crosses from 0 votes to having any.
exports.notifyFeedPostVoted = onDocumentUpdated("feedPosts/{postId}", async (event) => {
  const before = event.data.before.data();
  const after = event.data.after.data();
  const postId = event.params.postId;

  const votesBefore = (before.votes?.hit || 0) + (before.votes?.skip || 0);
  const votesAfter = (after.votes?.hit || 0) + (after.votes?.skip || 0);
  if (votesBefore > 0 || votesAfter === 0) return; // only fire on the 0 -> 1+ crossing

  const userDoc = await db.collection("users").doc(after.uid).get();
  const token = userDoc.exists ? userDoc.data().fcmToken : null;
  if (!token) return;

  const message = {
    notification: {
      title: "Talk Me Out Of It",
      body: `The jury's back — ${votesAfter} vote${votesAfter !== 1 ? "s" : ""} on your ${after.itemName}.`,
    },
    data: { type: "phone_a_friend_voted", postId, purchaseId: after.purchaseId },
    token,
  };

  try {
    await admin.messaging().send(message);
  } catch (e) {
    console.error("notifyFeedPostVoted failed:", e);
  }
});

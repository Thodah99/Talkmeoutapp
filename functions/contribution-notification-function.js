// ---------------------------------------------------------------
// GROUP GOAL CONTRIBUTION NOTIFICATIONS (Gen 2 Firestore trigger)
// Fires when a groupGoals/{groupId} doc updates. Compares the
// "before" and "after" participants[].schedule[] entries to find
// any contribution that just flipped from completed:false to
// completed:true, then notifies the OTHER members of that group
// (not the person who just logged it).
// ---------------------------------------------------------------
const { onDocumentUpdated } = require("firebase-functions/v2/firestore");

exports.notifyOnContributionLogged = onDocumentUpdated(
  "groupGoals/{groupId}",
  async (event) => {
    const before = event.data.before.data();
    const after = event.data.after.data();

    if (!before || !after) return;

    const beforeParticipants = before.participants || [];
    const afterParticipants = after.participants || [];

    // Find which participant just logged a new completed contribution
    let loggedByName = null;
    let loggedByUid = null;

    afterParticipants.forEach((afterP, pIndex) => {
      const beforeP = beforeParticipants[pIndex];
      if (!beforeP) return;

      const beforeSchedule = beforeP.schedule || [];
      const afterSchedule = afterP.schedule || [];

      afterSchedule.forEach((afterEntry, sIndex) => {
        const beforeEntry = beforeSchedule[sIndex];
        if (!beforeEntry) return;

        const justCompleted = !beforeEntry.completed && afterEntry.completed;
        if (justCompleted) {
          loggedByName = afterP.name;
          loggedByUid = afterP.uid;
        }
      });
    });

    // No new completion found in this update — nothing to notify
    if (!loggedByUid) return;

    const goalName = after.name || "your group goal";
    const otherUids = (after.memberUids || []).filter((uid) => uid !== loggedByUid);

    if (otherUids.length === 0) return;

    const sends = [];

    for (const uid of otherUids) {
      const userDoc = await db.collection("users").doc(uid).get();
      if (!userDoc.exists) continue;

      const user = userDoc.data();
      if (!user.fcmToken) continue;

      const prefs = user.notificationPrefs || {};
      if (!prefs.contributionReminders) continue;

      sends.push(
        messaging
          .send({
            token: user.fcmToken,
            notification: {
              title: "Talk Me Out Of It",
              body: `${loggedByName} just logged their contribution to "${goalName}"! 🎉`,
            },
          })
          .catch((err) => console.error("Send failed for", uid, err))
      );
    }

    await Promise.all(sends);
    console.log(
      `Group "${goalName}": notified ${sends.length} member(s) that ${loggedByName} logged a contribution.`
    );
  }
);

// This file must be served from your site's root (same folder as index.html),
// e.g. https://talkmeout-8692f.web.app/firebase-messaging-sw.js
// It's what lets push notifications arrive even when the app/tab is closed.

importScripts("https://www.gstatic.com/firebasejs/10.13.0/firebase-app-compat.js");
importScripts("https://www.gstatic.com/firebasejs/10.13.0/firebase-messaging-compat.js");

// Must match the firebaseConfig object in Index.html.
firebase.initializeApp({
  apiKey: "AIzaSyBsndiXn0PytRe3cMU6Bby7gCFR7CsyXag",
  authDomain: "talkmeout-8692f.firebaseapp.com",
  projectId: "talkmeout-8692f",
  storageBucket: "talkmeout-8692f.firebasestorage.app",
  messagingSenderId: "83068354107",
  appId: "1:83068354107:web:917169cddc81865133261e",
});

const messaging = firebase.messaging();

messaging.onBackgroundMessage((payload) => {
  const { title, body } = payload.notification || {};
  self.registration.showNotification(title || "Talk Me Out Of It", {
    body: body || "",
    icon: "/icon-192.png", // swap for your actual app icon path if you have one
  });
});

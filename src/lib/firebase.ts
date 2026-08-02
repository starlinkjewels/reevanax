import { initializeApp, type FirebaseApp } from "firebase/app";
import { getAuth, type Auth } from "firebase/auth";
import {
  initializeFirestore,
  persistentLocalCache,
  persistentSingleTabManager,
  type Firestore,
} from "firebase/firestore";

const firebaseConfig = {
  apiKey: "AIzaSyDInBeT_ytLjhkRv_J3rtagRXUdY4WfEds",
  authDomain: "ibellmobiles-123.firebaseapp.com",
  projectId: "ibellmobiles-123",
  storageBucket: "ibellmobiles-123.firebasestorage.app",
  messagingSenderId: "191077483403",
  appId: "1:191077483403:web:1c934544f5b7e3cbc0658e",
  measurementId: "G-3WSQ6FXD71",
};

/** Named Firestore database (not the "(default)" one) */
export const DATABASE_ID = "ibelldatabasefortelegramboat";

export const isBrowser = typeof window !== "undefined";

let app: FirebaseApp | undefined;
let authInstance: Auth | undefined;
let dbInstance: Firestore | undefined;

// The Firebase client SDK is browser-only in this app; during SSR the
// repositories return empty data (same behaviour as the old localStorage layer).
if (isBrowser) {
  app = initializeApp(firebaseConfig);
  authInstance = getAuth(app);
  // Offline-first: writes queue locally and sync when internet returns,
  // reads keep working from the persistent cache — important for a shop counter.
  //
  // Single-tab manager, not multi-tab: the app already has its own in-app
  // tab bar inside one browser tab, so real cross-browser-tab sync buys
  // nothing here. Multi-tab mode's cross-tab IndexedDB lease/lock
  // coordination is a well-known source of hangs on Safari/macOS (WebKit's
  // stricter IndexedDB behavior + background-tab throttling can stall the
  // lease handoff) — single-tab persistence keeps the same offline-cache
  // benefit without that cross-tab coordination surface.
  //
  // forceOwnership: true is essential here, not optional — without it, a
  // freshly opened/reloaded tab WAITS for any other tab already holding the
  // persistence lock to release it. If that other tab is a backgrounded or
  // already-closed Safari tab (session restore on relaunch is common on
  // macOS), the lease handoff can stall indefinitely — the app just hangs
  // on load with nothing on screen. forceOwnership makes the new tab seize
  // the lock immediately instead of waiting.
  dbInstance = initializeFirestore(
    app,
    {
      localCache: persistentLocalCache({
        tabManager: persistentSingleTabManager({ forceOwnership: true }),
      }),
    },
    DATABASE_ID,
  );
}

export const auth = authInstance as Auth;
export const db = dbInstance as Firestore;

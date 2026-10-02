# Native Hermie for Android

Not started. This directory is reserved so the layout is settled before any code arrives.

Until a native Android app exists and reaches parity, Android stays on the Expo app, which keeps being
built, tested and released as it is today.

Two things have to exist first:

- **The `contract/` golden corpus.** The native apps are held to the Expo app's behaviour by a
  language-neutral corpus recorded from the TypeScript test suites: transcript engine calls, gateway
  vectors, frames and the push contract. The Apple apps are built against it first; a Kotlin port tests
  against the same files rather than re-deriving the behaviour.
- **Firebase Cloud Messaging in the push relay.** The relay that replaces Expo's push service for the
  Apple apps speaks to APNs only. An Android app needs it to deliver through FCM as well before it can drop
  Expo's.

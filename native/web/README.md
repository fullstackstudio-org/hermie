# Native Hermie for the web

Not started. This directory is reserved so the layout is settled before any code arrives.

Until a dedicated web build exists, the browser stays on the Expo app's web export, which Hermie Web
serves unchanged through `npm run web:build`.

Two things have to exist first:

- **The `contract/` golden corpus.** A new web client is held to the same behaviour as every other Hermie
  by the language-neutral corpus recorded from the TypeScript test suites, rather than by re-reading the
  Expo app.
- **The Hermie Web export seam.** Hermie Web serves whatever the web export step produces. Switching it to
  a new bundle has to be one change to that export step, with no change to the server, before there is a
  second bundle to switch to.

Push in the browser keeps using Web Push through Hermie Web, so the push relay is not a prerequisite here.

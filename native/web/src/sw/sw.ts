/**
 * The service worker's entry, built to `dist/sw.js` (`vite.config.ts`) and
 * registered by the page with the client's directory as its scope
 * (`core/push/platform.ts`). Everything it does is in `worker.ts`; this file only
 * hands it the scope it runs in, and exports nothing, so the built file is a
 * plain script with no `import` or `export` in it.
 */
import { installWorker, type WorkerScope } from './worker'

installWorker(self as unknown as WorkerScope)

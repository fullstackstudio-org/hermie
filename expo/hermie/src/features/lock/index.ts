export { AppLock, type AppLockProps } from './AppLock'
export { LockPlate, type LockPlateProps } from './LockPlate'
export {
  background,
  DEFAULT_LOCK_THRESHOLD,
  foreground,
  graceMsOf,
  isLockThreshold,
  LOCK_THRESHOLDS,
  type LockMachine,
  type LockThreshold,
  start,
  thresholdChanged,
  unlockFailed,
  unlocked
} from './lock-state'
export { APP_LOCK_KEY, type LockState, useLockStore } from './store'

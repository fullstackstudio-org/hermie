import type {
  AuthTimeline,
  AuthEventRecorder,
  ConnectionStatus,
  GatewayConnection,
  GatewayError,
  GatewayHttp,
  RequestOptions,
  TokenCoordinator,
  TokenSet
} from '@hermie/gateway-client'
import { describeFrontDoor } from '@hermie/gateway-client'
import { createContext, useCallback, useContext, useEffect, useMemo, useRef, useState, type ReactNode } from 'react'

import { seedDevGateway } from '../dev/seed-gateway'
import { useOwnAuthorStore } from '../features/chats/own-author'
import type { ResumeAccess } from '../features/onboarding/draft'
import { retirePushRegistration } from '../features/push/runtime'
import { createPersistentAuthTimeline } from './auth-timeline'
import { attachLifecycle, createGatewayConnection, createTokenCoordinator, endGatewaySession } from './client'
import { clearCredentials, clearGateway, type GatewaySetup, loadGatewaySetup, type StoredGatewayConfig } from './config'
import { migrateGatewayStorage } from './migrate'
import { namespace, type GatewayNamespace } from './namespace'
import { purgeGatewayStorage } from './purge'
import {
  activeGatewayOf,
  updateGateway,
  EMPTY_REGISTRY,
  type GatewayRecord,
  type GatewayRegistry,
  gatewayById,
  loadGatewayRegistry,
  reconcileActiveGateway,
  removeGateway,
  renameGateway,
  saveGatewayRegistry,
  setActiveGateway,
  sweepOrphanGatewayConfigs
} from './registry'
import { useConnectionStore } from './store'

/**
 * `loading` is the disk read at startup, `onboarding` means there is no usable
 * gateway to connect to (never configured, or signed out), and `connected`
 * means one `GatewayConnection` exists and owns the socket for the rest of the
 * app's lifetime.
 */
export type GatewayPhase = 'loading' | 'onboarding' | 'connected'

/**
 * What the wizard should open on when `phase` is `onboarding`.
 *
 * `fresh` is a first run, `signin` is a sign-out with the address still stored,
 * and `address` is the way off a gateway that cannot be used: setup reopens on
 * its address step with the stored address filled in, nothing on disk has been
 * touched, and the trip can therefore be cancelled.
 */
export type OnboardingIntent = 'fresh' | 'signin' | 'address'

export interface GatewayContextValue {
  phase: GatewayPhase
  /** Set when the user signed out: the address survives, the credentials do not. */
  resumeConfig: StoredGatewayConfig | null
  /**
   * The way IN to that address: the custom headers and the front door.
   *
   * Handed to the wizard beside `resumeConfig` because without it a resumed
   * setup cannot get past its own probe — a gateway behind an access proxy
   * answers `/api/status` with a 403 to anyone who does not carry the proxy's
   * credential, so the step would fail before reaching the sign-in it opened
   * for. Null when nothing is configured.
   */
  resumeAccess: ResumeAccess | null
  /** Which step the wizard opens on, and whether it can be backed out of. */
  resumeIntent: OnboardingIntent
  connection: GatewayConnection | null
  status: ConnectionStatus
  lastError: GatewayError | null
  config: StoredGatewayConfig | null
  /**
   * Every gateway this device knows about, and which one is live.
   *
   * Exposed rather than read from disk by whoever wants it, because there is
   * exactly one live connection and therefore exactly one right answer at a
   * time: a second reader of the key would be a second place for the list and
   * the socket to disagree.
   */
  registry: GatewayRegistry
  /** The active entry, or `null` while nothing is configured. */
  gateway: GatewayRecord | null
  /** The active gateway's id — what every namespaced store is keyed by. */
  gatewayId: string | null
  extraHeaders: Record<string, string>
  http: GatewayHttp | null
  /**
   * False when the stored sign-in has no refresh token: this session ends when
   * its access token expires and no reconnect will save it. True for every
   * other mode and whenever nothing is configured, so only the case that needs
   * saying says anything.
   */
  canRefresh: boolean
  /**
   * Record one event on the app's auth ring.
   *
   * Exposed because the two places a sign-in actually happens — the wizard and
   * the in-place re-auth — are React, and the ring belongs to this provider.
   * A no-op before the ring has been restored, which is a launch that has not
   * reached the wizard yet.
   */
  recordAuth: AuthEventRecorder['record']
  /** One JSON-RPC call on the live connection. Throws while there is none. */
  request: GatewayConnection['request']
  /** Adopt tokens from an in-place sign-in and resume the dial loop. */
  adoptTokens: (tokens: TokenSet) => Promise<void>
  /** Re-read the configuration from disk and connect; the wizard calls this when it finishes. */
  reload: () => Promise<void>
  /** Dial now: reset the ladder, or restart a loop that has stopped. See below. */
  retryNow: () => void
  signOut: () => Promise<void>
  /** Reopen setup on the address step; nothing stored is dropped until a different gateway is applied. */
  changeGateway: () => Promise<void>
  /** Forget the address and the credentials, and start setup empty. */
  forgetGateway: () => Promise<void>
  /**
   * Make another configured gateway the live one.
   *
   * One live connection at a time ([ADR-0006](../../../../docs/adr/0006-single-gateway-no-relay.md)),
   * so this is a teardown and a dial rather than a second socket. The screens
   * paint from the new gateway's own cache while that dial is in flight, which
   * is the same path a cold start takes and the reason the switch does not sit
   * on a spinner.
   *
   * A no-op for the gateway that is already live, and for an id the list does
   * not have.
   */
  switchGateway: (id: string) => Promise<void>
  /** Rename one entry. The name is this device's; nothing is sent anywhere. */
  renameGateway: (id: string, name: string) => Promise<void>
  /** Sign out of one gateway, live or not: its credentials go, its address stays. */
  signOutOf: (id: string) => Promise<void>
  /** Remove one gateway and everything it left on this device. */
  removeGateway: (id: string) => Promise<void>
  /** Re-read the list after something outside this provider changed it. */
  refreshRegistry: () => Promise<void>
}

const GatewayContext = createContext<GatewayContextValue | null>(null)

function toGatewayConfig(setup: GatewaySetup) {
  const { config, extraHeaders } = setup

  return {
    baseUrl: config.baseUrl,
    authMode: config.authMode,
    ...(config.provider ? { provider: config.provider } : {}),
    extraHeaders
  }
}

/**
 * Owns the app's single `GatewayConnection` for as long as a gateway is
 * configured. One instance, never replaced while it lives: the vendored
 * JSON-RPC client keeps per-session sequence watermarks, and those are what make
 * replay work across a reconnect.
 */
export function GatewayProvider({ children }: { children: ReactNode }) {
  const [phase, setPhase] = useState<GatewayPhase>('loading')
  const [setup, setSetup] = useState<GatewaySetup | null>(null)
  const [resumeConfig, setResumeConfig] = useState<StoredGatewayConfig | null>(null)
  const [resumeAccess, setResumeAccess] = useState<ResumeAccess | null>(null)
  const [resumeIntent, setResumeIntent] = useState<OnboardingIntent>('fresh')
  const [registry, setRegistry] = useState<GatewayRegistry>(EMPTY_REGISTRY)

  const connectionRef = useRef<GatewayConnection | null>(null)
  const coordinatorRef = useRef<TokenCoordinator | null>(null)
  const detachRef = useRef<(() => void) | null>(null)
  const unsubscribeRef = useRef<(() => void) | null>(null)
  // Outlives every connection here on purpose: `teardown` must not clear it.
  const timelineRef = useRef<AuthTimeline | null>(null)
  /** Which gateway the ring in `timelineRef` was restored for. */
  const timelineIdRef = useRef<string | null>(null)
  /** Whether this launch has already swept orphan configurations. See `reload`. */
  const sweptRef = useRef(false)

  const status = useConnectionStore(state => state.status)
  const lastError = useConnectionStore(state => state.lastError)
  const setStatus = useConnectionStore(state => state.setStatus)
  const setStoredConfig = useConnectionStore(state => state.setConfig)
  const setStoredFrontDoor = useConnectionStore(state => state.setFrontDoor)
  const resetStore = useConnectionStore(state => state.reset)

  const teardown = useCallback(() => {
    unsubscribeRef.current?.()
    detachRef.current?.()
    connectionRef.current?.stop()
    unsubscribeRef.current = null
    detachRef.current = null
    connectionRef.current = null
    coordinatorRef.current = null
    resetStore()
  }, [resetStore])

  const connect = useCallback(
    (loaded: GatewaySetup, ns: GatewayNamespace, timeline: AuthTimeline) => {
      teardown()

      // Only the native flow has tokens to rotate. A session token never
      // changes, and a cookie is rotated by the gateway behind the browser's
      // back — building a coordinator for either would give the connection a
      // refresher with nothing to refresh.
      const coordinator =
        loaded.config.authMode === 'native_pkce'
          ? createTokenCoordinator({
              baseUrl: loaded.config.baseUrl,
              extraHeaders: loaded.extraHeaders,
              namespace: ns,
              timeline
            })
          : null

      const connection = createGatewayConnection({
        config: toGatewayConfig(loaded),
        namespace: ns,
        timeline,
        ...(loaded.sessionToken ? { sessionToken: loaded.sessionToken } : {}),
        ...(coordinator ? { coordinator } : {})
      })

      connectionRef.current = connection
      coordinatorRef.current = coordinator
      unsubscribeRef.current = connection.onStatus((next, error) => setStatus(next, error))
      detachRef.current = attachLifecycle(connection)
      setStoredConfig(loaded.config)
      // The phrase, not the headers: `describeFrontDoor` reduces them to
      // presence here, once, so nothing downstream ever holds a value it could
      // print. See the note on `ConnectionStoreState.frontDoor`.
      setStoredFrontDoor(describeFrontDoor(loaded.extraHeaders))
      setSetup(loaded)
      setResumeConfig(null)
      setResumeAccess(null)
      setResumeIntent('fresh')
      setPhase('connected')
      connection.start()
    },
    [setStatus, setStoredConfig, setStoredFrontDoor, teardown]
  )

  /**
   * Say that the launch read went wrong, on every channel there is.
   *
   * Two of them, because neither is enough on its own. The ring is what the
   * owner can reach — Settings → Connection prints it, and it survives the
   * restart that usually follows — but it belongs to a gateway, and a failure
   * early enough in `reload` happens before there is one to belong to. The
   * console is the channel that is always there and never reaches the owner,
   * so it carries the whole error object rather than a name.
   *
   * `__DEV__` gates only the console: a release build should not print to a log
   * nobody is reading, and the ring costs nothing and is the half that matters
   * on a device in somebody's pocket.
   */
  const reportStartupIssue = useCallback((what: string, error: unknown) => {
    timelineRef.current?.record({ event: 'startup.failed' })

    if (__DEV__) {
      console.error(`[hermie] ${what}:`, error)
    }
  }, [])

  const reload = useCallback(async () => {
    // Development only, and BEFORE the read below rather than beside it: a launch
    // argument may name a gateway, and the point of it is that the ordinary read
    // then finds a configured one. Compiled out of a production bundle with the
    // rest of `src/dev`; see `seed-gateway.ts` for the three gates.
    await seedDevGateway()

    /*
      The list before the gateway, because the list is what says WHICH gateway.

      On the first launch after this shipped the read also performs the move:
      the single configured gateway becomes entry one, with the same address and
      the same credentials it already had. Nothing else changes and nothing is
      asked — see `loadGatewayRegistry`.
    */
    const { registry: stored, migratedId } = await loadGatewayRegistry()
    const active = activeGatewayOf(stored)

    // And the rest of that gateway's storage follows its entry. Before the read
    // below, because the configuration is one of the things being moved.
    if (migratedId && active) {
      await migrateGatewayStorage(namespace(migratedId), active.address)
    }

    /*
      Once per launch, and AFTER the move above, which is the only ordering that
      is safe: the move is what turns the unsuffixed configuration into an entry,
      and a sweep that ran first would be looking at a list that does not yet
      mention it.

      Once per launch rather than once ever, because "ever" would need a marker
      of its own and a marker is another thing that can be wrong. The cost is one
      `getAllKeys` on a store the launch is already reading, and on every device
      but the ones that collected orphans it finds nothing and writes nothing.
    */
    if (!sweptRef.current) {
      sweptRef.current = true

      const swept = await sweepOrphanGatewayConfigs(stored).catch((error: unknown) => {
        // Housekeeping must never be the reason a launch fails: there is a
        // gateway to dial and this was only ever about reclaiming space.
        reportStartupIssue('could not sweep orphan gateway configurations', error)

        return []
      })

      if (__DEV__ && swept.length > 0) {
        console.warn(`[hermie] removed ${swept.length} gateway configuration(s) that no entry claimed`)
      }
    }

    if (!active) {
      // Nothing configured. The ring belongs to a gateway now, so there is none
      // to restore either — the wizard is the whole of this state.
      teardown()
      setRegistry(stored)
      setSetup(null)
      setResumeConfig(null)
      setResumeAccess(null)
      setResumeIntent('fresh')
      setPhase('onboarding')

      return
    }

    const ns = namespace(active.id)

    /*
      One ring per gateway, restored here rather than once at startup.

      It has to span a sign-out and the reconnect that follows — that sequence
      is the whole reason it is persisted — and it has to be the ring belonging
      to the gateway now being dialled, because "the gateway rejected the saved
      sign-in" is a sentence about one machine.
    */
    if (!timelineRef.current || timelineIdRef.current !== ns.id) {
      timelineRef.current = await createPersistentAuthTimeline(ns)
      timelineIdRef.current = ns.id
    }

    const loaded = await loadGatewaySetup(ns)

    /*
      Keep the entry and the configuration in step.

      The wizard writes a `StoredGatewayConfig` and knows nothing about the
      registry, so this is where a freshly saved address, auth mode or signed-in
      name reaches the list. It is also the path a first run takes: there is no
      entry yet, and the configuration that has just been written becomes one.
    */
    const next = loaded ? reconcileActiveGateway(stored, loaded.config, Date.now()) : stored

    setRegistry(next)

    if (next !== stored) {
      await saveGatewayRegistry(next)
    }

    if (!loaded || !loaded.hasCredentials) {
      // A configured gateway with no credential beside it is the shape of the
      // "signed out after replacing the app bundle" report, and the ring is the
      // only thing that outlives the launch to say which of the two happened.
      if (loaded) {
        timelineRef.current?.record(loaded.credentialError ? { event: 'token.read_failed' } : { event: 'token.absent' })
      }

      teardown()
      setSetup(loaded)
      setResumeConfig(loaded?.config ?? null)
      setResumeAccess(loaded ? { customHeaders: loaded.customHeaders, frontDoor: loaded.frontDoor } : null)
      setResumeIntent(loaded ? 'signin' : 'fresh')
      setPhase('onboarding')

      return
    }

    connect(loaded, ns, timelineRef.current!)
  }, [connect, reportStartupIssue, teardown])

  useEffect(() => {
    // A rejection here used to escape into nothing and leave the app on the
    // splash screen for ever. Whatever went wrong, the wizard is a better
    // answer than a spinner with no end.
    //
    // It must not be a SILENT better answer, though, which is what this was
    // until the keychain started refusing on unsigned builds: the app dropped
    // onto Welcome on every launch and the only trace of the reason was the
    // storage it had half-written. The wizard is still where this lands; the
    // difference is that the reason is now on the ring and in the log.
    void reload().catch((error: unknown) => {
      reportStartupIssue('the stored gateway could not be read; opening setup instead', error)
      setPhase('onboarding')
    })

    return () => {
      teardown()
    }
    // Startup and teardown only: `reload` is stable and re-running this on a
    // later render would drop the live socket.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])

  /**
   * Dial now — the Re-check button, and the one thing the stopped screen can do
   * about a stopped connection.
   *
   * Two calls rather than one because `retryNow()` on the connection is
   * deliberately inert while the loop has stopped: redialling a `needs_signin`
   * or a refused address fails the same way and erases the explanation, so the
   * chat's Retry never has to ask what kind of failure it is looking at. The
   * stopped screen is the one caller that HAS asked — the reader pressed a
   * button that says Re-check on a card that says why — and `resume()` is what
   * restarts a stopped loop. Each is a no-op in the other's case, so the pair
   * reads as "dial now, whatever state this is in".
   */
  const retryNow = useCallback(() => {
    const connection = connectionRef.current

    if (!connection) {
      void reload()

      return
    }

    connection.resume()
    connection.retryNow()
  }, [reload])

  const signOut = useCallback(async () => {
    const keep = setup?.config ?? null
    const ns = registry.activeGatewayId ? namespace(registry.activeGatewayId) : null

    // FIRST, and awaited: ADR-0017's registration is only meaningful for the
    // gateway it was made on, and removing it is a `ui_meta` write that needs
    // the socket `teardown()` is about to close. See `features/push/runtime.ts`
    // for why this is a slot rather than a call on something in scope.
    await retirePushRegistration()

    // Before the local state goes: in the cookie flow the credential is the
    // gateway's own cookie and there is nothing local to clear. See
    // `endGatewaySession`.
    await endGatewaySession(keep)

    teardown()

    if (ns) {
      await clearCredentials(ns)
      // HERM-83 polish: the id this gateway signed the reader in AS is not this
      // account's to keep once they have signed out of it. Somebody else can
      // sign into the same address next, and a stale id would draw their first
      // messages as this reader's own until `/api/auth/me` corrected it.
      useOwnAuthorStore.getState().set(ns.id, undefined)
    }

    setSetup(null)
    setResumeConfig(keep)
    setResumeIntent('signin')
    setPhase('onboarding')
  }, [registry, setup, teardown])

  /**
   * Back to the address step, with everything still on disk.
   *
   * Nothing is cleared and nothing is retired here, on purpose. The reader may
   * be checking a stored address against the one the gateway publishes rather
   * than moving to another gateway, and a wizard that signed them out on the
   * way in would charge them a sign-in for looking — which is exactly the trap
   * the inherited-address report was stuck in, one step further along. The
   * wizard does the leaving when a different address is actually saved; see
   * `OnboardingNavigator`.
   */
  const changeGateway = useCallback(async () => {
    const keep = setup?.config ?? resumeConfig

    teardown()
    setSetup(null)
    setResumeConfig(keep)
    setResumeIntent('address')
    setPhase('onboarding')
  }, [resumeConfig, setup, teardown])

  const forgetGateway = useCallback(async () => {
    // As in `signOut`, and for the same reason with more force: the next gateway
    // must not inherit a row that names this one's devices.
    await retirePushRegistration()

    // Same as `signOut`: the session on the gateway this app is leaving is not
    // something the next one should inherit.
    await endGatewaySession(setup?.config ?? null)

    teardown()

    if (registry.activeGatewayId) {
      await clearGateway(namespace(registry.activeGatewayId))
      // As in `signOut`: the gateway itself is leaving, so nothing it stamped
      // messages with belongs to any future one.
      useOwnAuthorStore.getState().set(registry.activeGatewayId, undefined)
    }

    // And out of the list, which is the record of what this device knows about
    // rather than of what it is talking to right now. Leaving the row behind
    // would leave a gateway with no credentials, no cache and no address
    // anybody could still reach it by.
    const active = registry.activeGatewayId

    if (active) {
      const next = removeGateway(registry, active)

      setRegistry(next)
      await saveGatewayRegistry(next)
    }

    setSetup(null)
    setResumeConfig(null)
    setResumeIntent('fresh')
    setPhase('onboarding')
  }, [registry, setup, teardown])

  /**
   * Write the list and re-read everything that hangs off it.
   *
   * `reload` is what actually moves the app: it re-reads the registry from
   * disk, so the write has to land first. Going through one function rather
   * than four keeps that order from being a thing each caller remembers.
   */
  const applyRegistry = useCallback(
    async (next: GatewayRegistry, { redial = false }: { redial?: boolean } = {}) => {
      setRegistry(next)
      await saveGatewayRegistry(next)

      if (redial) {
        await reload()
      }
    },
    [reload]
  )

  const switchGateway = useCallback(
    async (id: string) => {
      if (id === registry.activeGatewayId || !gatewayById(registry, id)) {
        return
      }

      /*
        The push registration on the gateway being LEFT stays.

        Switching is not signing out: that device still wants to hear about the
        bots on the gateway it is stepping away from, and the daemon there is
        still running. This is the one path where keeping the row is the point
        rather than something that could not be helped.
      */
      await applyRegistry(setActiveGateway(registry, id), { redial: true })
    },
    [applyRegistry, registry]
  )

  const rename = useCallback(
    async (id: string, name: string) => {
      await applyRegistry(renameGateway(registry, id, name))
    },
    [applyRegistry, registry]
  )

  const signOutOf = useCallback(
    async (id: string) => {
      // The live one goes through `signOut`, which has a socket to end the
      // session on and a registration to retire over it.
      if (id === registry.activeGatewayId) {
        await signOut()

        return
      }

      // Anything else has neither, so this is the keychain and nothing more.
      // The address survives, which is what "sign out" has always meant here.
      await clearCredentials(namespace(id))
      await applyRegistry(updateGateway(registry, id, { signedInUser: undefined }))
    },
    [applyRegistry, registry, signOut]
  )

  const remove = useCallback(
    async (id: string) => {
      const live = id === registry.activeGatewayId

      if (live) {
        // While the socket is still up, in this order, for the reason
        // `signOut` gives: both of these are writes to the gateway being left.
        await retirePushRegistration()
        await endGatewaySession(setup?.config ?? null)
        teardown()
      }

      await purgeGatewayStorage(namespace(id))
      // Redialled only when the gateway that went was the live one — removing
      // a row for a machine nobody is talking to must not drop the connection
      // somebody is reading over.
      await applyRegistry(removeGateway(registry, id), { redial: live })
    },
    [applyRegistry, registry, setup, teardown]
  )

  const refreshRegistry = useCallback(async () => {
    const { registry: stored } = await loadGatewayRegistry()

    setRegistry(stored)
  }, [])

  const recordAuth = useCallback<AuthEventRecorder['record']>(event => {
    timelineRef.current?.record(event)
  }, [])

  const adoptTokens = useCallback(async (tokens: TokenSet) => {
    // Through the coordinator rather than straight into the secret store: it
    // caches the token set and fences any refresh that is in flight, so a write
    // behind its back would leave it serving the signed-out state.
    await coordinatorRef.current?.save(tokens)
    connectionRef.current?.resume()
  }, [])

  const request = useCallback(
    (<M extends Parameters<GatewayConnection['request']>[0]>(
      method: M,
      params?: Parameters<GatewayConnection['request']>[1],
      options?: RequestOptions
    ) => {
      const connection = connectionRef.current

      if (!connection) {
        return Promise.reject(new Error('There is no gateway connection yet.'))
      }

      return connection.request(method, params, options)
    }) as GatewayConnection['request'],
    []
  )

  const value = useMemo<GatewayContextValue>(
    () => ({
      phase,
      resumeConfig,
      resumeAccess,
      resumeIntent,
      connection: connectionRef.current,
      status,
      lastError,
      config: setup?.config ?? null,
      registry,
      gateway: activeGatewayOf(registry),
      gatewayId: registry.activeGatewayId,
      extraHeaders: setup?.extraHeaders ?? {},
      http: connectionRef.current?.http ?? null,
      canRefresh: setup?.canRefresh ?? true,
      recordAuth,
      request,
      adoptTokens,
      reload,
      retryNow,
      signOut,
      changeGateway,
      forgetGateway,
      switchGateway,
      renameGateway: rename,
      signOutOf,
      removeGateway: remove,
      refreshRegistry
    }),
    [
      adoptTokens,
      changeGateway,
      forgetGateway,
      lastError,
      phase,
      recordAuth,
      refreshRegistry,
      registry,
      reload,
      remove,
      rename,
      request,
      resumeAccess,
      resumeConfig,
      resumeIntent,
      retryNow,
      setup,
      signOut,
      signOutOf,
      status,
      switchGateway
    ]
  )

  return <GatewayContext.Provider value={value}>{children}</GatewayContext.Provider>
}

export function useGateway(): GatewayContextValue {
  const value = useContext(GatewayContext)

  if (!value) {
    throw new Error('useGateway() was called outside a <GatewayProvider>.')
  }

  return value
}

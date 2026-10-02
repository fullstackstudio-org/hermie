import AsyncStorage from '@react-native-async-storage/async-storage'

/**
 * Storage for non-secret configuration: the gateway URL, per-chat display
 * preferences, the last selected bot. Anything sensitive belongs in the
 * SecretStore instead.
 */
export type KeyValueStore = {
  get(key: string): Promise<string | null>
  set(key: string, value: string): Promise<void>
  delete(key: string): Promise<void>
  getJson<T>(key: string): Promise<T | null>
  setJson(key: string, value: unknown): Promise<void>
  /**
   * Every key this store currently holds.
   *
   * The one read that is not about a key somebody already knows the name of,
   * and it exists for exactly one caller: the sweep in `gateway/registry.ts`
   * that takes out configurations no gateway entry claims. Orphans cannot be
   * found any other way — their ids were minted at random and then lost with
   * the write that should have recorded them.
   */
  keys(): Promise<string[]>
  /**
   * Delete several keys in one go.
   *
   * Beside `delete` rather than instead of it because AsyncStorage's own
   * `multiRemove` is one transaction: a sweep of forty orphans that went key by
   * key would be forty writes of the manifest, and a launch interrupted halfway
   * through would leave half of them behind.
   */
  deleteMany(keys: readonly string[]): Promise<void>
}

export const keyValueStore: KeyValueStore = {
  async get(key) {
    return AsyncStorage.getItem(key)
  },
  async set(key, value) {
    await AsyncStorage.setItem(key, value)
  },
  async delete(key) {
    await AsyncStorage.removeItem(key)
  },
  async getJson<T>(key: string) {
    const raw = await AsyncStorage.getItem(key)
    if (raw === null) {
      return null
    }
    try {
      return JSON.parse(raw) as T
    } catch {
      // A value written by an older build is not worth crashing over.
      await AsyncStorage.removeItem(key)
      return null
    }
  },
  async setJson(key, value) {
    await AsyncStorage.setItem(key, JSON.stringify(value))
  },
  async keys() {
    return [...(await AsyncStorage.getAllKeys())]
  },
  async deleteMany(keys) {
    if (keys.length === 0) {
      return
    }

    await AsyncStorage.multiRemove([...keys])
  }
}

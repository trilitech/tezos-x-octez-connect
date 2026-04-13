import { Storage, StorageKey, StorageKeyReturnType, defaultValues } from '@tezos-x/octez.connect-dapp'

/**
 * In-memory storage for use in Node.js (replaces browser localStorage).
 * Also exposes getPrefixedKey() which DAppClient calls directly at runtime.
 */
export class MemoryStorage extends Storage {
  private readonly store = new Map<string, unknown>()

  public static override async isSupported(): Promise<boolean> {
    return true
  }

  public async get<K extends StorageKey>(key: K): Promise<StorageKeyReturnType[K]> {
    if (this.store.has(key)) {
      return this.store.get(key) as StorageKeyReturnType[K]
    }
    const def = defaultValues[key]
    return (typeof def === 'object' ? JSON.parse(JSON.stringify(def)) : def) as StorageKeyReturnType[K]
  }

  public async set<K extends StorageKey>(key: K, value: StorageKeyReturnType[K]): Promise<void> {
    this.store.set(key, value)
  }

  public async delete<K extends StorageKey>(key: K): Promise<void> {
    this.store.delete(key)
  }

  public async subscribeToStorageChanged(_cb: unknown): Promise<void> {
    // no-op in Node.js
  }

  public getPrefixedKey(key: string): string {
    return key
  }
}

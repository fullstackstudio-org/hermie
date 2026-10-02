/**
 * A small in-memory IndexedDB for the tests, written here rather than taken
 * from a package (plan W-6: no new dependency).
 *
 * It implements what `platform/chat-cache.ts` uses and keeps the parts of the
 * real thing that a cache can get wrong:
 *
 *  - every request answers asynchronously, through `onsuccess` / `onerror`;
 *  - a transaction completes (`oncomplete`) only after its last request, and
 *    once it has, a further request on it throws `TransactionInactiveError`,
 *    which is how a readwrite transaction that awaited halfway fails for real;
 *  - a readonly transaction refuses writes;
 *  - values are structured-cloned in and out, so a caller cannot mutate a
 *    stored row through the object it wrote.
 *
 * Not implemented: indexes, cursors, key ranges, versions beyond the first
 * upgrade, `deleteDatabase`.
 */

type Handler = ((this: unknown, event: Event) => unknown) | null

class FakeRequest<T> {
  result: T = undefined as T
  error: DOMException | null = null
  readyState: 'pending' | 'done' = 'pending'
  onsuccess: Handler = null
  onerror: Handler = null
  onupgradeneeded: Handler = null
  onblocked: Handler = null

  succeed(result: T): void {
    this.result = result
    this.readyState = 'done'
    this.onsuccess?.call(this, new Event('success'))
  }

  fail(error: DOMException): void {
    this.error = error
    this.readyState = 'done'
    this.onerror?.call(this, new Event('error'))
  }
}

interface StoreData {
  keyPath: string
  rows: Map<string, unknown>
}

const later = (task: () => void): void => {
  setTimeout(task, 0)
}

class FakeObjectStore {
  constructor(
    private readonly transaction: FakeTransaction,
    private readonly data: StoreData
  ) {}

  get(key: string): FakeRequest<unknown> {
    return this.transaction.request(() => structuredClone(this.data.rows.get(key)))
  }

  getAll(): FakeRequest<unknown[]> {
    return this.transaction.request(() => [...this.data.rows.values()].map(row => structuredClone(row)))
  }

  put(value: Record<string, unknown>): FakeRequest<string> {
    this.transaction.assertWritable()

    return this.transaction.request(() => {
      const key = value[this.data.keyPath]

      if (typeof key !== 'string') {
        throw new DOMException('The key path did not yield a string key.', 'DataError')
      }

      this.data.rows.set(key, structuredClone(value))

      return key
    })
  }

  delete(key: string): FakeRequest<undefined> {
    this.transaction.assertWritable()

    return this.transaction.request(() => {
      this.data.rows.delete(key)

      return undefined
    })
  }

  clear(): FakeRequest<undefined> {
    this.transaction.assertWritable()

    return this.transaction.request(() => {
      this.data.rows.clear()

      return undefined
    })
  }
}

class FakeTransaction {
  oncomplete: Handler = null
  onerror: Handler = null
  onabort: Handler = null
  error: DOMException | null = null
  private pending = 0
  private finished = false

  constructor(
    private readonly database: FakeDatabase,
    private readonly names: readonly string[],
    readonly mode: IDBTransactionMode
  ) {
    // A transaction that is never used still completes.
    later(() => this.maybeComplete())
  }

  objectStore(name: string): FakeObjectStore {
    if (!this.names.includes(name)) {
      throw new DOMException(`${name} is not in this transaction's scope.`, 'NotFoundError')
    }

    return new FakeObjectStore(this, this.database.data(name))
  }

  assertWritable(): void {
    if (this.mode === 'readonly') {
      throw new DOMException('The transaction is read-only.', 'ReadOnlyError')
    }
  }

  request<T>(operation: () => T): FakeRequest<T> {
    if (this.finished) {
      throw new DOMException('The transaction has finished.', 'TransactionInactiveError')
    }

    const request = new FakeRequest<T>()
    this.pending += 1

    later(() => {
      try {
        request.succeed(operation())
      } catch (error) {
        request.fail(error instanceof DOMException ? error : new DOMException(String(error), 'UnknownError'))
      }

      this.pending -= 1
      this.maybeComplete()
    })

    return request
  }

  private maybeComplete(): void {
    if (this.pending > 0 || this.finished) {
      return
    }

    // One more turn, so a request issued from an `onsuccess` handler still
    // belongs to this transaction, as it does in a browser.
    later(() => {
      if (this.pending === 0 && !this.finished) {
        this.finished = true
        this.oncomplete?.call(this, new Event('complete'))
      }
    })
  }
}

class FakeDatabase {
  private readonly stores = new Map<string, StoreData>()

  readonly objectStoreNames = {
    contains: (name: string): boolean => this.stores.has(name)
  }

  constructor(
    readonly name: string,
    readonly version: number
  ) {}

  createObjectStore(name: string, options: { keyPath: string }): void {
    this.stores.set(name, { keyPath: options.keyPath, rows: new Map() })
  }

  data(name: string): StoreData {
    const store = this.stores.get(name)

    if (!store) {
      throw new DOMException(`No object store named ${name}.`, 'NotFoundError')
    }

    return store
  }

  transaction(names: string | readonly string[], mode: IDBTransactionMode = 'readonly'): FakeTransaction {
    const list = typeof names === 'string' ? [names] : [...names]

    for (const name of list) {
      this.data(name)
    }

    return new FakeTransaction(this, list, mode)
  }

  close(): void {}

  /** Every row in one store, for assertions. */
  rows(name: string): unknown[] {
    return [...this.data(name).rows.values()].map(row => structuredClone(row))
  }
}

export interface FakeIndexedDb {
  /** Hand this to the code under test. */
  factory: IDBFactory
  /** The database by name, once something has opened it. */
  database(name: string): FakeDatabase | undefined
  /** Make every later `open` fail, the way a private window or blocked site data does. */
  refuse(refusing: boolean): void
  /** How many times `open` was called. */
  readonly opens: number
}

export function createFakeIndexedDb(): FakeIndexedDb {
  const databases = new Map<string, FakeDatabase>()
  let refusing = false
  let opens = 0

  const factory = {
    open(name: string, version = 1): FakeRequest<FakeDatabase> {
      opens += 1
      const request = new FakeRequest<FakeDatabase>()

      later(() => {
        if (refusing) {
          request.fail(new DOMException('The user denied permission to access the database.', 'InvalidStateError'))

          return
        }

        let database = databases.get(name)

        if (!database || database.version < version) {
          database = new FakeDatabase(name, version)
          databases.set(name, database)
          request.result = database
          request.onupgradeneeded?.call(request, new Event('upgradeneeded'))
        }

        request.succeed(database)
      })

      return request
    }
  }

  return {
    factory: factory as unknown as IDBFactory,
    database: name => databases.get(name),
    refuse(next) {
      refusing = next
    },
    get opens() {
      return opens
    }
  }
}

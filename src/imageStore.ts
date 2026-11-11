// Keeps uploaded images in IndexedDB so they survive reloads. Failures are non-fatal.

export type StoredImage = { blob: Blob; name: string }

const DB_NAME = 'shader-studio'
const STORE = 'images'

function open(): Promise<IDBDatabase> {
  return new Promise((resolve, reject) => {
    const req = indexedDB.open(DB_NAME, 1)
    req.onupgradeneeded = () => req.result.createObjectStore(STORE)
    req.onsuccess = () => resolve(req.result)
    req.onerror = () => reject(req.error)
  })
}

function run<T>(mode: IDBTransactionMode, fn: (store: IDBObjectStore) => IDBRequest<T>): Promise<T | undefined> {
  return open()
    .then(
      (db) =>
        new Promise<T>((resolve, reject) => {
          const req = fn(db.transaction(STORE, mode).objectStore(STORE))
          req.onsuccess = () => resolve(req.result)
          req.onerror = () => reject(req.error)
        }),
    )
    .catch((err) => {
      console.warn('Image storage unavailable:', err)
      return undefined
    })
}

export const getImage = (key: string) => run<StoredImage | undefined>('readonly', (s) => s.get(key))
export const putImage = (key: string, value: StoredImage) => run('readwrite', (s) => s.put(value, key))
export const deleteImage = (key: string) => run('readwrite', (s) => s.delete(key))

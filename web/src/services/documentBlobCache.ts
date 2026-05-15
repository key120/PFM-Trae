/**
 * documentBlobCache.ts
 *
 * IndexedDB-based cache for encrypted document blobs.
 * Allows second open to skip R2 download entirely.
 *
 * Key: `${documentId}:${versionId}`
 * Value: encrypted Blob
 *
 * Eviction: LRU with max 10 entries, auto-cleans entries older than 7 days.
 */

const DB_NAME = 'pfm-document-blob-cache';
const DB_VERSION = 1;
const STORE_NAME = 'encrypted-blobs';
const MAX_ENTRIES = 10;
const MAX_AGE_MS = 7 * 24 * 60 * 60 * 1000; // 7 days

function openDB(): Promise<IDBDatabase> {
  return new Promise((resolve, reject) => {
    const request = indexedDB.open(DB_NAME, DB_VERSION);
    request.onupgradeneeded = () => {
      const db = request.result;
      if (!db.objectStoreNames.contains(STORE_NAME)) {
        const store = db.createObjectStore(STORE_NAME, { keyPath: 'key' });
        store.createIndex('accessTime', 'accessTime', { unique: false });
      }
    };
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error);
  });
}

interface CacheEntry {
  key: string;
  blob: Blob;
  accessTime: number;
  createdAt: number;
}

async function getAll_entries(db: IDBDatabase): Promise<CacheEntry[]> {
  return new Promise((resolve, reject) => {
    const tx = db.transaction(STORE_NAME, 'readonly');
    const store = tx.objectStore(STORE_NAME);
    const request = store.getAll();
    request.onsuccess = () => resolve(request.result as CacheEntry[]);
    request.onerror = () => reject(request.error);
  });
}

async function putEntry(db: IDBDatabase, entry: CacheEntry): Promise<void> {
  return new Promise((resolve, reject) => {
    const tx = db.transaction(STORE_NAME, 'readwrite');
    const store = tx.objectStore(STORE_NAME);
    store.put(entry);
    tx.oncomplete = () => resolve();
    tx.onerror = () => reject(tx.error);
  });
}

async function deleteEntry(db: IDBDatabase, key: string): Promise<void> {
  return new Promise((resolve, reject) => {
    const tx = db.transaction(STORE_NAME, 'readwrite');
    const store = tx.objectStore(STORE_NAME);
    store.delete(key);
    tx.oncomplete = () => resolve();
    tx.onerror = () => reject(tx.error);
  });
}

async function evictIfNeeded(db: IDBDatabase): Promise<void> {
  const entries = await getAll_entries(db);
  const now = Date.now();

  // Remove expired entries
  for (const entry of entries) {
    if (now - entry.createdAt > MAX_AGE_MS) {
      await deleteEntry(db, entry.key);
    }
  }

  // If still over limit, remove oldest by accessTime
  const remaining = await getAll_entries(db);
  if (remaining.length > MAX_ENTRIES) {
    remaining.sort((a, b) => a.accessTime - b.accessTime);
    const toRemove = remaining.slice(0, remaining.length - MAX_ENTRIES);
    for (const entry of toRemove) {
      await deleteEntry(db, entry.key);
    }
  }
}

function makeKey(documentId: string, versionId: string): string {
  return `${documentId}:${versionId}`;
}

/**
 * Get cached encrypted blob for a document version.
 * Returns null if not cached or on any error.
 */
export async function getCachedEncryptedBlob(
  documentId: string,
  versionId: string,
): Promise<Blob | null> {
  try {
    const db = await openDB();
    const key = makeKey(documentId, versionId);
    const entries = await getAll_entries(db);
    const entry = entries.find((e) => e.key === key);
    if (!entry) return null;

    // Update access time
    await putEntry(db, { ...entry, accessTime: Date.now() });
    return entry.blob;
  } catch {
    return null;
  }
}

/**
 * Cache an encrypted blob for a document version.
 * Silently fails on any error (cache is best-effort).
 */
export async function cacheEncryptedBlob(
  documentId: string,
  versionId: string,
  blob: Blob,
): Promise<void> {
  try {
    const db = await openDB();
    const key = makeKey(documentId, versionId);
    const now = Date.now();
    await putEntry(db, { key, blob, accessTime: now, createdAt: now });
    await evictIfNeeded(db);
  } catch {
    // Cache write is best-effort, silently ignore errors
  }
}

/**
 * Invalidate a specific cached blob.
 */
export async function invalidateCachedBlob(
  documentId: string,
  versionId: string,
): Promise<void> {
  try {
    const db = await openDB();
    await deleteEntry(db, makeKey(documentId, versionId));
  } catch {
    // Best-effort
  }
}

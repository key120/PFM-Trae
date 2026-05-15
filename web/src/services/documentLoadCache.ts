import type { HeadingNode } from '../utils/docHeadingExtraction';

export interface DocumentLoadCacheEntry {
  file: File;
  arrayBuffer?: ArrayBuffer;
  headings: HeadingNode[];
  title: string;
  renderedHtml?: string;
}

export interface DocumentLoadCacheOptions {
  maxEntries?: number;
}

export interface DocumentLoadCache {
  get(documentId: string, versionId: string): DocumentLoadCacheEntry | null;
  set(documentId: string, versionId: string, entry: DocumentLoadCacheEntry): void;
  clear(): void;
}

const DEFAULT_MAX_ENTRIES = 5;

const createCacheKey = (documentId: string, versionId: string) => `${documentId}:${versionId}`;

export function createDocumentLoadCache(options: DocumentLoadCacheOptions = {}): DocumentLoadCache {
  const maxEntries = options.maxEntries ?? DEFAULT_MAX_ENTRIES;
  const entries = new Map<string, DocumentLoadCacheEntry>();

  const touch = (key: string, entry: DocumentLoadCacheEntry) => {
    entries.delete(key);
    entries.set(key, entry);
  };

  return {
    get(documentId, versionId) {
      const key = createCacheKey(documentId, versionId);
      const entry = entries.get(key);

      if (!entry) {
        return null;
      }

      touch(key, entry);
      return entry;
    },

    set(documentId, versionId, entry) {
      const key = createCacheKey(documentId, versionId);

      touch(key, entry);

      if (entries.size <= maxEntries) {
        return;
      }

      const leastRecentlyUsedKey = entries.keys().next().value;
      if (leastRecentlyUsedKey) {
        entries.delete(leastRecentlyUsedKey);
      }
    },

    clear() {
      entries.clear();
    },
  };
}

/**
 * Controlled-concurrency key distribution executor for shared documents.
 *
 * Replaces the serial `for...of` loop with a chunked `Promise.allSettled`
 * approach that processes up to `concurrency` users in parallel.
 * All users are processed regardless of individual failures.
 */

export type DistributeKeyToMemberInput = {
  documentId: string;
  wrappedKey: CryptoKey;
  targetUserIds: string[];
  keyVersion: number;
  concurrency?: number; // default 4
};

export type DistributeKeyResult = {
  distributed: string[];  // userIds that succeeded
  failed: Array<{ userId: string; reason: string }>;
  actualDistributed: number;  // number of successfully distributed keys
  concurrencyUsed: number;    // the concurrency limit that was applied
  durationMs: number;         // total wall-clock time in milliseconds
};

export type DistributeKeyFn = (
  documentId: string,
  wrappedKey: CryptoKey,
  userId: string,
  keyVersion: number,
) => Promise<void>;

/**
 * Run an async function over items with a fixed concurrency limit.
 * Returns all results (SettledPromise), never short-circuits on failure.
 */
async function runWithConcurrency<T, R>(
  items: T[],
  concurrency: number,
  fn: (item: T) => Promise<R>,
): Promise<PromiseSettledResult<R>[]> {
  const results: PromiseSettledResult<R>[] = [];
  for (let i = 0; i < items.length; i += concurrency) {
    const chunk = items.slice(i, i + concurrency);
    const chunkResults = await Promise.allSettled(chunk.map(fn));
    results.push(...chunkResults);
  }
  return results;
}

/**
 * Distribute a document key to multiple team members concurrently,
 * with a fixed concurrency limit (default 4).
 *
 * @param input - The distribution parameters.
 * @param distributeFn - The actual key distribution function (injected for testability).
 * @returns A result object with lists of succeeded and failed user IDs.
 */
export async function distributeDocumentKeyConcurrently(
  input: DistributeKeyToMemberInput,
  distributeFn: DistributeKeyFn,
): Promise<DistributeKeyResult> {
  const { documentId, wrappedKey, targetUserIds, keyVersion, concurrency = 4 } = input;

  if (targetUserIds.length === 0) {
    return { distributed: [], failed: [], actualDistributed: 0, concurrencyUsed: concurrency, durationMs: 0 };
  }

  const startTime = typeof performance !== 'undefined' && typeof performance.now === 'function'
    ? performance.now()
    : Date.now();

  const settled = await runWithConcurrency(
    targetUserIds,
    concurrency,
    async (userId) => {
      await distributeFn(documentId, wrappedKey, userId, keyVersion);
      return userId;
    },
  );

  const endTime = typeof performance !== 'undefined' && typeof performance.now === 'function'
    ? performance.now()
    : Date.now();
  const durationMs = Math.max(0, Math.round(endTime - startTime));

  const distributed: string[] = [];
  const failed: Array<{ userId: string; reason: string }> = [];

  for (let i = 0; i < settled.length; i++) {
    const result = settled[i];
    const userId = targetUserIds[i];
    if (result.status === 'fulfilled') {
      distributed.push(userId);
    } else {
      const reason = result.reason instanceof Error
        ? result.reason.message
        : String(result.reason);
      failed.push({ userId, reason });
    }
  }

  return { distributed, failed, actualDistributed: distributed.length, concurrencyUsed: concurrency, durationMs };
}

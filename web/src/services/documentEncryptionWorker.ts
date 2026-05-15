/**
 * documentEncryptionWorker.ts
 *
 * Adapter layer that transparently offloads chunked AES-GCM-256 encryption
 * to a Web Worker (documentEncrypt.worker.ts). Falls back to main-thread
 * encryptDocumentChunked when the Worker is unavailable or fails.
 *
 * Public API matches encryptDocumentChunked so callers do not need to know
 * which path was used.
 */

import {
  type EncryptDocumentInput,
  type ChunkEncryptOptions,
  type ChunkEncryptResult,
  encryptDocumentChunked,
} from './encryptionService';

export const encryptDocumentChunkedViaWorker = async (
  input: EncryptDocumentInput,
  options?: ChunkEncryptOptions & {
    onProgress?: (chunkIndex: number, totalChunks: number) => void;
  },
): Promise<ChunkEncryptResult> => {
  try {
    const worker = new Worker(
      new URL('../workers/documentEncrypt.worker.ts', import.meta.url),
      { type: 'module' },
    );

    return await new Promise<ChunkEncryptResult>((resolve, reject) => {
      const timeout = setTimeout(() => {
        worker.terminate();
        reject(new Error('Worker encryption timed out'));
      }, 300_000); // 5 minute safety timeout

      worker.onmessage = (e: MessageEvent) => {
        const msg = e.data as
          | { type: 'progress'; chunkIndex: number; totalChunks: number }
          | { type: 'success'; blob: Blob; contentHash: string }
          | { type: 'error'; message: string };

        if (msg.type === 'progress') {
          options?.onProgress?.(msg.chunkIndex, msg.totalChunks);
          return;
        }

        if (msg.type === 'success') {
          clearTimeout(timeout);
          worker.terminate();
          resolve({ blob: msg.blob, contentHash: msg.contentHash });
          return;
        }

        if (msg.type === 'error') {
          clearTimeout(timeout);
          worker.terminate();
          reject(new Error(msg.message));
          return;
        }
      };

      worker.onerror = (e) => {
        clearTimeout(timeout);
        worker.terminate();
        reject(e.error ?? new Error(e.message ?? 'Worker encryption failed'));
      };

      worker.postMessage({
        type: 'encrypt',
        file: input.file,
        key: input.key,
        meta: input.meta,
        chunkSize: options?.chunkSize,
      });
    });
  } catch {
    console.warn('[documentEncryptionWorker] Worker unavailable, falling back to main-thread encryption');
    return encryptDocumentChunked(input, options);
  }
};

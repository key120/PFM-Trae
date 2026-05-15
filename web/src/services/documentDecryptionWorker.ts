/**
 * documentDecryptionWorker.ts
 *
 * Adapter layer that transparently offloads chunked AES-GCM-256 decryption
 * to a Web Worker (documentDecrypt.worker.ts). Falls back to main-thread
 * decryptDocumentChunked when the Worker is unavailable or fails.
 *
 * Public API matches decryptDocumentChunked so callers do not need to know
 * which path was used.
 */

import {
  type DecryptDocumentResult,
  type EncryptDocumentMeta,
  decryptDocumentChunked,
} from './encryptionService';
import { readUint32 } from './documentEncryptionShared';

const textDecoder = new TextDecoder();

/**
 * Parse the raw plaintext ArrayBuffer (as produced by the Worker) into
 * a File + meta, mirroring the logic in decryptDocumentChunked lines 484-518.
 */
const parseWorkerPlaintext = async (
  plaintextBuffer: ArrayBuffer,
  fileNameFallback: string,
  mimeTypeFallback: string,
): Promise<DecryptDocumentResult> => {
  const plaintext = new Uint8Array(plaintextBuffer);

  if (plaintext.byteLength < 4) {
    throw new Error('Plaintext is too small');
  }

  const metaLenView = new DataView(plaintext.buffer, plaintext.byteOffset, 4);
  const metaLen = readUint32(metaLenView, 0);

  if (metaLen < 0 || 4 + metaLen > plaintext.byteLength) {
    throw new Error('Invalid metadata length');
  }

  const metaBytes = plaintext.slice(4, 4 + metaLen);
  const metaJson = textDecoder.decode(metaBytes);

  let meta: EncryptDocumentMeta | null = null;
  try {
    meta = JSON.parse(metaJson);
  } catch {
    throw new Error('Invalid metadata JSON');
  }

  const fileBytes = plaintext.slice(4 + metaLen);
  const file = new File([fileBytes], fileNameFallback, {
    type: mimeTypeFallback,
  });

  return { file, meta };
};

export const decryptDocumentChunkedViaWorker = async (
  encrypted: Blob,
  key: CryptoKey,
  fileNameFallback: string,
  mimeTypeFallback = 'application/octet-stream',
  options?: {
    onProgress?: (chunkIndex: number, totalChunks: number) => void;
  },
): Promise<DecryptDocumentResult> => {
  let worker: Worker;
  try {
    worker = new Worker(
      new URL('../workers/documentDecrypt.worker.ts', import.meta.url),
      { type: 'module' },
    );
  } catch {
    console.warn('[documentDecryptionWorker] Worker unavailable, falling back to main-thread decryption');
    return decryptDocumentChunked(encrypted, key, fileNameFallback, mimeTypeFallback);
  }

  // Worker created successfully - wrap entire path with fallback
  try {
    return await new Promise<DecryptDocumentResult>((resolve, reject) => {
      const timeout = setTimeout(() => {
        worker.terminate();
        reject(new Error('Worker decryption timed out'));
      }, 300_000); // 5 minute safety timeout

      worker.onmessage = (e: MessageEvent) => {
        const msg = e.data as
          | { type: 'progress'; chunkIndex: number; totalChunks: number }
          | { type: 'success'; plaintext: ArrayBuffer }
          | { type: 'error'; message: string };

        if (msg.type === 'progress') {
          options?.onProgress?.(msg.chunkIndex, msg.totalChunks);
          return;
        }

        if (msg.type === 'success') {
          clearTimeout(timeout);
          worker.terminate();
          // Parse plaintext to extract meta and construct File
          parseWorkerPlaintext(msg.plaintext, fileNameFallback, mimeTypeFallback)
            .then(resolve)
            .catch(reject);
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
        reject(e.error ?? new Error(e.message ?? 'Worker decryption failed'));
      };

      // Convert Blob to ArrayBuffer for transfer to Worker
      const arrayBufferPromise = 'arrayBuffer' in encrypted
        ? (encrypted as Blob & { arrayBuffer: () => Promise<ArrayBuffer> }).arrayBuffer()
        : new Promise<ArrayBuffer>((resolve, reject) => {
            const reader = new FileReader();
            reader.onload = () => {
              const result = reader.result;
              if (result instanceof ArrayBuffer) resolve(result);
              else reject(new Error('Unexpected FileReader result type'));
            };
            reader.onerror = () => reject(reader.error ?? new Error('Failed to read Blob'));
            reader.readAsArrayBuffer(encrypted);
          });

      arrayBufferPromise
        .then((encryptedBuffer) => {
          worker.postMessage({ type: 'decrypt', encrypted: encryptedBuffer, key }, [encryptedBuffer]);
        })
        .catch((err) => {
          clearTimeout(timeout);
          worker.terminate();
          reject(err);
        });
    });
  } catch (err) {
    console.warn('[documentDecryptionWorker] Worker path failed, falling back to main-thread decryption:', err);
    worker.terminate();
    return decryptDocumentChunked(encrypted, key, fileNameFallback, mimeTypeFallback);
  }
};

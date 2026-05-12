/**
 * documentDecrypt.worker.ts
 *
 * Web Worker that performs chunked AES-GCM-256 decryption in a background thread.
 * Reads v2 encrypted blobs and outputs raw plaintext ArrayBuffer.
 *
 * Message protocol:
 *   Input:  { type: 'decrypt'; encrypted: ArrayBuffer; key: CryptoKey }
 *   Output: { type: 'progress'; chunkIndex: number; totalChunks: number }
 *           { type: 'success';  plaintext: ArrayBuffer }
 *           { type: 'error';    message: string }
 *
 * The plaintext output includes the meta length prefix (4 bytes) + meta JSON + file bytes.
 * The adapter layer is responsible for parsing the meta and constructing the File.
 */

import { readUint32 } from '../services/documentEncryptionShared';

const BATCH_SIZE = 4;

interface DecryptMessage {
  type: 'decrypt';
  encrypted: ArrayBuffer;
  key: CryptoKey;
}

interface ProgressMessage {
  type: 'progress';
  chunkIndex: number;
  totalChunks: number;
}

interface SuccessMessage {
  type: 'success';
  plaintext: ArrayBuffer;
}

interface ErrorMessage {
  type: 'error';
  message: string;
}

type WorkerOutput = ProgressMessage | SuccessMessage | ErrorMessage;

const post = (msg: WorkerOutput, transfer?: Transferable[]) => {
  if (transfer) {
    (self as unknown as Worker).postMessage(msg, transfer);
  } else {
    (self as unknown as Worker).postMessage(msg);
  }
};

const decrypt = async (msg: DecryptMessage): Promise<void> => {
  const { encrypted, key } = msg;
  const bytes = new Uint8Array(encrypted);

  // --- Parse v2 header ---
  if (bytes.byteLength < 4) {
    throw new Error('Encrypted blob is too small');
  }

  const headerLenView = new DataView(bytes.buffer, bytes.byteOffset, 4);
  const headerLen = readUint32(headerLenView, 0);

  if (headerLen <= 0 || 4 + headerLen > bytes.byteLength) {
    throw new Error('Invalid header length');
  }

  const headerJson = new TextDecoder().decode(bytes.slice(4, 4 + headerLen));

  let header: {
    version: number;
    alg: string;
    keySize: number;
    chunkCount: number;
    totalSize: number;
  };

  try {
    header = JSON.parse(headerJson);
  } catch {
    throw new Error('Invalid header JSON');
  }

  if (
    typeof header.version !== 'number' ||
    typeof header.alg !== 'string' ||
    typeof header.keySize !== 'number' ||
    typeof header.chunkCount !== 'number' ||
    typeof header.totalSize !== 'number'
  ) {
    throw new Error('Header fields are invalid');
  }

  if (header.version !== 2 || header.alg !== 'AES-GCM' || header.keySize !== 256) {
    throw new Error('Unsupported encryption version or algorithm');
  }

  // --- Pre-compute chunk read offsets (single pass) ---
  const chunkOffsets: { readOffset: number; cipherLen: number }[] = [];
  let readOffset = 4 + headerLen;

  for (let i = 0; i < header.chunkCount; i += 1) {
    if (readOffset + 12 + 4 > bytes.byteLength) {
      throw new Error('Invalid chunk header');
    }

    const lenView = new DataView(bytes.buffer, bytes.byteOffset + readOffset + 12, 4);
    const cipherLen = readUint32(lenView, 0);
    const chunkTotalSize = 12 + 4 + cipherLen;

    if (cipherLen <= 0 || readOffset + chunkTotalSize > bytes.byteLength) {
      throw new Error('Invalid chunk length');
    }

    chunkOffsets.push({ readOffset, cipherLen });
    readOffset += chunkTotalSize;
  }

  // --- Allocate output buffer ---
  const plaintext = new Uint8Array(header.totalSize);
  let writeOffset = 0;

  // --- Decrypt in batches of BATCH_SIZE ---
  for (let batchStart = 0; batchStart < header.chunkCount; batchStart += BATCH_SIZE) {
    const batchEnd = Math.min(batchStart + BATCH_SIZE, header.chunkCount);
    const batchPromises: Promise<{ index: number; data: Uint8Array }>[] = [];

    for (let i = batchStart; i < batchEnd; i += 1) {
      const { readOffset: chunkReadOffset, cipherLen } = chunkOffsets[i];
      const nonceBytes = bytes.slice(chunkReadOffset, chunkReadOffset + 12);
      const cipherBytes = bytes.slice(
        chunkReadOffset + 16,
        chunkReadOffset + 16 + cipherLen,
      );

      batchPromises.push(
        crypto.subtle
          .decrypt(
            { name: 'AES-GCM', iv: nonceBytes.buffer as ArrayBuffer },
            key,
            cipherBytes,
          )
          .then((buf) => ({ index: i, data: new Uint8Array(buf) })),
      );
    }

    const results = await Promise.all(batchPromises);

    // Write results in order
    for (const { data } of results) {
      plaintext.set(data, writeOffset);
      writeOffset += data.byteLength;
    }

    // Report progress for each chunk in this batch
    for (let i = batchStart; i < batchEnd; i += 1) {
      post({ type: 'progress', chunkIndex: i + 1, totalChunks: header.chunkCount });
    }
  }

  post({ type: 'success', plaintext: plaintext.buffer }, [plaintext.buffer]);
};

self.onmessage = async (e: MessageEvent<DecryptMessage>) => {
  try {
    const msg = e.data;
    if (msg.type !== 'decrypt') {
      post({ type: 'error', message: `Unknown message type: ${(msg as { type: string }).type}` });
      return;
    }
    await decrypt(msg);
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    post({ type: 'error', message });
  }
};

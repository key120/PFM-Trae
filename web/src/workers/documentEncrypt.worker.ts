/**
 * documentEncrypt.worker.ts
 *
 * Web Worker that performs chunked AES-GCM-256 encryption in a background thread.
 * Output is byte-compatible with decryptDocumentChunked in encryptionService.ts.
 *
 * Message protocol:
 *   Input:  { type: 'encrypt'; file: File; key: CryptoKey; meta?: Record<string, unknown>; chunkSize?: number }
 *   Output: { type: 'progress'; chunkIndex: number; totalChunks: number }
 *           { type: 'success';  blob: Blob; contentHash: string }
 *           { type: 'error';    message: string }
 */

import {
  DEFAULT_DOCUMENT_CHUNK_SIZE,
  computeMetadataHash,
  toHex,
  writeUint32,
  type ChunkedEncryptionHeaderV2,
} from '../services/documentEncryptionShared';

const textEncoder = new TextEncoder();

interface EncryptMessage {
  type: 'encrypt';
  file: File;
  key: CryptoKey;
  meta?: Record<string, unknown>;
  chunkSize?: number;
}

interface ProgressMessage {
  type: 'progress';
  chunkIndex: number;
  totalChunks: number;
}

interface SuccessMessage {
  type: 'success';
  blob: Blob;
  contentHash: string;
}

interface ErrorMessage {
  type: 'error';
  message: string;
}

type WorkerOutput = ProgressMessage | SuccessMessage | ErrorMessage;

const post = (msg: WorkerOutput) => {
  self.postMessage(msg);
};

const blobToArrayBuffer = (blob: Blob): Promise<ArrayBuffer> => {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => {
      const result = reader.result;
      if (result instanceof ArrayBuffer) {
        resolve(result);
      } else {
        reject(new Error('Unexpected FileReader result type'));
      }
    };
    reader.onerror = () => {
      reject(reader.error ?? new Error('Failed to read Blob'));
    };
    reader.readAsArrayBuffer(blob);
  });
};

const encrypt = async (msg: EncryptMessage): Promise<void> => {
  const { file, key, meta, chunkSize: optChunkSize } = msg;

  const metaJson = JSON.stringify(meta ?? null);
  const metaBytes = textEncoder.encode(metaJson);

  // Build meta length prefix (4 bytes, big-endian)
  const metaLenBuf = new ArrayBuffer(4);
  writeUint32(new DataView(metaLenBuf), 0, metaBytes.byteLength);

  // Full plaintext as a Blob: [metaLen(4)] [metaJson] [fileBytes]
  const plaintextBlob = new Blob(
    [metaLenBuf, metaBytes, file],
    { type: 'application/octet-stream' },
  );

  const totalLength = plaintextBlob.size;
  const chunkSize = optChunkSize ?? DEFAULT_DOCUMENT_CHUNK_SIZE;
  const chunkCount = Math.ceil(totalLength / chunkSize);

  const chunks: Uint8Array[] = [];

  for (let i = 0; i < chunkCount; i += 1) {
    const start = i * chunkSize;
    const end = Math.min(start + chunkSize, totalLength);
    const slice = plaintextBlob.slice(start, end);
    const sliceBuffer = await blobToArrayBuffer(slice);

    const nonce = new Uint8Array(12);
    crypto.getRandomValues(nonce);

    const ciphertextBuffer = await crypto.subtle.encrypt(
      { name: 'AES-GCM', iv: nonce.buffer as ArrayBuffer },
      key,
      sliceBuffer,
    );

    const cipherBytes = new Uint8Array(ciphertextBuffer);
    const lenBuf = new ArrayBuffer(4);
    writeUint32(new DataView(lenBuf), 0, cipherBytes.byteLength);

    const combined = new Uint8Array(12 + 4 + cipherBytes.byteLength);
    combined.set(nonce, 0);
    combined.set(new Uint8Array(lenBuf), 12);
    combined.set(cipherBytes, 16);

    chunks.push(combined);

    // Report progress after each chunk
    post({ type: 'progress', chunkIndex: i + 1, totalChunks: chunkCount });
  }

  // Compute metadata hash
  const metaHash = await computeMetadataHash(metaJson);

  // Build v2 header
  const header: ChunkedEncryptionHeaderV2 = {
    version: 2,
    alg: 'AES-GCM',
    keySize: 256,
    chunkSize,
    chunkCount,
    metaHash,
    totalSize: totalLength,
  };

  const headerJson = JSON.stringify(header);
  const headerBytes = textEncoder.encode(headerJson);
  const headerLenBuf = new ArrayBuffer(4);
  writeUint32(new DataView(headerLenBuf), 0, headerBytes.byteLength);

  // Assemble final result: [headerLen(4)] [headerJSON] [chunk1] [chunk2] ...
  let encryptedLength = 4 + headerBytes.byteLength;
  for (const chunk of chunks) {
    encryptedLength += chunk.byteLength;
  }

  const resultBytes = new Uint8Array(encryptedLength);
  resultBytes.set(new Uint8Array(headerLenBuf), 0);
  resultBytes.set(headerBytes, 4);

  let offset = 4 + headerBytes.byteLength;
  for (const chunk of chunks) {
    resultBytes.set(chunk, offset);
    offset += chunk.byteLength;
  }

  // Compute content hash
  const contentHashBuffer = await crypto.subtle.digest('SHA-256', resultBytes);
  const contentHash = toHex(contentHashBuffer);

  const blob = new Blob([resultBytes], { type: 'application/octet-stream' });

  post({ type: 'success', blob, contentHash });
};

self.onmessage = async (e: MessageEvent<EncryptMessage>) => {
  try {
    const msg = e.data;
    if (msg.type !== 'encrypt') {
      post({ type: 'error', message: `Unknown message type: ${(msg as { type: string }).type}` });
      return;
    }
    await encrypt(msg);
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    post({ type: 'error', message });
  }
};

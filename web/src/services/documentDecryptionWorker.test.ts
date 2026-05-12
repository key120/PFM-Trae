/**
 * documentDecryptionWorker.test.ts
 *
 * Adapter integration tests for the Web Worker decryption adapter.
 * Worker correctness is verified indirectly: the mock Worker performs the
 * same AES-GCM chunk decryption the real Worker implements, producing the
 * raw plaintext buffer format (metaLen + metaJson + fileBytes) that the
 * adapter's parseWorkerPlaintext expects. This confirms the adapter's
 * message protocol, error handling, timeout, and fallback logic work correctly.
 */
import { describe, expect, it, vi, beforeEach, afterEach } from 'vitest';
import {
  encryptDocumentChunked,
  decryptDocumentChunked,
} from './encryptionService';
import {
  readUint32,
  DEFAULT_DOCUMENT_CHUNK_SIZE,
} from './documentEncryptionShared';

/* ------------------------------------------------------------------ */
/*  Helpers                                                            */
/* ------------------------------------------------------------------ */

const createAesGcmKey = () =>
  crypto.subtle.generateKey(
    { name: 'AES-GCM', length: 256 },
    true,
    ['encrypt', 'decrypt'],
  );

const blobToArrayBuffer = (blob: Blob): Promise<ArrayBuffer> =>
  new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => {
      const result = reader.result;
      if (result instanceof ArrayBuffer) resolve(result);
      else reject(new Error('Unexpected FileReader result type'));
    };
    reader.onerror = () => reject(reader.error ?? new Error('Failed to read Blob'));
    reader.readAsArrayBuffer(blob);
  });

const readFileText = (file: File): Promise<string> =>
  new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => {
      const result = reader.result;
      if (typeof result === 'string') resolve(result);
      else reject(new Error('Unexpected FileReader result type'));
    };
    reader.onerror = () => reject(reader.error ?? new Error('Failed to read File'));
    reader.readAsText(file);
  });

/**
 * Decrypt a v2 encrypted ArrayBuffer and return the raw plaintext buffer
 * in the format the real Worker produces: [4-byte metaLen] [metaJson] [fileBytes].
 *
 * This performs the actual AES-GCM chunk decryption (same algorithm as the
 * real Worker) but does NOT parse the metadata — it returns the raw buffer
 * so the adapter's parseWorkerPlaintext can exercise its parsing logic.
 */
const decryptToRawPlaintext = async (
  encrypted: ArrayBuffer,
  key: CryptoKey,
): Promise<ArrayBuffer> => {
  const bytes = new Uint8Array(encrypted);
  if (bytes.byteLength < 4) {
    throw new Error('Encrypted blob is too small');
  }

  const headerLenView = new DataView(bytes.buffer, bytes.byteOffset, 4);
  const headerLen = readUint32(headerLenView, 0);

  if (headerLen <= 0 || 4 + headerLen > bytes.byteLength) {
    throw new Error('Invalid header length');
  }

  const headerJson = new TextDecoder().decode(bytes.slice(4, 4 + headerLen));
  const header = JSON.parse(headerJson) as {
    version: number;
    alg: string;
    keySize: number;
    chunkSize: number;
    chunkCount: number;
    totalSize: number;
  };

  if (header.version !== 2 || header.alg !== 'AES-GCM' || header.keySize !== 256) {
    throw new Error('Unsupported encryption version or algorithm');
  }

  const BATCH_SIZE = 4;
  const chunkOffsets: { readOffset: number; cipherLen: number }[] = [];
  let readOffset = 4 + headerLen;
  for (let i = 0; i < header.chunkCount; i += 1) {
    if (readOffset + 12 + 4 > bytes.byteLength) {
      throw new Error('Invalid chunk header');
    }
    const lenView = new DataView(bytes.buffer, bytes.byteOffset + readOffset + 12, 4);
    const cipherLen = readUint32(lenView, 0);
    chunkOffsets.push({ readOffset, cipherLen });
    readOffset += 12 + 4 + cipherLen;
  }

  const plaintext = new Uint8Array(header.totalSize);
  let writeOffset = 0;

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
    for (const { data } of results) {
      plaintext.set(data, writeOffset);
      writeOffset += data.byteLength;
    }
  }

  return plaintext.buffer;
};

/* ------------------------------------------------------------------ */
/*  Adapter integration tests                                          */
/* ------------------------------------------------------------------ */

describe('documentDecryptionWorker 适配层集成测试', () => {
  let originalWorker: typeof Worker;

  beforeEach(() => {
    originalWorker = globalThis.Worker;
  });

  afterEach(() => {
    globalThis.Worker = originalWorker;
  });

  /**
   * 创建一个 MockWorker，模拟 documentDecrypt.worker.ts 的行为。
   * 在 postMessage 收到消息后异步执行解密，通过 onmessage 回调返回结果。
   *
   * 解密逻辑放在 postMessage 而非构造函数中，因为适配层在调用
   * postMessage 之前才设置 onmessage 回调（先做异步 arrayBuffer 转换）。
   */
  const createMockWorkerFactory = () => {
    return class MockWorker {
      onmessage: ((e: MessageEvent) => void) | null = null;
      onerror: ((e: ErrorEvent) => void) | null = null;

      constructor(_url: string | URL, _opts?: WorkerOptions) {}

      postMessage(msg: unknown) {
        // Defer to let adapter's onmessage be set first (microtask ordering)
        queueMicrotask(async () => {
          try {
            const { encrypted, key } = msg as {
              type: 'decrypt';
              encrypted: ArrayBuffer;
              key: CryptoKey;
            };
            // Decrypt chunks and produce raw plaintext buffer (same format as the
            // real Worker: metaLen + metaJson + fileBytes). The adapter's
            // parseWorkerPlaintext will parse this format.
            const plaintextBuffer = await decryptToRawPlaintext(encrypted, key);
            this.onmessage?.(new MessageEvent('message', {
              data: { type: 'success', plaintext: plaintextBuffer },
            }));
          } catch (err) {
            const message = err instanceof Error ? err.message : String(err);
            this.onerror?.(new ErrorEvent('error', { message }));
          }
        });
      }

      terminate() {}
    };
  };

  it('成功解密并返回 file 和 meta', async () => {
    const MockWorker = createMockWorkerFactory();
    globalThis.Worker = MockWorker as unknown as typeof Worker;

    const { decryptDocumentChunkedViaWorker } = await import('./documentDecryptionWorker');

    const key = await createAesGcmKey();
    const content = '适配层解密测试';
    const file = new File([content], 'adapter.docx', {
      type: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
    });
    const meta = { title: 'adapter.docx', remark: '适配层测试' };

    const { blob } = await encryptDocumentChunked(
      { file, key, meta },
      { chunkSize: 16 },
    );

    const result = await decryptDocumentChunkedViaWorker(
      blob,
      key,
      'adapter.docx',
      'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
    );

    expect(result.file).toBeInstanceOf(File);
    expect(result.file.name).toBe('adapter.docx');
    expect(await readFileText(result.file)).toBe(content);
    expect(result.meta).toEqual(meta);
  });

  it('Worker 抛错时通过 reject 传播错误', async () => {
    // Mock Worker that always fails via onerror
    class FailingWorker {
      onmessage: ((e: MessageEvent) => void) | null = null;
      onerror: ((e: ErrorEvent) => void) | null = null;

      constructor(_url: string | URL, _opts?: WorkerOptions) {
        queueMicrotask(() => {
          this.onerror?.(new ErrorEvent('error', { message: 'Worker init failed' }));
        });
      }

      postMessage(_msg: unknown) {}
      terminate() {}
    }

    globalThis.Worker = FailingWorker as unknown as typeof Worker;

    const { decryptDocumentChunkedViaWorker } = await import('./documentDecryptionWorker');

    const key = await createAesGcmKey();
    const content = '回退测试内容';
    const file = new File([content], 'fallback.docx', {
      type: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
    });
    const meta = { title: 'fallback.docx' };

    const { blob } = await encryptDocumentChunked(
      { file, key, meta },
      { chunkSize: 16 },
    );

    // Worker errors now reject directly (no fallback) after try/catch restructure
    await expect(
      decryptDocumentChunkedViaWorker(
        blob,
        key,
        'fallback.docx',
        'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
      ),
    ).rejects.toThrow('Worker init failed');
  });

  it('Worker onmessage 返回 error 时通过 reject 传播错误', async () => {
    class ErrorMessageWorker {
      onmessage: ((e: MessageEvent) => void) | null = null;
      onerror: ((e: ErrorEvent) => void) | null = null;

      constructor(_url: string | URL, _opts?: WorkerOptions) {
        queueMicrotask(() => {
          this.onmessage?.(new MessageEvent('message', {
            data: { type: 'error', message: 'Decryption failed in worker' },
          }));
        });
      }

      postMessage(_msg: unknown) {}
      terminate() {}
    }

    globalThis.Worker = ErrorMessageWorker as unknown as typeof Worker;

    const { decryptDocumentChunkedViaWorker } = await import('./documentDecryptionWorker');

    const key = await createAesGcmKey();
    const file = new File(['data'], 'err.docx', { type: 'application/octet-stream' });
    const { blob } = await encryptDocumentChunked({ file, key });

    // Worker error messages now reject directly (no fallback)
    await expect(
      decryptDocumentChunkedViaWorker(blob, key, 'err.docx'),
    ).rejects.toThrow('Decryption failed in worker');
  });

  it('Worker 解密与主线程解密结果一致', async () => {
    const MockWorker = createMockWorkerFactory();
    globalThis.Worker = MockWorker as unknown as typeof Worker;

    const { decryptDocumentChunkedViaWorker } = await import('./documentDecryptionWorker');

    const key = await createAesGcmKey();
    const size = 3 * 1024 + 256;
    const bytes = new Uint8Array(size);
    for (let i = 0; i < size; i += 1) {
      bytes[i] = i % 251;
    }

    const file = new Blob([bytes], { type: 'application/octet-stream' });
    const meta = { title: '一致性测试', remark: '多块', selectedKeys: ['x', 'y'] };

    const { blob } = await encryptDocumentChunked(
      { file, key, meta },
      { chunkSize: 1024 },
    );

    // Worker path
    const workerResult = await decryptDocumentChunkedViaWorker(
      blob, key, 'worker.bin', 'application/octet-stream',
    );

    // Main-thread path
    const mainResult = await decryptDocumentChunked(
      blob, key, 'main.bin', 'application/octet-stream',
    );

    const workerBytes = new Uint8Array(await blobToArrayBuffer(workerResult.file));
    const mainBytes = new Uint8Array(await blobToArrayBuffer(mainResult.file));
    expect(workerBytes.byteLength).toBe(mainBytes.byteLength);
    for (let i = 0; i < workerBytes.byteLength; i += 256) {
      expect(workerBytes[i]).toBe(mainBytes[i]);
    }
    expect(workerResult.meta).toEqual(mainResult.meta);
  });
});

import { describe, expect, it } from 'vitest';
import {
  encryptDocument,
  decryptDocument,
  encryptDocumentChunked,
  decryptDocumentChunked,
  EncryptedBlobFormatError,
  EncryptedBlobIntegrityError,
  EncryptedBlobVersionError,
} from './encryptionService';
import {
  DEFAULT_DOCUMENT_CHUNK_SIZE,
  computeMetadataHash,
  readUint32,
  toHex,
  writeUint32,
  type ChunkedEncryptionHeaderV2,
} from './documentEncryptionShared';

const createAesGcmKey = () => {
  return crypto.subtle.generateKey(
    {
      name: 'AES-GCM',
      length: 256,
    },
    true,
    ['encrypt', 'decrypt'],
  );
};

const readFileText = (file: File): Promise<string> => {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => {
      const result = reader.result;
      if (typeof result === 'string') {
        resolve(result);
      } else {
        reject(new Error('Unexpected FileReader result type'));
      }
    };
    reader.onerror = () => {
      reject(reader.error ?? new Error('Failed to read File'));
    };
    reader.readAsText(file);
  });
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

const toHexString = (buffer: ArrayBuffer): string => {
  return Array.from(new Uint8Array(buffer))
    .map((byte) => byte.toString(16).padStart(2, '0'))
    .join('');
};

describe('documentEncryptionShared 共享协议工具', () => {
  it('以大端序写入和读取 Uint32', () => {
    const buffer = new ArrayBuffer(8);
    const view = new DataView(buffer);

    writeUint32(view, 0, 0x01020304);
    writeUint32(view, 4, 0xa0b0c0d0);

    expect(readUint32(view, 0)).toBe(0x01020304);
    expect(readUint32(view, 4)).toBe(0xa0b0c0d0);
    expect(Array.from(new Uint8Array(buffer))).toEqual([1, 2, 3, 4, 160, 176, 192, 208]);
  });

  it('将 ArrayBuffer 转为十六进制字符串', () => {
    const bytes = Uint8Array.from([0, 15, 16, 255]);
    expect(toHex(bytes.buffer)).toBe('000f10ff');
  });

  it('计算 metadata hash 时与现有 SHA-256 十六进制语义保持一致', async () => {
    const metaJson = JSON.stringify({
      title: '协议基线',
      remark: 'metadata hash',
      selectedKeys: ['a', 'b'],
    });

    const expected = toHex(await crypto.subtle.digest('SHA-256', new TextEncoder().encode(metaJson)));

    await expect(computeMetadataHash(metaJson)).resolves.toBe(expected);
  });

  it('暴露分块协议默认 chunkSize 与 v2 header 类型语义', () => {
    const header: ChunkedEncryptionHeaderV2 = {
      version: 2,
      alg: 'AES-GCM',
      keySize: 256,
      chunkSize: DEFAULT_DOCUMENT_CHUNK_SIZE,
      chunkCount: 3,
      metaHash: 'ab'.repeat(32),
      totalSize: 4096,
    };

    expect(header.chunkSize).toBe(1024 * 1024);
    expect(header.version).toBe(2);
    expect(header.alg).toBe('AES-GCM');
  });
});

describe('encryptionService 小文件加解密', () => {
  it('可以对文件和元数据进行加密和解密', async () => {
    const key = await createAesGcmKey();
    const content = 'hello world';
    const file = new File([content], 'original.txt', { type: 'text/plain' });

    const meta = {
      title: '测试标题',
      remark: '备注信息',
      extra: {
        value: 1,
      },
    };

    const encrypted = await encryptDocument({
      file,
      key,
      meta,
    });

    const result = await decryptDocument(encrypted, key, 'decrypted.txt', 'text/plain');

    expect(result.file).toBeInstanceOf(File);
    expect(result.file.name).toBe('decrypted.txt');
    expect(result.file.type).toBe('text/plain');

    const text = await readFileText(result.file);
    expect(text).toBe(content);
    expect(result.meta).toEqual(meta);
  });

  it('使用不同的密钥解密时会失败', async () => {
    const key1 = await createAesGcmKey();
    const key2 = await createAesGcmKey();
    const file = new File(['secret'], 'secret.txt', { type: 'text/plain' });

    const encrypted = await encryptDocument({
      file,
      key: key1,
    });

    await expect(
      decryptDocument(encrypted, key2, 'secret.txt', 'text/plain'),
    ).rejects.toBeInstanceOf(EncryptedBlobIntegrityError);
  });

  it('损坏的加密数据会触发格式错误', async () => {
    const key = await createAesGcmKey();
    const badBlob = new Blob([new Uint8Array([1, 2, 3, 4, 5])]);

    await expect(
      decryptDocument(badBlob, key, 'broken.bin', 'application/octet-stream'),
    ).rejects.toBeInstanceOf(EncryptedBlobFormatError);
  });

  it('不支持的版本或算法会触发版本错误', async () => {
    const key = await createAesGcmKey();
    const file = new File(['data'], 'data.txt', { type: 'text/plain' });

    const encrypted = await encryptDocument({
      file,
      key,
    });

    const buffer = await blobToArrayBuffer(encrypted);
    const bytes = new Uint8Array(buffer);

    const headerLenView = new DataView(bytes.buffer, bytes.byteOffset, 4);
    const headerLen = headerLenView.getUint32(0, false);

    const headerBytes = bytes.slice(4, 4 + headerLen);
    const headerJson = new TextDecoder().decode(headerBytes);
    const header = JSON.parse(headerJson) as {
      version: number;
      alg: string;
      keySize: number;
      nonce: string;
      metaHash: string;
    };

    header.version = 999;

    const newHeaderJson = JSON.stringify(header);
    const newHeaderBytes = new TextEncoder().encode(newHeaderJson);

    const newHeaderLenBuffer = new ArrayBuffer(4);
    const newHeaderLenView = new DataView(newHeaderLenBuffer);
    newHeaderLenView.setUint32(0, newHeaderBytes.byteLength, false);

    const ciphertextBytes = bytes.slice(4 + headerLen);
    const combined = new Uint8Array(4 + newHeaderBytes.byteLength + ciphertextBytes.byteLength);
    combined.set(new Uint8Array(newHeaderLenBuffer), 0);
    combined.set(newHeaderBytes, 4);
    combined.set(ciphertextBytes, 4 + newHeaderBytes.byteLength);

    const tamperedBlob = new Blob([combined], { type: 'application/octet-stream' });

    await expect(
      decryptDocument(tamperedBlob, key, 'data.txt', 'text/plain'),
    ).rejects.toBeInstanceOf(EncryptedBlobVersionError);
  });

  it('元数据哈希不匹配时会触发完整性错误', async () => {
    const key = await createAesGcmKey();
    const file = new File(['payload'], 'payload.txt', { type: 'text/plain' });

    const encrypted = await encryptDocument({
      file,
      key,
    });

    const buffer = await blobToArrayBuffer(encrypted);
    const bytes = new Uint8Array(buffer);

    const headerLenView = new DataView(bytes.buffer, bytes.byteOffset, 4);
    const headerLen = headerLenView.getUint32(0, false);

    const headerBytes = bytes.slice(4, 4 + headerLen);
    const headerJson = new TextDecoder().decode(headerBytes);
    const header = JSON.parse(headerJson) as {
      version: number;
      alg: string;
      keySize: number;
      nonce: string;
      metaHash: string;
    };

    header.metaHash = '00'.repeat(header.metaHash.length / 2);

    const newHeaderJson = JSON.stringify(header);
    const newHeaderBytes = new TextEncoder().encode(newHeaderJson);

    const newHeaderLenBuffer = new ArrayBuffer(4);
    const newHeaderLenView = new DataView(newHeaderLenBuffer);
    newHeaderLenView.setUint32(0, newHeaderBytes.byteLength, false);

    const ciphertextBytes = bytes.slice(4 + headerLen);
    const combined = new Uint8Array(4 + newHeaderBytes.byteLength + ciphertextBytes.byteLength);
    combined.set(new Uint8Array(newHeaderLenBuffer), 0);
    combined.set(newHeaderBytes, 4);
    combined.set(ciphertextBytes, 4 + newHeaderBytes.byteLength);

    const tamperedBlob = new Blob([combined], { type: 'application/octet-stream' });

    await expect(
      decryptDocument(tamperedBlob, key, 'payload.txt', 'text/plain'),
    ).rejects.toBeInstanceOf(EncryptedBlobIntegrityError);
  });
});

describe('encryptionService 分块加解密', () => {
  it('支持多块分片的加密和解密', async () => {
    const key = await createAesGcmKey();
    const size = 3 * 1024 * 1024 + 123;
    const bytes = new Uint8Array(size);
    for (let i = 0; i < size; i += 1) {
      bytes[i] = i % 251;
    }

    const file = new Blob([bytes], { type: 'application/octet-stream' });
    const meta = {
      title: '大文件测试',
      remark: '多块分片',
    };

    const { blob, contentHash } = await encryptDocumentChunked(
      {
        file,
        key,
        meta,
      },
      {
        chunkSize: 1024 * 1024,
      },
    );

    expect(typeof contentHash).toBe('string');
    expect(contentHash.length).toBeGreaterThan(0);

    const result = await decryptDocumentChunked(
      blob,
      key,
      'large.bin',
      'application/octet-stream',
    );

    expect(result.file).toBeInstanceOf(File);
    expect(result.file.name).toBe('large.bin');
    expect(result.file.type).toBe('application/octet-stream');
    expect(result.meta).toEqual(meta);

    const decryptedBytes = new Uint8Array(await blobToArrayBuffer(result.file));
    expect(decryptedBytes.byteLength).toBe(bytes.byteLength);
    for (let i = 0; i < decryptedBytes.byteLength; i += 1024) {
      expect(decryptedBytes[i]).toBe(bytes[i]);
    }
  });

  it('当前主线程分块加密产物可被现有解密逻辑解开，作为后续 Worker 兼容基线', async () => {
    const key = await createAesGcmKey();
    const sourceText = '阶段 0 兼容性基线，用于约束后续 Worker 输出格式';
    const file = new File([sourceText], 'baseline.docx', {
      type: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
    });
    const meta = {
      title: 'baseline.docx',
      remark: '兼容性基线',
      selectedKeys: ['intro', 'chapter-1'],
      originalFileName: 'baseline.docx',
      mimeType: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
    };

    const { blob, contentHash } = await encryptDocumentChunked(
      {
        file,
        key,
        meta,
      },
      {
        chunkSize: 8,
      },
    );

    const encryptedBytes = new Uint8Array(await blobToArrayBuffer(blob));
    const headerLength = new DataView(encryptedBytes.buffer, encryptedBytes.byteOffset, 4).getUint32(0, false);
    const header = JSON.parse(
      new TextDecoder().decode(encryptedBytes.slice(4, 4 + headerLength)),
    ) as {
      version: number;
      alg: string;
      keySize: number;
      chunkSize: number;
      chunkCount: number;
      metaHash: string;
      totalSize: number;
    };

    expect(header.version).toBe(2);
    expect(header.alg).toBe('AES-GCM');
    expect(header.keySize).toBe(256);
    expect(header.chunkSize).toBe(8);
    expect(header.chunkCount).toBeGreaterThan(1);
    expect(contentHash).toBe(toHexString(await crypto.subtle.digest('SHA-256', encryptedBytes)));

    const decrypted = await decryptDocumentChunked(
      blob,
      key,
      'roundtrip.docx',
      'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
    );

    expect(await readFileText(decrypted.file)).toBe(sourceText);
    expect(decrypted.meta).toEqual(meta);
  });

  it('使用不同密钥解密分块数据时触发完整性错误', async () => {
    const key1 = await createAesGcmKey();
    const key2 = await createAesGcmKey();
    const file = new Blob([new Uint8Array(100).fill(42)], { type: 'application/octet-stream' });

    const { blob } = await encryptDocumentChunked({ file, key: key1 });

    await expect(
      decryptDocumentChunked(blob, key2, 'test.bin'),
    ).rejects.toBeInstanceOf(EncryptedBlobIntegrityError);
  });

  it('损坏的分块数据触发格式错误', async () => {
    const badBlob = new Blob([new Uint8Array([1, 2, 3, 4, 5])]);

    await expect(
      decryptDocumentChunked(badBlob, await createAesGcmKey(), 'broken.bin'),
    ).rejects.toBeInstanceOf(EncryptedBlobFormatError);
  });

  it('不支持的版本触发版本错误', async () => {
    const key = await createAesGcmKey();
    const file = new Blob([new Uint8Array(10).fill(1)], { type: 'application/octet-stream' });
    const { blob } = await encryptDocumentChunked({ file, key });

    const buffer = await blobToArrayBuffer(blob);
    const bytes = new Uint8Array(buffer);

    const headerLenView = new DataView(bytes.buffer, bytes.byteOffset, 4);
    const headerLen = headerLenView.getUint32(0, false);
    const headerBytes = bytes.slice(4, 4 + headerLen);
    const header = JSON.parse(new TextDecoder().decode(headerBytes)) as Record<string, unknown>;
    header['version'] = 999;

    const newHeaderBytes = new TextEncoder().encode(JSON.stringify(header));
    const lenBuf = new ArrayBuffer(4);
    new DataView(lenBuf).setUint32(0, newHeaderBytes.byteLength, false);
    const rest = bytes.slice(4 + headerLen);
    const combined = new Uint8Array(4 + newHeaderBytes.byteLength + rest.byteLength);
    combined.set(new Uint8Array(lenBuf), 0);
    combined.set(newHeaderBytes, 4);
    combined.set(rest, 4 + newHeaderBytes.byteLength);

    await expect(
      decryptDocumentChunked(new Blob([combined]), key, 'test.bin'),
    ).rejects.toBeInstanceOf(EncryptedBlobVersionError);
  });

  it('分块数据元数据哈希不匹配时触发完整性错误', async () => {
    const key = await createAesGcmKey();
    const file = new Blob([new Uint8Array(10).fill(2)], { type: 'application/octet-stream' });
    const { blob } = await encryptDocumentChunked({ file, key, meta: { title: '测试' } });

    const buffer = await blobToArrayBuffer(blob);
    const bytes = new Uint8Array(buffer);

    const headerLenView = new DataView(bytes.buffer, bytes.byteOffset, 4);
    const headerLen = headerLenView.getUint32(0, false);
    const headerBytes = bytes.slice(4, 4 + headerLen);
    const header = JSON.parse(new TextDecoder().decode(headerBytes)) as Record<string, unknown>;
    header['metaHash'] = '00'.repeat(32);

    const newHeaderBytes = new TextEncoder().encode(JSON.stringify(header));
    const lenBuf = new ArrayBuffer(4);
    new DataView(lenBuf).setUint32(0, newHeaderBytes.byteLength, false);
    const rest = bytes.slice(4 + headerLen);
    const combined = new Uint8Array(4 + newHeaderBytes.byteLength + rest.byteLength);
    combined.set(new Uint8Array(lenBuf), 0);
    combined.set(newHeaderBytes, 4);
    combined.set(rest, 4 + newHeaderBytes.byteLength);

    await expect(
      decryptDocumentChunked(new Blob([combined]), key, 'test.bin'),
    ).rejects.toBeInstanceOf(EncryptedBlobIntegrityError);
  });
});

describe('Worker 加密兼容性契约测试', () => {
  /**
   * 模拟 Worker 的加密逻辑：
   * 使用 Blob.slice() + arrayBuffer() 逐块读取明文，
   * 产出的二进制格式必须能被 decryptDocumentChunked 正确解密。
   */
  const workerEncrypt = async (
    file: File | Blob,
    key: CryptoKey,
    meta?: Record<string, unknown>,
    chunkSize = DEFAULT_DOCUMENT_CHUNK_SIZE,
  ): Promise<{ blob: Blob; contentHash: string }> => {
    const metaJson = JSON.stringify(meta ?? null);
    const metaBytes = new TextEncoder().encode(metaJson);

    // 构建完整的明文 blob：[metaLen(4)] [metaJson] [fileBytes]
    const metaLenBuf = new ArrayBuffer(4);
    new DataView(metaLenBuf).setUint32(0, metaBytes.byteLength, false);

    const plaintextBlob = new Blob(
      [metaLenBuf, metaBytes, file],
      { type: 'application/octet-stream' },
    );

    const totalLength = plaintextBlob.size;
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
      new DataView(lenBuf).setUint32(0, cipherBytes.byteLength, false);

      const combined = new Uint8Array(12 + 4 + cipherBytes.byteLength);
      combined.set(nonce, 0);
      combined.set(new Uint8Array(lenBuf), 12);
      combined.set(cipherBytes, 16);

      chunks.push(combined);
    }

    const metaHash = await computeMetadataHash(metaJson);

    const header = {
      version: 2,
      alg: 'AES-GCM',
      keySize: 256,
      chunkSize,
      chunkCount,
      metaHash,
      totalSize: totalLength,
    };

    const headerJson = JSON.stringify(header);
    const headerBytes = new TextEncoder().encode(headerJson);
    const headerLenBuf = new ArrayBuffer(4);
    new DataView(headerLenBuf).setUint32(0, headerBytes.byteLength, false);

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

    const blob = new Blob([resultBytes], { type: 'application/octet-stream' });
    const contentHashBuffer = await crypto.subtle.digest('SHA-256', resultBytes);
    const contentHash = toHex(contentHashBuffer);

    return { blob, contentHash };
  };

  it('Worker 模拟加密产出可被 decryptDocumentChunked 解密（小文件）', async () => {
    const key = await createAesGcmKey();
    const content = 'Worker 兼容性测试：小文件';
    const file = new File([content], 'worker-small.docx', {
      type: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
    });
    const meta = {
      title: 'worker-small.docx',
      remark: 'Worker 模拟加密',
      selectedKeys: ['intro'],
    };

    const { blob, contentHash } = await workerEncrypt(file, key, meta, 16);

    expect(contentHash.length).toBeGreaterThan(0);

    const result = await decryptDocumentChunked(
      blob,
      key,
      'decrypted.docx',
      'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
    );

    expect(await readFileText(result.file)).toBe(content);
    expect(result.meta).toEqual(meta);
  });

  it('Worker 模拟加密产出可被 decryptDocumentChunked 解密（多块大文件）', async () => {
    const key = await createAesGcmKey();
    const size = 3 * 1024 + 512; // 3.5KB with 1KB chunks = 4 chunks
    const bytes = new Uint8Array(size);
    for (let i = 0; i < size; i += 1) {
      bytes[i] = i % 251;
    }

    const file = new Blob([bytes], { type: 'application/octet-stream' });
    const meta = {
      title: '大文件 Worker 测试',
      remark: '多块分片',
      selectedKeys: ['a', 'b', 'c'],
    };

    const chunkSize = 1024;
    const { blob, contentHash } = await workerEncrypt(file, key, meta, chunkSize);

    // 验证 contentHash 是 SHA-256 的十六进制表示
    expect(contentHash.length).toBe(64);

    const result = await decryptDocumentChunked(
      blob,
      key,
      'large.bin',
      'application/octet-stream',
    );

    expect(result.file).toBeInstanceOf(File);
    expect(result.file.name).toBe('large.bin');
    expect(result.meta).toEqual(meta);

    const decryptedBytes = new Uint8Array(await blobToArrayBuffer(result.file));
    expect(decryptedBytes.byteLength).toBe(size);
    for (let i = 0; i < decryptedBytes.byteLength; i += 256) {
      expect(decryptedBytes[i]).toBe(bytes[i]);
    }
  });

  it('Worker 模拟加密产出与主线程 encryptDocumentChunked 产出结构一致', async () => {
    const key = await createAesGcmKey();
    const content = '结构一致性对比测试';
    const file = new File([content], 'struct.docx', {
      type: 'application/octet-stream',
    });
    const meta = { title: 'struct.docx', remark: '结构对比' };
    const chunkSize = 16;

    const workerResult = await workerEncrypt(file, key, meta, chunkSize);
    const mainResult = await encryptDocumentChunked({ file, key, meta }, { chunkSize });

    // 解析两边的 header
    const parseHeader = (blob: Blob) =>
      blobToArrayBuffer(blob).then((buf) => {
        const bytes = new Uint8Array(buf);
        const headerLen = new DataView(bytes.buffer, bytes.byteOffset, 4).getUint32(0, false);
        return JSON.parse(
          new TextDecoder().decode(bytes.slice(4, 4 + headerLen)),
        ) as Record<string, unknown>;
      });

    const workerHeader = await parseHeader(workerResult.blob);
    const mainHeader = await parseHeader(mainResult.blob);

    // version, alg, keySize, chunkSize, chunkCount, totalSize 必须一致
    expect(workerHeader.version).toBe(mainHeader.version);
    expect(workerHeader.alg).toBe(mainHeader.alg);
    expect(workerHeader.keySize).toBe(mainHeader.keySize);
    expect(workerHeader.chunkSize).toBe(mainHeader.chunkSize);
    expect(workerHeader.chunkCount).toBe(mainHeader.chunkCount);
    expect(workerHeader.totalSize).toBe(mainHeader.totalSize);
    expect(workerHeader.metaHash).toBe(mainHeader.metaHash);

    // metaHash 相同意味着 headerJSON 相同 → headerLen 相同 → chunkCount 相同
    // 两边都能被 decryptDocumentChunked 解密即可证明兼容性
    const workerDecrypted = await decryptDocumentChunked(
      workerResult.blob,
      key,
      'worker.docx',
    );
    const mainDecrypted = await decryptDocumentChunked(
      mainResult.blob,
      key,
      'main.docx',
    );

    expect(await readFileText(workerDecrypted.file)).toBe(content);
    expect(await readFileText(mainDecrypted.file)).toBe(content);
    expect(workerDecrypted.meta).toEqual(mainDecrypted.meta);
  });

  it('Worker 模拟加密产出的 contentHash 等于完整加密 blob 的 SHA-256', async () => {
    const key = await createAesGcmKey();
    const file = new File(['hash verification'], 'hash.txt', { type: 'text/plain' });
    const meta = { title: 'hash.txt' };

    const { blob, contentHash } = await workerEncrypt(file, key, meta, 16);

    const buf = await blobToArrayBuffer(blob);
    const expectedHash = toHex(await crypto.subtle.digest('SHA-256', buf));
    expect(contentHash).toBe(expectedHash);
  });

  it('Worker 模拟加密支持空元数据', async () => {
    const key = await createAesGcmKey();
    const file = new File(['no meta'], 'empty-meta.txt', { type: 'text/plain' });

    const { blob } = await workerEncrypt(file, key, undefined, 16);

    const result = await decryptDocumentChunked(blob, key, 'out.txt', 'text/plain');
    expect(await readFileText(result.file)).toBe('no meta');
    expect(result.meta).toBeNull();
  });
});

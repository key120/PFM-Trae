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

    const decryptedBytes = new Uint8Array(
      await new Promise<ArrayBuffer>((resolve, reject) => {
        const reader = new FileReader();
        reader.onload = () => {
          const res = reader.result;
          if (res instanceof ArrayBuffer) {
            resolve(res);
          } else {
            reject(new Error('Unexpected FileReader result type'));
          }
        };
        reader.onerror = () => {
          reject(reader.error ?? new Error('Failed to read File'));
        };
        reader.readAsArrayBuffer(result.file);
      }),
    );
    expect(decryptedBytes.byteLength).toBe(bytes.byteLength);
    for (let i = 0; i < decryptedBytes.byteLength; i += 1024) {
      expect(decryptedBytes[i]).toBe(bytes[i]);
    }
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

import type { DocumentKey } from './cryptoKeyService';
import {
  DEFAULT_DOCUMENT_CHUNK_SIZE,
  computeMetadataHash,
  readUint32,
  toHex,
  writeUint32,
  type ChunkedEncryptionHeaderV2,
} from './documentEncryptionShared';

export type EncryptDocumentMeta = {
  title?: string;
  remark?: string;
  [k: string]: unknown;
};

export type EncryptDocumentInput = {
  file: File | Blob;
  key: DocumentKey;
  meta?: EncryptDocumentMeta;
};

export type DecryptDocumentResult = {
  file: File;
  meta: EncryptDocumentMeta | null;
};

export type ChunkEncryptOptions = {
  chunkSize?: number;
};

export type ChunkEncryptResult = {
  blob: Blob;
  contentHash: string;
};

export class EncryptedBlobFormatError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'EncryptedBlobFormatError';
  }
}

export class EncryptedBlobVersionError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'EncryptedBlobVersionError';
  }
}

export class EncryptedBlobIntegrityError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'EncryptedBlobIntegrityError';
  }
}

const textEncoder = new TextEncoder();
const textDecoder = new TextDecoder();

const bytesToBase64 = (bytes: Uint8Array): string => {
  let binary = '';
  for (let i = 0; i < bytes.length; i += 1) {
    binary += String.fromCharCode(bytes[i] ?? 0);
  }
  return btoa(binary);
};

const base64ToBytes = (value: string): Uint8Array => {
  const binary = atob(value);
  const result = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i += 1) {
    result[i] = binary.charCodeAt(i);
  }
  return result;
};

const blobToArrayBuffer = (value: Blob): Promise<ArrayBuffer> => {
  if ('arrayBuffer' in value && typeof (value as Blob & { arrayBuffer?: () => Promise<ArrayBuffer> }).arrayBuffer === 'function') {
    return (value as Blob & { arrayBuffer: () => Promise<ArrayBuffer> }).arrayBuffer();
  }

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
    reader.readAsArrayBuffer(value);
  });
};

export const encryptDocument = async (input: EncryptDocumentInput): Promise<Blob> => {
  if (!crypto.subtle) {
    throw new Error('WebCrypto is not available');
  }

  const key = input.key;
  const meta = input.meta ?? null;
  const fileBuffer = await blobToArrayBuffer(input.file);

  const metaJson = JSON.stringify(meta);
  const metaBytes = textEncoder.encode(metaJson);

  const metaLenBuffer = new ArrayBuffer(4);
  const metaLenView = new DataView(metaLenBuffer);
  writeUint32(metaLenView, 0, metaBytes.byteLength);

  const plaintext = new Uint8Array(4 + metaBytes.byteLength + fileBuffer.byteLength);
  plaintext.set(new Uint8Array(metaLenBuffer), 0);
  plaintext.set(metaBytes, 4);
  plaintext.set(new Uint8Array(fileBuffer), 4 + metaBytes.byteLength);

  const nonce = new Uint8Array(12);
  crypto.getRandomValues(nonce);

  const ciphertextBuffer = await crypto.subtle.encrypt(
    {
      name: 'AES-GCM',
      iv: nonce.buffer as ArrayBuffer,
    },
    key,
    plaintext,
  );

  const metaHash = await computeMetadataHash(metaJson);

  const header = {
    version: 1,
    alg: 'AES-GCM',
    keySize: 256,
    nonce: bytesToBase64(nonce),
    metaHash,
  };

  const headerJson = JSON.stringify(header);
  const headerBytes = textEncoder.encode(headerJson);

  const headerLenBuffer = new ArrayBuffer(4);
  const headerLenView = new DataView(headerLenBuffer);
  writeUint32(headerLenView, 0, headerBytes.byteLength);

  const resultBytes = new Uint8Array(4 + headerBytes.byteLength + ciphertextBuffer.byteLength);
  resultBytes.set(new Uint8Array(headerLenBuffer), 0);
  resultBytes.set(headerBytes, 4);
  resultBytes.set(new Uint8Array(ciphertextBuffer), 4 + headerBytes.byteLength);

  return new Blob([resultBytes], { type: 'application/octet-stream' });
};

export const decryptDocument = async (
  encrypted: Blob,
  key: DocumentKey,
  fileNameFallback: string,
  mimeTypeFallback = 'application/octet-stream',
): Promise<DecryptDocumentResult> => {
  if (!crypto.subtle) {
    throw new Error('WebCrypto is not available');
  }

  const buffer = await blobToArrayBuffer(encrypted);
  const bytes = new Uint8Array(buffer);

  if (bytes.byteLength < 4) {
    throw new EncryptedBlobFormatError('Encrypted blob is too small');
  }

  const headerLenView = new DataView(bytes.buffer, bytes.byteOffset, 4);
  const headerLen = readUint32(headerLenView, 0);

  if (headerLen <= 0 || 4 + headerLen > bytes.byteLength) {
    throw new EncryptedBlobFormatError('Invalid header length');
  }

  const headerBytes = bytes.slice(4, 4 + headerLen);
  const headerJson = textDecoder.decode(headerBytes);

  let header: {
    version: number;
    alg: string;
    keySize: number;
    nonce: string;
    metaHash: string;
  };

  try {
    header = JSON.parse(headerJson);
  } catch {
    throw new EncryptedBlobFormatError('Invalid header JSON');
  }

  if (
    typeof header.version !== 'number' ||
    typeof header.alg !== 'string' ||
    typeof header.keySize !== 'number' ||
    typeof header.nonce !== 'string' ||
    typeof header.metaHash !== 'string'
  ) {
    throw new EncryptedBlobFormatError('Header fields are invalid');
  }

  if (header.version !== 1 || header.alg !== 'AES-GCM' || header.keySize !== 256) {
    throw new EncryptedBlobVersionError('Unsupported encryption version or algorithm');
  }

  const ciphertextBytes = bytes.slice(4 + headerLen);
  if (ciphertextBytes.byteLength === 0) {
    throw new EncryptedBlobFormatError('Ciphertext is empty');
  }

  const nonceBytes = base64ToBytes(header.nonce);

  let plaintextBuffer: ArrayBuffer;
  try {
    plaintextBuffer = await crypto.subtle.decrypt(
      {
        name: 'AES-GCM',
        iv: nonceBytes.buffer as ArrayBuffer,
      },
      key,
      ciphertextBytes,
    );
  } catch {
    throw new EncryptedBlobIntegrityError('Failed to decrypt encrypted blob');
  }

  const plaintextBytes = new Uint8Array(plaintextBuffer);
  if (plaintextBytes.byteLength < 4) {
    throw new EncryptedBlobFormatError('Plaintext is too small');
  }

  const metaLenView = new DataView(plaintextBuffer, 0, 4);
  const metaLen = readUint32(metaLenView, 0);
  if (metaLen < 0 || 4 + metaLen > plaintextBytes.byteLength) {
    throw new EncryptedBlobFormatError('Invalid metadata length');
  }

  const metaBytes = plaintextBytes.slice(4, 4 + metaLen);
  const metaJson = textDecoder.decode(metaBytes);

  const computedHash = await computeMetadataHash(metaJson);

  if (computedHash !== header.metaHash) {
    throw new EncryptedBlobIntegrityError('Metadata hash does not match');
  }

  let meta: EncryptDocumentMeta | null = null;
  try {
    meta = JSON.parse(metaJson);
  } catch {
    throw new EncryptedBlobFormatError('Invalid metadata JSON');
  }

  const fileBytes = plaintextBytes.slice(4 + metaLen);
  const file = new File([fileBytes], fileNameFallback, {
    type: mimeTypeFallback,
  });

  return {
    file,
    meta,
  };
};

export const encryptDocumentChunked = async (
  input: EncryptDocumentInput,
  options?: ChunkEncryptOptions,
): Promise<ChunkEncryptResult> => {
  if (!crypto.subtle) {
    throw new Error('WebCrypto is not available');
  }

  const key = input.key;
  const meta = input.meta ?? null;
  const fileBuffer = await blobToArrayBuffer(input.file);

  const metaJson = JSON.stringify(meta);
  const metaBytes = textEncoder.encode(metaJson);

  const metaLenBuffer = new ArrayBuffer(4);
  const metaLenView = new DataView(metaLenBuffer);
  writeUint32(metaLenView, 0, metaBytes.byteLength);

  const plaintext = new Uint8Array(4 + metaBytes.byteLength + fileBuffer.byteLength);
  plaintext.set(new Uint8Array(metaLenBuffer), 0);
  plaintext.set(metaBytes, 4);
  plaintext.set(new Uint8Array(fileBuffer), 4 + metaBytes.byteLength);

  const chunkSize = options?.chunkSize ?? DEFAULT_DOCUMENT_CHUNK_SIZE;
  const totalLength = plaintext.byteLength;
  const chunkCount = Math.ceil(totalLength / chunkSize);

  const chunks: Uint8Array[] = [];

  for (let i = 0; i < chunkCount; i += 1) {
    const start = i * chunkSize;
    const end = Math.min(start + chunkSize, totalLength);
    const slice = plaintext.subarray(start, end);

    const nonce = new Uint8Array(12);
    crypto.getRandomValues(nonce);

    const ciphertextBuffer = await crypto.subtle.encrypt(
      {
        name: 'AES-GCM',
        iv: nonce.buffer as ArrayBuffer,
      },
      key,
      slice,
    );

    const cipherBytes = new Uint8Array(ciphertextBuffer);
    const lenBuffer = new ArrayBuffer(4);
    const lenView = new DataView(lenBuffer);
    writeUint32(lenView, 0, cipherBytes.byteLength);

    const combined = new Uint8Array(12 + 4 + cipherBytes.byteLength);
    combined.set(nonce, 0);
    combined.set(new Uint8Array(lenBuffer), 12);
    combined.set(cipherBytes, 16);

    chunks.push(combined);
  }

  const metaHash = await computeMetadataHash(metaJson);

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

  const headerLenBuffer = new ArrayBuffer(4);
  const headerLenView = new DataView(headerLenBuffer);
  writeUint32(headerLenView, 0, headerBytes.byteLength);

  let encryptedLength = 4 + headerBytes.byteLength;
  for (let i = 0; i < chunks.length; i += 1) {
    encryptedLength += chunks[i].byteLength;
  }

  const resultBytes = new Uint8Array(encryptedLength);
  resultBytes.set(new Uint8Array(headerLenBuffer), 0);
  resultBytes.set(headerBytes, 4);

  let offset = 4 + headerBytes.byteLength;
  for (let i = 0; i < chunks.length; i += 1) {
    const chunk = chunks[i];
    resultBytes.set(chunk, offset);
    offset += chunk.byteLength;
  }

  const blob = new Blob([resultBytes], { type: 'application/octet-stream' });
  const contentHashBuffer = await crypto.subtle.digest('SHA-256', resultBytes);
  const contentHash = toHex(contentHashBuffer);

  return {
    blob,
    contentHash,
  };
};

export const decryptDocumentChunked = async (
  encrypted: Blob,
  key: DocumentKey,
  fileNameFallback: string,
  mimeTypeFallback = 'application/octet-stream',
): Promise<DecryptDocumentResult> => {
  if (!crypto.subtle) {
    throw new Error('WebCrypto is not available');
  }

  const buffer = await blobToArrayBuffer(encrypted);
  const bytes = new Uint8Array(buffer);

  if (bytes.byteLength < 4) {
    throw new EncryptedBlobFormatError('Encrypted blob is too small');
  }

  const headerLenView = new DataView(bytes.buffer, bytes.byteOffset, 4);
  const headerLen = readUint32(headerLenView, 0);

  if (headerLen <= 0 || 4 + headerLen > bytes.byteLength) {
    throw new EncryptedBlobFormatError('Invalid header length');
  }

  const headerBytes = bytes.slice(4, 4 + headerLen);
  const headerJson = textDecoder.decode(headerBytes);

  let header: ChunkedEncryptionHeaderV2;

  try {
    header = JSON.parse(headerJson);
  } catch {
    throw new EncryptedBlobFormatError('Invalid header JSON');
  }

  if (
    typeof header.version !== 'number' ||
    typeof header.alg !== 'string' ||
    typeof header.keySize !== 'number' ||
    typeof header.chunkSize !== 'number' ||
    typeof header.chunkCount !== 'number' ||
    typeof header.metaHash !== 'string' ||
    typeof header.totalSize !== 'number'
  ) {
    throw new EncryptedBlobFormatError('Header fields are invalid');
  }

  if (header.version !== 2 || header.alg !== 'AES-GCM' || header.keySize !== 256) {
    throw new EncryptedBlobVersionError('Unsupported encryption version or algorithm');
  }

  const expectedMinLength = 4 + headerLen + header.chunkCount * (12 + 4);
  if (bytes.byteLength < expectedMinLength) {
    throw new EncryptedBlobFormatError('Encrypted blob is too small for chunks');
  }

  const plaintext = new Uint8Array(header.totalSize);
  let writeOffset = 0;

  let readOffset = 4 + headerLen;
  for (let i = 0; i < header.chunkCount; i += 1) {
    if (readOffset + 12 + 4 > bytes.byteLength) {
      throw new EncryptedBlobFormatError('Invalid chunk header');
    }

    const nonceBytes = bytes.slice(readOffset, readOffset + 12);
    const lenView = new DataView(bytes.buffer, bytes.byteOffset + readOffset + 12, 4);
    const cipherLen = readUint32(lenView, 0);
    const chunkHeaderSize = 12 + 4;
    const chunkTotalSize = chunkHeaderSize + cipherLen;

    if (cipherLen <= 0 || readOffset + chunkTotalSize > bytes.byteLength) {
      throw new EncryptedBlobFormatError('Invalid chunk length');
    }

    const cipherBytes = bytes.slice(
      readOffset + chunkHeaderSize,
      readOffset + chunkHeaderSize + cipherLen,
    );

    let chunkPlainBuffer: ArrayBuffer;
    try {
      chunkPlainBuffer = await crypto.subtle.decrypt(
        {
          name: 'AES-GCM',
          iv: nonceBytes.buffer as ArrayBuffer,
        },
        key,
        cipherBytes,
      );
    } catch {
      throw new EncryptedBlobIntegrityError('Failed to decrypt encrypted chunk');
    }

    const chunkPlain = new Uint8Array(chunkPlainBuffer);
    if (writeOffset + chunkPlain.byteLength > plaintext.byteLength) {
      throw new EncryptedBlobFormatError('Plaintext is larger than expected');
    }
    plaintext.set(chunkPlain, writeOffset);
    writeOffset += chunkPlain.byteLength;
    readOffset += chunkTotalSize;
  }

  if (writeOffset !== plaintext.byteLength) {
    throw new EncryptedBlobFormatError('Plaintext size does not match header');
  }

  if (plaintext.byteLength < 4) {
    throw new EncryptedBlobFormatError('Plaintext is too small');
  }

  const metaLenView = new DataView(plaintext.buffer, plaintext.byteOffset, 4);
  const metaLen = readUint32(metaLenView, 0);
  if (metaLen < 0 || 4 + metaLen > plaintext.byteLength) {
    throw new EncryptedBlobFormatError('Invalid metadata length');
  }

  const metaBytes = plaintext.slice(4, 4 + metaLen);
  const metaJson = textDecoder.decode(metaBytes);

  const computedHash = await computeMetadataHash(metaJson);

  if (computedHash !== header.metaHash) {
    throw new EncryptedBlobIntegrityError('Metadata hash does not match');
  }

  let meta: EncryptDocumentMeta | null = null;
  try {
    meta = JSON.parse(metaJson);
  } catch {
    throw new EncryptedBlobFormatError('Invalid metadata JSON');
  }

  const fileBytes = plaintext.slice(4 + metaLen);
  const file = new File([fileBytes], fileNameFallback, {
    type: mimeTypeFallback,
  });

  return {
    file,
    meta,
  };
};

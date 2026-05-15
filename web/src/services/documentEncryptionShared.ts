const textEncoder = new TextEncoder();

export const DEFAULT_DOCUMENT_CHUNK_SIZE = 1024 * 1024;

export type ChunkedEncryptionHeaderV2 = {
  version: 2;
  alg: 'AES-GCM';
  keySize: number;
  chunkSize: number;
  chunkCount: number;
  metaHash: string;
  totalSize: number;
};

export const toHex = (buffer: ArrayBuffer): string => {
  const view = new Uint8Array(buffer);
  let result = '';
  for (let i = 0; i < view.length; i += 1) {
    const value = view[i]?.toString(16).padStart(2, '0') ?? '00';
    result += value;
  }
  return result;
};

export const writeUint32 = (view: DataView, offset: number, value: number) => {
  view.setUint32(offset, value, false);
};

export const readUint32 = (view: DataView, offset: number): number => {
  return view.getUint32(offset, false);
};

export const computeMetadataHash = async (metaJson: string): Promise<string> => {
  const metaHashBuffer = await crypto.subtle.digest('SHA-256', textEncoder.encode(metaJson));
  return toHex(metaHashBuffer);
};

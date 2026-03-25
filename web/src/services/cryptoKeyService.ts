import { User } from '@supabase/supabase-js';
import { supabase } from '../lib/supabase';

const DB_NAME = 'pfm_trae_crypto';
const DB_VERSION = 1;
const STORE_NAME = 'user_keys';

type StoredKeyPair = {
  publicKey: CryptoKey;
  privateKey: CryptoKey;
};

export const isWebCryptoAvailable = () => {
  return typeof crypto !== 'undefined' && !!crypto.subtle && typeof indexedDB !== 'undefined';
};

export type DocumentEncryptionStatus = {
  isEncrypted: boolean;
  encryptionVersion: number | null;
};

export const getDocumentEncryptionStatus = (metadata: {
  encryption?: { enabled?: boolean; version?: number } | null;
} | null | undefined): DocumentEncryptionStatus => {
  const encryption = metadata?.encryption;
  if (!encryption?.enabled) {
    return { isEncrypted: false, encryptionVersion: null };
  }
  return {
    isEncrypted: true,
    encryptionVersion: typeof encryption.version === 'number' ? encryption.version : null,
  };
};

const openDb = (): Promise<IDBDatabase> => {
  return new Promise((resolve, reject) => {
    const request = indexedDB.open(DB_NAME, DB_VERSION);
    request.onupgradeneeded = () => {
      const db = request.result;
      if (!db.objectStoreNames.contains(STORE_NAME)) {
        db.createObjectStore(STORE_NAME);
      }
    };
    request.onsuccess = () => {
      resolve(request.result);
    };
    request.onerror = () => {
      reject(request.error);
    };
  });
};

const getStoredKeyPair = async (userId: string): Promise<StoredKeyPair | null> => {
  const db = await openDb();
  return new Promise((resolve, reject) => {
    const tx = db.transaction(STORE_NAME, 'readonly');
    const store = tx.objectStore(STORE_NAME);
    const request = store.get(userId);
    request.onsuccess = () => {
      resolve((request.result as StoredKeyPair | undefined) ?? null);
    };
    request.onerror = () => {
      reject(request.error);
    };
  });
};

const saveKeyPair = async (userId: string, keyPair: CryptoKeyPair): Promise<void> => {
  const db = await openDb();
  return new Promise((resolve, reject) => {
    const tx = db.transaction(STORE_NAME, 'readwrite');
    const store = tx.objectStore(STORE_NAME);
    const data: StoredKeyPair = {
      publicKey: keyPair.publicKey,
      privateKey: keyPair.privateKey,
    };
    const request = store.put(data, userId);
    request.onsuccess = () => {
      resolve();
    };
    request.onerror = () => {
      reject(request.error);
    };
  });
};

const upsertUserPublicKey = async (user: User, publicJwk: JsonWebKey): Promise<void> => {
  const { error } = await supabase.from('profiles').upsert(
    { id: user.id, public_key: publicJwk },
    { onConflict: 'id' },
  );
  if (error) {
    throw error;
  }
};

export const backupUserPrivateKey = async (user: User, privateKey: CryptoKey): Promise<void> => {
  if (!isWebCryptoAvailable()) return;
  try {
    const privateKeyJwk = await crypto.subtle.exportKey('jwk', privateKey);
    const { error } = await supabase.functions.invoke('key-backup', {
      body: { privateKeyJwk, keyVersion: 1 },
    });
    if (error) {
      // 静默失败，不阻断主流程
    }
  } catch {
    // 静默失败
  }
};

export const restoreUserPrivateKey = async (user: User): Promise<CryptoKey | null> => {
  if (!isWebCryptoAvailable()) return null;
  try {
    const { data, error } = await supabase.functions.invoke('key-restore', { body: {} });
    if (error || !data?.privateKeyJwk) return null;

    const jwk = data.privateKeyJwk as JsonWebKey;
    if (!jwk.kty || !jwk.alg) return null;

    const privateKey = await crypto.subtle.importKey(
      'jwk',
      jwk,
      { name: 'RSA-OAEP', hash: 'SHA-256' },
      false,
      ['decrypt'],
    );

    const publicJwk: JsonWebKey = { ...jwk };
    delete publicJwk.d;
    delete publicJwk.dp;
    delete publicJwk.dq;
    delete publicJwk.p;
    delete publicJwk.q;
    delete publicJwk.qi;

    const publicKey = await crypto.subtle.importKey(
      'jwk',
      publicJwk,
      { name: 'RSA-OAEP', hash: 'SHA-256' },
      true,
      ['encrypt'],
    );

    await saveKeyPair(user.id, { publicKey, privateKey } as CryptoKeyPair);
    return privateKey;
  } catch {
    return null;
  }
};

export const ensureUserKeyPair = async (user: User): Promise<void> => {
  if (!isWebCryptoAvailable()) {
    return;
  }

  try {
    let stored = await getStoredKeyPair(user.id);

    if (!stored) {
      // 优先从备份恢复
      await restoreUserPrivateKey(user);
      stored = await getStoredKeyPair(user.id);
    }

    if (!stored) {
      // 恢复失败，生成新密钥对
      const keyPair = (await crypto.subtle.generateKey(
        {
          name: 'RSA-OAEP',
          modulusLength: 2048,
          publicExponent: new Uint8Array([1, 0, 1]),
          hash: 'SHA-256',
        },
        true,
        ['encrypt', 'decrypt'],
      )) as CryptoKeyPair;

      await saveKeyPair(user.id, keyPair);
      stored = {
        publicKey: keyPair.publicKey,
        privateKey: keyPair.privateKey,
      };

      // 自动备份新生成的私钥
      await backupUserPrivateKey(user, keyPair.privateKey);
    }

    const publicJwk = await crypto.subtle.exportKey('jwk', stored.publicKey);
    await upsertUserPublicKey(user, publicJwk);
  } catch {
  }
};

export type UserKeyPair = StoredKeyPair;

export type DocumentKey = CryptoKey;

export type DocumentKeyStatus = 'missing' | 'active' | 'replaced';

export type DocumentKeyLifecycleEvent =
  | 'member_added'
  | 'member_removed'
  | 'role_downgraded'
  | 'suspect_compromise';

export type DocumentKeyRotationReason =
  | 'initial'
  | 'member_removed'
  | 'role_downgraded'
  | 'suspect_compromise';

export type DocumentKeyMetadata = {
  documentId: string;
  keyVersion: number;
  status: DocumentKeyStatus;
};

export type WrappedDocumentKeyPayload = {
  documentId: string;
  userId: string;
  keyVersion: number;
  wrappedKey: string;
};

export const getNextDocumentKeyVersion = (currentVersion: number | null): number => {
  if (!currentVersion || currentVersion < 1) {
    return 1;
  }
  return currentVersion + 1;
};

export const getDocumentKeyRotationDecision = (
  currentVersion: number | null,
  event: DocumentKeyLifecycleEvent | 'none',
) => {
  if (currentVersion === null) {
    return {
      shouldRotate: true,
      reason: 'initial' as DocumentKeyRotationReason,
      nextVersion: 1,
    };
  }

  if (event === 'member_removed') {
    return {
      shouldRotate: true,
      reason: 'member_removed' as DocumentKeyRotationReason,
      nextVersion: currentVersion + 1,
    };
  }

  if (event === 'role_downgraded') {
    return {
      shouldRotate: true,
      reason: 'role_downgraded' as DocumentKeyRotationReason,
      nextVersion: currentVersion + 1,
    };
  }

  if (event === 'suspect_compromise') {
    return {
      shouldRotate: true,
      reason: 'suspect_compromise' as DocumentKeyRotationReason,
      nextVersion: currentVersion + 1,
    };
  }

  return {
    shouldRotate: false,
    reason: null,
    nextVersion: currentVersion,
  };
};

export const generateDocumentKey = async (): Promise<DocumentKey> => {
  if (!isWebCryptoAvailable()) {
    throw new Error('WebCrypto is not available');
  }

  const key = await crypto.subtle.generateKey(
    {
      name: 'AES-GCM',
      length: 256,
    },
    true,
    ['encrypt', 'decrypt'],
  );

  return key;
};

export const wrapDocumentKey = async (
  documentKey: DocumentKey,
  userPublicKey: CryptoKey,
): Promise<string> => {
  if (!isWebCryptoAvailable()) {
    throw new Error('WebCrypto is not available');
  }

  const exportedKey = await crypto.subtle.exportKey('raw', documentKey);
  const wrappedKey = await crypto.subtle.encrypt(
    {
      name: 'RSA-OAEP',
    },
    userPublicKey,
    exportedKey,
  );

  const wrappedBytes = new Uint8Array(wrappedKey);
  let binary = '';
  for (let i = 0; i < wrappedBytes.length; i++) {
    binary += String.fromCharCode(wrappedBytes[i] ?? 0);
  }
  return btoa(binary);
};

export const unwrapDocumentKey = async (
  wrappedKeyBase64: string,
  userPrivateKey: CryptoKey,
): Promise<DocumentKey> => {
  if (!isWebCryptoAvailable()) {
    throw new Error('WebCrypto is not available');
  }

  const binary = atob(wrappedKeyBase64);
  const wrappedBytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i++) {
    wrappedBytes[i] = binary.charCodeAt(i);
  }

  const unwrappedKey = await crypto.subtle.decrypt(
    {
      name: 'RSA-OAEP',
    },
    userPrivateKey,
    wrappedBytes,
  );

  const documentKey = await crypto.subtle.importKey(
    'raw',
    unwrappedKey,
    {
      name: 'AES-GCM',
      length: 256,
    },
    true,
    ['encrypt', 'decrypt'],
  );

  return documentKey;
};

export const getUserKeyPair = async (userId: string): Promise<UserKeyPair | null> => {
  return getStoredKeyPair(userId);
};

/**
 * 查询目标用户的 RSA 公钥（从 profiles 表）。
 * 共享文档时用对方公钥封装 DocumentKey，确保只有对方私钥能解开。
 */
export const getTargetUserPublicKey = async (targetUserId: string): Promise<CryptoKey | null> => {
  const { data, error } = await supabase
    .from('profiles')
    .select('public_key')
    .eq('id', targetUserId)
    .single();

  if (error || !data?.public_key) {
    return null;
  }

  try {
    const jwk = data.public_key as JsonWebKey;
    const publicKey = await crypto.subtle.importKey(
      'jwk',
      jwk,
      { name: 'RSA-OAEP', hash: 'SHA-256' },
      true,
      ['encrypt'],
    );
    return publicKey;
  } catch {
    return null;
  }
};

/**
 * 将文档密钥分发给目标用户：
 * 用目标用户的公钥封装当前文档的 DocumentKey，写入 document_keys 表。
 * - 调用前需先通过 unwrapDocumentKey 拿到明文 DocumentKey（调用者自己的私钥解开）
 * - 适用场景：文档所有者共享文档给成员时调用
 */
export const distributeDocumentKey = async (
  documentId: string,
  documentKey: DocumentKey,
  targetUserId: string,
  keyVersion: number = 1,
): Promise<void> => {
  if (!isWebCryptoAvailable()) {
    throw new Error('WebCrypto is not available');
  }

  const targetPublicKey = await getTargetUserPublicKey(targetUserId);
  if (!targetPublicKey) {
    throw new Error(`无法获取用户 ${targetUserId} 的公钥，该用户可能未完成密钥初始化`);
  }

  const wrappedDocumentKey = await wrapDocumentKey(documentKey, targetPublicKey);

  const { error } = await supabase.from('document_keys').upsert(
    {
      document_id: documentId,
      user_id: targetUserId,
      wrapped_document_key: wrappedDocumentKey,
      key_version: keyVersion,
    },
    { onConflict: 'document_id,user_id,key_version' },
  );

  if (error) {
    throw error;
  }
};

/**
 * 撤销目标用户对文档的解密权限：
 * 从 document_keys 表删除目标用户的所有 wrapped_document_key 记录。
 * - 调用后目标用户无法再获取 wrapped key，配合 RLS 确保即时生效
 * - 注意：已下载到本地的密文无法追回，撤销只阻止后续获取密钥
 */
export const revokeDocumentKeyAccess = async (
  documentId: string,
  targetUserId: string,
): Promise<void> => {
  const { error } = await supabase
    .from('document_keys')
    .delete()
    .eq('document_id', documentId)
    .eq('user_id', targetUserId);

  if (error) {
    throw error;
  }
};

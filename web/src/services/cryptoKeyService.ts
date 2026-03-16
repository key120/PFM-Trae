import { User } from '@supabase/supabase-js';
import { supabase } from '../lib/supabase';

const DB_NAME = 'pfm_trae_crypto';
const DB_VERSION = 1;
const STORE_NAME = 'user_keys';

type StoredKeyPair = {
  publicKey: CryptoKey;
  privateKey: CryptoKey;
};

const isWebCryptoAvailable = () => {
  return typeof crypto !== 'undefined' && !!crypto.subtle && typeof indexedDB !== 'undefined';
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

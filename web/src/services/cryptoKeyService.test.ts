import { describe, expect, it, vi, beforeEach } from 'vitest';
import {
  getDocumentKeyRotationDecision,
  getNextDocumentKeyVersion,
  isWebCryptoAvailable,
  getDocumentEncryptionStatus,
} from './cryptoKeyService';

// vi.mock 必须在顶层（会被 hoisted）
vi.mock('../lib/supabase', () => ({
  supabase: {
    functions: {
      invoke: vi.fn(),
    },
    from: vi.fn(),
    auth: { getSession: vi.fn(), getUser: vi.fn() },
  },
}));

type IndexedDBGlobal = { indexedDB?: unknown };

function setIndexedDB(value: unknown) {
  Object.defineProperty(globalThis, 'indexedDB', {
    configurable: true,
    value,
  });
}

function mockCryptoExportKey() {
  return vi
    .spyOn(globalThis.crypto.subtle, 'exportKey')
    .mockResolvedValue({ kty: 'RSA' } as JsonWebKey);
}

function createIndexedDbRequestWithStoredKeyPair(publicKey: CryptoKey, privateKey: CryptoKey) {
  const dbRequest = {
    result: {
      transaction: () => ({
        objectStore: () => ({
          get: () => {
            const request: Record<string, any> = {};
            queueMicrotask(() => {
              request.result = {
                publicKey,
                privateKey,
              };
              request.onsuccess?.();
            });
            return request;
          },
        }),
      }),
    },
    onupgradeneeded: undefined,
    onsuccess: undefined,
    onerror: undefined,
  } as Record<string, any>;

  return dbRequest;
}

describe('DocumentKey 版本号与生命周期', () => {
  it('当前无版本时返回版本 1', () => {
    const next = getNextDocumentKeyVersion(null);
    expect(next).toBe(1);
  });

  it('已有版本时递增版本号', () => {
    const next = getNextDocumentKeyVersion(3);
    expect(next).toBe(4);
  });

  it('新增成员时默认不轮转密钥', () => {
    const decision = getDocumentKeyRotationDecision(1, 'member_added');
    expect(decision.shouldRotate).toBe(false);
    expect(decision.reason).toBeNull();
    expect(decision.nextVersion).toBe(1);
  });

  it('移除成员时触发密钥轮转并递增版本', () => {
    const decision = getDocumentKeyRotationDecision(2, 'member_removed');
    expect(decision.shouldRotate).toBe(true);
    expect(decision.reason).toBe('member_removed');
    expect(decision.nextVersion).toBe(3);
  });

  it('角色降级时触发密钥轮转并递增版本', () => {
    const decision = getDocumentKeyRotationDecision(5, 'role_downgraded');
    expect(decision.shouldRotate).toBe(true);
    expect(decision.reason).toBe('role_downgraded');
    expect(decision.nextVersion).toBe(6);
  });

  it('疑似泄露时触发密钥轮转并递增版本', () => {
    const decision = getDocumentKeyRotationDecision(7, 'suspect_compromise');
    expect(decision.shouldRotate).toBe(true);
    expect(decision.reason).toBe('suspect_compromise');
    expect(decision.nextVersion).toBe(8);
  });

  it('初次创建文档时总是生成版本 1 的 DocumentKey', () => {
    const decision = getDocumentKeyRotationDecision(null, 'none');
    expect(decision.shouldRotate).toBe(true);
    expect(decision.reason).toBe('initial');
    expect(decision.nextVersion).toBe(1);
  });
});

describe('backupUserPrivateKey', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('调用 key-backup 时携带调用方传入的 keyVersion', async () => {
    const { supabase } = await import('../lib/supabase');
    vi.mocked(supabase.functions.invoke).mockResolvedValue({
      data: { success: true },
      error: null,
    } as any);

    const originalIndexedDB = (globalThis as IndexedDBGlobal).indexedDB;
    setIndexedDB({});

    const exportKeySpy = mockCryptoExportKey();

    const { backupUserPrivateKey } = await import('./cryptoKeyService');
    const fakeKey = {} as CryptoKey;

    await backupUserPrivateKey(fakeKey, 7);

    expect(supabase.functions.invoke).toHaveBeenCalledWith('key-backup', {
      body: expect.objectContaining({ keyVersion: 7 }),
    });

    exportKeySpy.mockRestore();
    setIndexedDB(originalIndexedDB);
  });

});

describe('restoreUserPrivateKey', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('备份不存在时返回 null', async () => {
    const { supabase } = await import('../lib/supabase');
    vi.mocked(supabase.functions.invoke).mockResolvedValue({
      data: null,
      error: { status: 404, message: 'Backup not found' },
    } as any);

    const { restoreUserPrivateKey } = await import('./cryptoKeyService');
    const fakeUser = { id: 'user-123' } as any;

    const result = await restoreUserPrivateKey(fakeUser);
    expect(result).toBeNull();
  });

  it('网络错误时返回 null', async () => {
    const { supabase } = await import('../lib/supabase');
    vi.mocked(supabase.functions.invoke).mockRejectedValue(new Error('network error'));

    const { restoreUserPrivateKey } = await import('./cryptoKeyService');
    const fakeUser = { id: 'user-123' } as any;

    const result = await restoreUserPrivateKey(fakeUser);
    expect(result).toBeNull();
  });
});

describe('ensureUserKeyPair', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('会把用户邮箱一并写入 profiles，供邮箱邀请反查用户', async () => {
    const { supabase } = await import('../lib/supabase');
    const upsert = vi.fn().mockResolvedValue({ error: null });
    vi.mocked(supabase.from).mockReturnValue({ upsert } as any);

    const fakePublicKey = {} as CryptoKey;
    const fakePrivateKey = {} as CryptoKey;
    const dbRequest = createIndexedDbRequestWithStoredKeyPair(fakePublicKey, fakePrivateKey);

    const originalIndexedDB = globalThis.indexedDB;
    setIndexedDB({
      open: vi.fn(() => {
        queueMicrotask(() => {
          dbRequest.onsuccess?.();
        });
        return dbRequest;
      }),
    });

    const exportKeySpy = mockCryptoExportKey();

    const { ensureUserKeyPair } = await import('./cryptoKeyService');
    await ensureUserKeyPair({ id: 'user-1', email: 'invitee@example.com' } as any);

    expect(supabase.from).toHaveBeenCalledWith('profiles');
    expect(upsert).toHaveBeenCalledWith(
      {
        id: 'user-1',
        email: 'invitee@example.com',
        public_key: { kty: 'RSA' },
      },
      { onConflict: 'id' },
    );

    exportKeySpy.mockRestore();
    setIndexedDB(originalIndexedDB);
  });
});


describe('distributeDocumentKey', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('重复共享同一版本时使用 ignoreDuplicates 避免走 update RLS 路径', async () => {
    const { supabase } = await import('../lib/supabase');
    const originalIndexedDB = globalThis.indexedDB;
    setIndexedDB({});

    const profileSingle = vi.fn().mockResolvedValue({
      data: { public_key: { kty: 'RSA', e: 'AQAB', n: 'abc' } },
      error: null,
    });
    const keyUpsert = vi.fn().mockResolvedValue({ error: null });

    vi.mocked(supabase.from).mockImplementation((table: string) => {
      if (table === 'profiles') {
        return {
          select: vi.fn().mockReturnValue({
            eq: vi.fn().mockReturnValue({
              single: profileSingle,
            }),
          }),
        } as any;
      }
      if (table === 'document_keys') {
        return {
          upsert: keyUpsert,
        } as any;
      }
      return {} as any;
    });

    const importKeySpy = vi.spyOn(globalThis.crypto.subtle, 'importKey').mockResolvedValue({} as CryptoKey);
    const exportKeySpy = vi.spyOn(globalThis.crypto.subtle, 'exportKey').mockResolvedValue(new Uint8Array([1, 2, 3]).buffer);
    const encryptSpy = vi.spyOn(globalThis.crypto.subtle, 'encrypt').mockResolvedValue(new Uint8Array([4, 5, 6]).buffer);

    const { distributeDocumentKey } = await import('./cryptoKeyService');
    await distributeDocumentKey('doc-1', {} as CryptoKey, 'user-a', 1);

    expect(keyUpsert).toHaveBeenCalledWith(
      {
        document_id: 'doc-1',
        user_id: 'user-a',
        wrapped_document_key: expect.any(String),
        key_version: 1,
      },
      { onConflict: 'document_id,user_id,key_version', ignoreDuplicates: true },
    );

    importKeySpy.mockRestore();
    exportKeySpy.mockRestore();
    encryptSpy.mockRestore();
    setIndexedDB(originalIndexedDB);
  });
});


describe('getDocumentEncryptionStatus', () => {
  it('metadata 为 null 时返回未加密', () => {
    const status = getDocumentEncryptionStatus(null);
    expect(status.isEncrypted).toBe(false);
    expect(status.encryptionVersion).toBeNull();
  });

  it('encryption.enabled 为 false 时返回未加密', () => {
    const status = getDocumentEncryptionStatus({ encryption: { enabled: false, version: 1 } });
    expect(status.isEncrypted).toBe(false);
    expect(status.encryptionVersion).toBeNull();
  });

  it('encryption.enabled 为 true 时返回已加密及版本号', () => {
    const status = getDocumentEncryptionStatus({ encryption: { enabled: true, version: 2 } });
    expect(status.isEncrypted).toBe(true);
    expect(status.encryptionVersion).toBe(2);
  });

  it('encryption 字段缺失时返回未加密', () => {
    const status = getDocumentEncryptionStatus({});
    expect(status.isEncrypted).toBe(false);
    expect(status.encryptionVersion).toBeNull();
  });

  it('encryption.version 非数字时 encryptionVersion 为 null', () => {
    const status = getDocumentEncryptionStatus({ encryption: { enabled: true } });
    expect(status.isEncrypted).toBe(true);
    expect(status.encryptionVersion).toBeNull();
  });
});

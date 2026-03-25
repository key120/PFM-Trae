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
    auth: { getSession: vi.fn() },
  },
}));

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

  it('调用失败时静默返回不抛出异常', async () => {
    const { supabase } = await import('../lib/supabase');
    vi.mocked(supabase.functions.invoke).mockResolvedValue({
      data: null,
      error: new Error('network error'),
    } as any);

    const { backupUserPrivateKey } = await import('./cryptoKeyService');
    const fakeUser = { id: 'user-123' } as any;
    const fakeKey = {} as CryptoKey;

    await expect(backupUserPrivateKey(fakeUser, fakeKey)).resolves.toBeUndefined();
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

describe('isWebCryptoAvailable', () => {
  it('返回布尔值，反映当前环境的 WebCrypto 与 IndexedDB 支持情况', () => {
    const result = isWebCryptoAvailable();
    expect(typeof result).toBe('boolean');
    // encryptionService.test.ts 中的加解密测试依赖 WebCrypto，说明 crypto.subtle 存在
    // isWebCryptoAvailable 要求同时满足 WebCrypto + IndexedDB，后者在 jsdom 中不可用
    const expectedValue =
      typeof crypto !== 'undefined' &&
      !!crypto.subtle &&
      typeof indexedDB !== 'undefined';
    expect(result).toBe(expectedValue);
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

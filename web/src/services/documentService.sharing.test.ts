import { describe, expect, it, vi, beforeEach } from 'vitest';
import { shareDocument, unshareDocument, isDocumentSharedInTeam } from './documentService';
import { supabase } from '../lib/supabase';
import * as cryptoKeyService from './cryptoKeyService';

type MockFn = ReturnType<typeof vi.fn>;

vi.mock('./cryptoKeyService', () => ({
  isWebCryptoAvailable: vi.fn(() => true),
  getUserKeyPair: vi.fn(async () => ({
    publicKey: { type: 'public' },
    privateKey: { type: 'private' },
  })),
  unwrapDocumentKey: vi.fn(async () => ({ type: 'secret', algorithm: { name: 'AES-GCM' } })),
  distributeDocumentKey: vi.fn(async () => undefined),
  revokeDocumentKeyAccess: vi.fn(async () => undefined),
  // 其他导出保持 undefined（不被调用）
  generateDocumentKey: vi.fn(),
  wrapDocumentKey: vi.fn(),
  getDocumentEncryptionStatus: vi.fn(),
  getTargetUserPublicKey: vi.fn(),
}));

// encryptionService 不会被 shareDocument 调用，提供空 mock 即可
vi.mock('./encryptionService', () => ({
  encryptDocumentChunked: vi.fn(),
  decryptDocumentChunked: vi.fn(),
}));

vi.mock('../utils/idGenerator', () => ({
  generateDocumentId: vi.fn(() => 'mock-doc-id'),
  generateVersionId: vi.fn(() => 'mock-ver-id'),
}));

vi.mock('../lib/supabase', () => ({
  supabase: {
    storage: { from: vi.fn() },
    from: vi.fn(),
    functions: { invoke: vi.fn() },
    auth: { getSession: vi.fn(async () => ({ data: { session: { user: { id: 'owner-id' }, expires_at: 9999999999 } } })) },
  },
}));

const resetMocks = () => {
  (supabase.from as unknown as MockFn).mockReset();
  (supabase.functions.invoke as unknown as MockFn).mockReset();
  (supabase.auth.getSession as unknown as MockFn).mockReset();
  (supabase.auth.getSession as unknown as MockFn).mockResolvedValue({ data: { session: { user: { id: 'owner-id' }, expires_at: 9999999999 } } });
  vi.mocked(cryptoKeyService.isWebCryptoAvailable).mockImplementation(() => true);
  vi.mocked(cryptoKeyService.getUserKeyPair).mockImplementation(async () => ({
    publicKey: { type: 'public' } as unknown as CryptoKey,
    privateKey: { type: 'private' } as unknown as CryptoKey,
  }));
  vi.mocked(cryptoKeyService.unwrapDocumentKey).mockImplementation(
    async () => ({ type: 'secret' } as unknown as CryptoKey),
  );
  vi.mocked(cryptoKeyService.distributeDocumentKey).mockImplementation(async () => undefined);
  vi.mocked(cryptoKeyService.revokeDocumentKeyAccess).mockImplementation(async () => undefined);
};

describe('shareDocument', () => {
  beforeEach(resetMocks);

  it('成功共享：为所有目标用户分发密钥，返回 distributed 列表', async () => {
    const fromMock = supabase.from as unknown as MockFn;

    // Mock document_keys（owner 的 wrapped_document_key）
    fromMock.mockImplementation((table: string) => {
      if (table === 'document_keys') {
        return {
          select: vi.fn().mockReturnValue({
            eq: vi.fn().mockReturnValue({
              eq: vi.fn().mockReturnValue({
                order: vi.fn().mockReturnValue({
                  limit: vi.fn().mockReturnValue({
                    single: vi.fn().mockResolvedValue({
                      data: { wrapped_document_key: 'owner-wrapped-key', key_version: 1 },
                      error: null,
                    }),
                  }),
                }),
              }),
            }),
          }),
        };
      }
      return {};
    });

    const result = await shareDocument({
      documentId: 'doc-1',
      ownerUserId: 'owner-uid',
      targetUserIds: ['user-a', 'user-b'],
    });

    expect(result.distributed).toEqual(['user-a', 'user-b']);
    expect(result.failed).toHaveLength(0);

    // 验证解封 owner 密钥被调用
    expect(vi.mocked(cryptoKeyService.unwrapDocumentKey)).toHaveBeenCalledWith(
      'owner-wrapped-key',
      expect.anything(),
    );

    // 验证为每个目标用户调用了 distributeDocumentKey
    expect(vi.mocked(cryptoKeyService.distributeDocumentKey)).toHaveBeenCalledTimes(2);
    expect(vi.mocked(cryptoKeyService.distributeDocumentKey)).toHaveBeenCalledWith(
      'doc-1', expect.anything(), 'user-a', 1,
    );
    expect(vi.mocked(cryptoKeyService.distributeDocumentKey)).toHaveBeenCalledWith(
      'doc-1', expect.anything(), 'user-b', 1,
    );
  });

  it('部分失败：一个用户公钥不存在，其余成功', async () => {
    const fromMock = supabase.from as unknown as MockFn;

    fromMock.mockImplementation((table: string) => {
      if (table === 'document_keys') {
        return {
          select: vi.fn().mockReturnValue({
            eq: vi.fn().mockReturnValue({
              eq: vi.fn().mockReturnValue({
                order: vi.fn().mockReturnValue({
                  limit: vi.fn().mockReturnValue({
                    single: vi.fn().mockResolvedValue({
                      data: { wrapped_document_key: 'owner-wrapped-key', key_version: 1 },
                      error: null,
                    }),
                  }),
                }),
              }),
            }),
          }),
        };
      }
      return {};
    });

    // user-b 的 distributeDocumentKey 失败
    vi.mocked(cryptoKeyService.distributeDocumentKey).mockImplementation(
      async (_docId, _key, userId) => {
        if (userId === 'user-b') throw new Error('无法获取用户公钥');
      },
    );

    const result = await shareDocument({
      documentId: 'doc-1',
      ownerUserId: 'owner-uid',
      targetUserIds: ['user-a', 'user-b'],
    });

    expect(result.distributed).toEqual(['user-a']);
    expect(result.failed).toHaveLength(1);
    expect(result.failed[0]).toMatchObject({ userId: 'user-b', reason: '无法获取用户公钥' });
  });

  it('owner 无 document_keys 记录时抛出错误', async () => {
    const fromMock = supabase.from as unknown as MockFn;

    fromMock.mockImplementation((table: string) => {
      if (table === 'document_keys') {
        return {
          select: vi.fn().mockReturnValue({
            eq: vi.fn().mockReturnValue({
              eq: vi.fn().mockReturnValue({
                order: vi.fn().mockReturnValue({
                  limit: vi.fn().mockReturnValue({
                    single: vi.fn().mockResolvedValue({ data: null, error: new Error('no key') }),
                  }),
                }),
              }),
            }),
          }),
        };
      }
      return {};
    });

    await expect(
      shareDocument({ documentId: 'doc-1', ownerUserId: 'owner-uid', targetUserIds: ['user-a'] }),
    ).rejects.toThrow('文档密钥');
  });

  it('WebCrypto 不可用时抛出错误', async () => {
    vi.mocked(cryptoKeyService.isWebCryptoAvailable).mockImplementation(() => false);

    await expect(
      shareDocument({ documentId: 'doc-1', ownerUserId: 'owner-uid', targetUserIds: ['user-a'] }),
    ).rejects.toThrow('Web Crypto API');
  });
});



describe('isDocumentSharedInTeam', () => {
  beforeEach(resetMocks);

  it('查询当前团队共享状态：存在记录时返回 true', async () => {
    const fromMock = supabase.from as unknown as MockFn;

    fromMock.mockImplementation((table: string) => {
      if (table === 'document_shares') {
        return {
          select: vi.fn().mockReturnValue({
            eq: vi.fn().mockReturnValue({
              eq: vi.fn().mockReturnValue({
                limit: vi.fn().mockReturnValue({
                  maybeSingle: vi.fn().mockResolvedValue({ data: { id: 'share-1' }, error: null }),
                }),
              }),
            }),
          }),
        };
      }
      return {};
    });

    const result = await isDocumentSharedInTeam('doc-1', 'team-1');
    expect(result).toBe(true);
  });

  it('查询当前团队共享状态：无记录时返回 false', async () => {
    const fromMock = supabase.from as unknown as MockFn;

    fromMock.mockImplementation((table: string) => {
      if (table === 'document_shares') {
        return {
          select: vi.fn().mockReturnValue({
            eq: vi.fn().mockReturnValue({
              eq: vi.fn().mockReturnValue({
                limit: vi.fn().mockReturnValue({
                  maybeSingle: vi.fn().mockResolvedValue({ data: null, error: null }),
                }),
              }),
            }),
          }),
        };
      }
      return {};
    });

    const result = await isDocumentSharedInTeam('doc-1', 'team-1');
    expect(result).toBe(false);
  });

  it('查询当前团队共享状态：数据库错误时抛出异常', async () => {
    const fromMock = supabase.from as unknown as MockFn;

    fromMock.mockImplementation((table: string) => {
      if (table === 'document_shares') {
        return {
          select: vi.fn().mockReturnValue({
            eq: vi.fn().mockReturnValue({
              eq: vi.fn().mockReturnValue({
                limit: vi.fn().mockReturnValue({
                  maybeSingle: vi.fn().mockResolvedValue({ data: null, error: new Error('db down') }),
                }),
              }),
            }),
          }),
        };
      }
      return {};
    });

    await expect(isDocumentSharedInTeam('doc-1', 'team-1')).rejects.toThrow('db down');
  });
});

describe('unshareDocument', () => {
  beforeEach(resetMocks);

  it('撤销多个用户的访问权，每人调用一次 revokeDocumentKeyAccess', async () => {
    await unshareDocument('doc-1', ['user-a', 'user-b']);

    expect(vi.mocked(cryptoKeyService.revokeDocumentKeyAccess)).toHaveBeenCalledTimes(2);
    expect(vi.mocked(cryptoKeyService.revokeDocumentKeyAccess)).toHaveBeenCalledWith('doc-1', 'user-a');
    expect(vi.mocked(cryptoKeyService.revokeDocumentKeyAccess)).toHaveBeenCalledWith('doc-1', 'user-b');
  });

  it('传入 teamId 时同时删除 document_shares 记录', async () => {
    const fromMock = supabase.from as unknown as MockFn;
    const deleteEq2 = vi.fn().mockResolvedValue({ error: null });
    const deleteEq1 = vi.fn(() => ({ eq: deleteEq2 }));
    const del = vi.fn(() => ({ eq: deleteEq1 }));

    fromMock.mockImplementation((table: string) => {
      if (table === 'document_shares') return { delete: del };
      return {};
    });

    await unshareDocument('doc-1', ['user-a'], 'team-xyz');

    expect(fromMock).toHaveBeenCalledWith('document_shares');
    const eq1Calls = deleteEq1.mock.calls as [string, string][];
    expect(eq1Calls[0]).toEqual(['document_id', 'doc-1']);
    const eq2Calls = deleteEq2.mock.calls as [string, string][];
    expect(eq2Calls[0]).toEqual(['team_id', 'team-xyz']);
  });

  it('不传 teamId 时不操作 document_shares 表', async () => {
    const fromMock = supabase.from as unknown as MockFn;
    fromMock.mockReturnValue({});

    await unshareDocument('doc-1', ['user-a']);

    // document_shares 不应被调用
    const calls = (fromMock.mock.calls as [string][]).map(([t]) => t);
    expect(calls).not.toContain('document_shares');
  });
});

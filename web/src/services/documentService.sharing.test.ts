import { describe, expect, it, vi, beforeEach, afterEach } from 'vitest';
import {
  shareDocument,
  unshareDocument,
  isDocumentSharedInTeam,
  fetchPersonalDocumentsForCurrentTeam,
  fetchSharedDocumentsForCurrentTeam,
  assertSharedVersionLabelAvailable,
  saveSharedDocumentVersion,
} from './documentService';
import { supabase } from '../lib/supabase';
import * as cryptoKeyService from './cryptoKeyService';
import * as encryptionService from './encryptionService';
import * as documentEncryptionWorker from './documentEncryptionWorker';

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
  generateDocumentKey: vi.fn(async () => ({ type: 'secret', algorithm: { name: 'AES-GCM' } })),
  wrapDocumentKey: vi.fn(async () => 'editor-wrapped-key'),
  backupUserPrivateKey: vi.fn(async () => true),
  restoreUserPrivateKey: vi.fn(async () => ({ type: 'private' })),
  ensureUserKeyPair: vi.fn(async () => undefined),
  getDocumentEncryptionStatus: vi.fn(),
  getTargetUserPublicKey: vi.fn(),
}));

vi.mock('./encryptionService', () => ({
  encryptDocumentChunked: vi.fn(async () => ({
    blob: new Blob(['encrypted'], { type: 'application/octet-stream' }),
    contentHash: 'shared-hash',
  })),
  decryptDocumentChunked: vi.fn(),
}));

vi.mock('./documentEncryptionWorker', () => ({
  encryptDocumentChunkedViaWorker: vi.fn(async () => ({
    blob: new Blob(['encrypted'], { type: 'application/octet-stream' }),
    contentHash: 'shared-hash',
  })),
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
  vi.mocked(encryptionService.encryptDocumentChunked).mockImplementation(async () => ({
    blob: new Blob(['encrypted'], { type: 'application/octet-stream' }),
    contentHash: 'shared-hash',
  }));
  vi.mocked(encryptionService.decryptDocumentChunked).mockImplementation(async () => ({
    file: new File(['decrypted-content'], 'shared.docx', {
      type: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
    }),
    meta: { title: 'shared.docx', selectedKeys: ['k1', 'k2'] },
  }));
  vi.mocked(documentEncryptionWorker.encryptDocumentChunkedViaWorker).mockImplementation(async () => ({
    blob: new Blob(['encrypted'], { type: 'application/octet-stream' }),
    contentHash: 'shared-hash',
  }));
};

const createDeferred = <T,>() => {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((res) => {
    resolve = res;
  });
  return { promise, resolve };
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

    const calls = (fromMock.mock.calls as [string][]).map(([t]) => t);
    expect(calls).not.toContain('document_shares');
  });
});

describe('current-team document list queries', () => {
  it('loadSharedDocument 会并行发起 documents 与最新 version 查询', async () => {
    const fromMock = supabase.from as unknown as MockFn;
    const invokeMock = supabase.functions.invoke as unknown as MockFn;
    const { loadSharedDocument } = await import('./documentService');
    const documentDeferred = createDeferred<{ data: { path: string; metadata: { latestVersion: string; latestRemark: string } }; error: null }>();
    const versionDeferred = createDeferred<{ data: { id: string; r2_key: string; content_hash: string; encrypted_meta: { title: string; selectedKeys: string[] }; version_label: string; note: string; key_version: number }; error: null }>();

    let documentQueryStarted = false;
    let versionQueryStarted = false;

    fromMock.mockImplementation((table: string) => {
      if (table === 'documents') {
        return {
          select: vi.fn().mockReturnValue({
            eq: vi.fn().mockReturnValue({
              single: vi.fn().mockImplementation(() => {
                documentQueryStarted = true;
                return documentDeferred.promise;
              }),
            }),
          }),
        };
      }

      if (table === 'document_versions') {
        return {
          select: vi.fn().mockReturnValue({
            eq: vi.fn().mockReturnValue({
              order: vi.fn().mockReturnValue({
                limit: vi.fn().mockReturnValue({
                  single: vi.fn().mockImplementation(() => {
                    versionQueryStarted = true;
                    return versionDeferred.promise;
                  }),
                }),
              }),
            }),
          }),
        };
      }

      if (table === 'document_keys') {
        return {
          select: vi.fn().mockReturnValue({
            eq: vi.fn().mockReturnValue({
              eq: vi.fn().mockReturnValue({
                eq: vi.fn().mockReturnValue({
                  limit: vi.fn().mockResolvedValue({
                    data: [{ wrapped_document_key: 'wrapped-key-base64', key_version: 9 }],
                    error: null,
                  }),
                }),
              }),
            }),
          }),
        };
      }

      return {};
    });

    invokeMock.mockResolvedValue({
      data: { url: 'https://r2.example.com/get-url', method: 'GET', headers: {}, expiresAt: new Date(Date.now() + 300000).toISOString(), r2Key: 'hash.bin' },
      error: null,
    });

    global.fetch = vi.fn().mockResolvedValue({
      ok: true,
      status: 200,
      blob: async () => new Blob(['encrypted-content'], { type: 'application/octet-stream' }),
    } as unknown as Response);

    const loadPromise = loadSharedDocument('user-1', 'doc-shared');
    await Promise.resolve();

    expect(documentQueryStarted).toBe(true);
    expect(versionQueryStarted).toBe(true);

    documentDeferred.resolve({
      data: {
        path: 'pfm-trae/dev/documents/doc-shared/ver-001/hash.bin',
        metadata: { latestVersion: 'V1.0.0', latestRemark: '共享版本' },
      },
      error: null,
    });
    versionDeferred.resolve({
      data: {
        id: 'ver-uuid-001',
        r2_key: 'hash.bin',
        content_hash: 'abc123',
        encrypted_meta: { title: 'shared.docx', selectedKeys: ['k1', 'k2'] },
        version_label: 'V1.0.0',
        note: '共享版本',
        key_version: 9,
      },
      error: null,
    });

    const result = await loadPromise;

    expect(invokeMock).toHaveBeenCalledWith('r2-sign-download', expect.objectContaining({
      body: expect.objectContaining({ documentId: 'doc-shared', versionId: 'ver-uuid-001' }),
    }));
    expect(vi.mocked(cryptoKeyService.unwrapDocumentKey)).toHaveBeenCalled();
    expect(vi.mocked(encryptionService.decryptDocumentChunked)).toHaveBeenCalled();
    expect(result.file).toBeInstanceOf(File);
    expect(result.version).toBe('V1.0.0');
    expect(result.remark).toBe('共享版本');
    expect(result.selectedKeys).toEqual(['k1', 'k2']);
  });

  it('Worker 适配层完全失败时，共享保存会正确传播异常（回退由适配层内部处理）', async () => {
    // Arrange: Worker adapter 完全失败（Worker + 主线程回退都失败）
    vi.mocked(documentEncryptionWorker.encryptDocumentChunkedViaWorker).mockRejectedValue(
      new Error('Worker unavailable'),
    );

    const fromMock = supabase.from as unknown as MockFn;
    const invokeMock = supabase.functions.invoke as unknown as MockFn;

    invokeMock.mockResolvedValue({
      data: {
        url: 'https://r2.example.com/shared-put',
        method: 'PUT',
        headers: { 'Content-Type': 'application/octet-stream' },
        expiresAt: new Date(Date.now() + 300000).toISOString(),
        r2Key: 'pfm-trae/dev/documents/doc-1/new-ver-uuid/hash.bin',
      },
      error: null,
    });

    global.fetch = vi.fn().mockResolvedValue({ ok: true, status: 200 } as Response);
    vi.mocked(cryptoKeyService.generateDocumentKey).mockResolvedValue({ type: 'secret' } as unknown as CryptoKey);
    vi.mocked(cryptoKeyService.wrapDocumentKey).mockResolvedValue('editor-wrapped-key');
    vi.mocked(cryptoKeyService.distributeDocumentKey).mockResolvedValue(undefined);

    const documentSingle = vi.fn().mockResolvedValue({
      data: {
        id: 'doc-1',
        owner_id: 'owner-1',
        encrypted_title: '共享文档',
        metadata: {
          latestVersion: 'V1.0.0',
          latestRemark: 'old',
          versions: [{ version: 'V1.0.0', remark: 'old', author: 'owner@example.com', createdAt: '2026-05-01T00:00:00Z', sizeBytes: 100 }],
          selectedKeys: ['k1'],
          encryption: { enabled: true, version: 2 },
        },
      },
      error: null,
    });

    const updateEq = vi.fn().mockResolvedValue({ error: null });
    const update = vi.fn().mockReturnValue({ eq: updateEq });
    const insertVersion = vi.fn().mockResolvedValue({ error: null });
    const insertKeys = vi.fn().mockResolvedValue({ error: null });

    fromMock.mockImplementation((table: string) => {
      if (table === 'documents') {
        return {
          select: vi.fn().mockReturnValue({
            eq: vi.fn().mockReturnValue({ single: documentSingle }),
          }),
          update,
        };
      }

      if (table === 'document_shares') {
        return {
          select: vi.fn().mockReturnValue({
            eq: vi.fn().mockReturnValue({
              eq: vi.fn().mockReturnValue({
                limit: vi.fn().mockResolvedValue({
                  data: [{ document_id: 'doc-1' }],
                  error: null,
                }),
              }),
            }),
          }),
        };
      }

      if (table === 'document_versions') {
        return {
          select: vi.fn().mockReturnValue({
            eq: vi.fn().mockReturnValue({
              order: vi.fn().mockResolvedValue({
                data: [{ version_label: 'V1.0.0' }],
                error: null,
              }),
            }),
          }),
          insert: insertVersion,
        };
      }

      if (table === 'document_keys') {
        return {
          select: vi.fn().mockImplementation((columns: string) => {
            if (columns === 'wrapped_document_key, key_version') {
              return {
                eq: vi.fn().mockReturnValue({
                  eq: vi.fn().mockReturnValue({
                    order: vi.fn().mockReturnValue({
                      limit: vi.fn().mockResolvedValue({
                        data: [{ wrapped_document_key: 'editor-current-key', key_version: 3 }],
                        error: null,
                      }),
                    }),
                  }),
                }),
              };
            }
            if (columns === 'user_id') {
              return {
                eq: vi.fn().mockResolvedValue({
                  data: [{ user_id: 'owner-1' }, { user_id: 'member-1' }, { user_id: 'member-2' }],
                  error: null,
                }),
              };
            }
            return { eq: vi.fn() };
          }),
          insert: insertKeys,
        };
      }

      return {};
    });

    const blob = new Blob(['shared-doc'], { type: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document' });

    // Act & Assert: 适配层抛错时，共享保存应传播异常
    await expect(
      saveSharedDocumentVersion({
        documentId: 'doc-1',
        editorUserId: 'member-1',
        editorEmail: 'member-1@example.com',
        teamId: 'team-1',
        blob,
        fileName: 'shared.docx',
        version: 'V1.1.0',
        remark: 'member update',
        selectedKeys: ['k2'],
      }),
    ).rejects.toThrow('Worker unavailable');
  });

  beforeEach(() => {
    resetMocks();
    vi.spyOn(console, 'info').mockImplementation(() => undefined);
    vi.spyOn(console, 'error').mockImplementation(() => undefined);
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('fetchPersonalDocumentsForCurrentTeam excludes docs shared in the current team', async () => {
    const fromMock = supabase.from as unknown as MockFn;

    fromMock.mockImplementation((table: string) => {
      if (table === 'documents') {
        return {
          select: vi.fn().mockReturnValue({
            eq: vi.fn().mockReturnValue({
              order: vi.fn().mockResolvedValue({
                data: [
                  {
                    id: 'doc-personal',
                    encrypted_title: '个人文档',
                    size: 1,
                    path: 'r2://a',
                    created_at: '2026-05-01T00:00:00Z',
                    updated_at: '2026-05-01T00:00:00Z',
                    metadata: { encryption: { enabled: true, version: 2 } },
                  },
                  {
                    id: 'doc-shared',
                    encrypted_title: '共享出去的文档',
                    size: 1,
                    path: 'r2://b',
                    created_at: '2026-05-01T00:00:00Z',
                    updated_at: '2026-05-02T00:00:00Z',
                    metadata: { encryption: { enabled: true, version: 2 } },
                  },
                ],
                error: null,
              }),
            }),
          }),
        };
      }

      if (table === 'document_shares') {
        return {
          select: vi.fn().mockReturnValue({
            eq: vi.fn().mockReturnValue({
              in: vi.fn().mockResolvedValue({
                data: [{ document_id: 'doc-shared' }],
                error: null,
              }),
            }),
          }),
        };
      }

      return {};
    });

    const result = await fetchPersonalDocumentsForCurrentTeam('user-1', 'team-1');
    expect(result.map((doc) => doc.id)).toEqual(['doc-personal']);
  });

  it('fetchSharedDocumentsForCurrentTeam returns owner-shared and member-shared cards together', async () => {
    const fromMock = supabase.from as unknown as MockFn;

    fromMock.mockImplementation((table: string) => {
      if (table === 'document_shares') {
        return {
          select: vi.fn().mockReturnValue({
            eq: vi.fn().mockResolvedValue({
              data: [
                { document_id: 'doc-owner', shared_by: 'user-1', created_at: '2026-05-03T00:00:00Z' },
                { document_id: 'doc-member', shared_by: 'owner-2', created_at: '2026-05-04T00:00:00Z' },
              ],
              error: null,
            }),
          }),
        };
      }

      if (table === 'documents') {
        return {
          select: vi.fn().mockReturnValue({
            in: vi.fn().mockResolvedValue({
              data: [
                {
                  id: 'doc-owner',
                  owner_id: 'user-1',
                  encrypted_title: '我共享的文档',
                  size: 100,
                  metadata: {
                    latestVersion: 'V2.0.0',
                    latestRemark: 'owner update',
                    versions: [{ version: 'V2.0.0', remark: 'owner update', author: 'tester@example.com', createdAt: '2026-05-03T00:00:00Z', sizeBytes: 100 }],
                  },
                },
                {
                  id: 'doc-member',
                  owner_id: 'owner-2',
                  encrypted_title: '别人共享给我的文档',
                  size: 200,
                  metadata: {
                    latestVersion: 'V3.0.0',
                    latestRemark: 'member update',
                    versions: [{ version: 'V3.0.0', remark: 'member update', author: 'owner-2@example.com', createdAt: '2026-05-04T00:00:00Z', sizeBytes: 200 }],
                  },
                },
              ],
              error: null,
            }),
          }),
        };
      }

      if (table === 'document_keys') {
        return {
          select: vi.fn().mockReturnValue({
            eq: vi.fn().mockReturnValue({
              eq: vi.fn().mockReturnValue({
                limit: vi.fn().mockResolvedValue({
                  data: [{ document_id: 'doc-member' }],
                  error: null,
                }),
              }),
            }),
          }),
        };
      }

      if (table === 'profiles') {
        return {
          select: vi.fn().mockReturnValue({
            in: vi.fn().mockResolvedValue({
              data: [{ id: 'owner-2', email: 'owner-2@example.com' }, { id: 'user-1', email: 'tester@example.com' }],
              error: null,
            }),
          }),
        };
      }

      return {};
    });

    const result = await fetchSharedDocumentsForCurrentTeam('user-1', 'team-1');
    expect(result).toHaveLength(2);
    expect(result.find((doc) => doc.id === 'doc-owner')?.isOwner).toBe(true);
    expect(result.find((doc) => doc.id === 'doc-member')?.isOwner).toBe(false);
  });

  it('assertSharedVersionLabelAvailable rejects duplicate labels in the full document history', async () => {
    const fromMock = supabase.from as unknown as MockFn;

    fromMock.mockImplementation((table: string) => {
      if (table === 'document_versions') {
        return {
          select: vi.fn().mockReturnValue({
            eq: vi.fn().mockReturnValue({
              order: vi.fn().mockResolvedValue({
                data: [{ version_label: 'V1.0.0' }, { version_label: 'V1.1.0' }],
                error: null,
              }),
            }),
          }),
        };
      }
      return {};
    });

    await expect(assertSharedVersionLabelAvailable('doc-1', 'V1.1.0')).rejects.toThrow('版本号已存在');
  });

  it('saveSharedDocumentVersion appends a new version and refreshes metadata for all shared members', async () => {
    const fromMock = supabase.from as unknown as MockFn;
    const invokeMock = supabase.functions.invoke as unknown as MockFn;

    invokeMock.mockResolvedValue({
      data: {
        url: 'https://r2.example.com/shared-put',
        method: 'PUT',
        headers: { 'Content-Type': 'application/octet-stream' },
        expiresAt: new Date(Date.now() + 300000).toISOString(),
        r2Key: 'pfm-trae/dev/documents/doc-1/new-ver-uuid/hash.bin',
      },
      error: null,
    });

    global.fetch = vi.fn().mockResolvedValue({ ok: true, status: 200 } as Response);
    vi.mocked(cryptoKeyService.generateDocumentKey).mockResolvedValue({ type: 'secret' } as unknown as CryptoKey);
    vi.mocked(cryptoKeyService.wrapDocumentKey).mockResolvedValue('editor-wrapped-key');
    vi.mocked(cryptoKeyService.distributeDocumentKey).mockResolvedValue(undefined);

    const documentSingle = vi.fn().mockResolvedValue({
      data: {
        id: 'doc-1',
        owner_id: 'owner-1',
        encrypted_title: '共享文档',
        metadata: {
          latestVersion: 'V1.0.0',
          latestRemark: 'old',
          versions: [{ version: 'V1.0.0', remark: 'old', author: 'owner@example.com', createdAt: '2026-05-01T00:00:00Z', sizeBytes: 100 }],
          selectedKeys: ['k1'],
          encryption: { enabled: true, version: 2 },
        },
      },
      error: null,
    });

    const updateEq = vi.fn().mockResolvedValue({ error: null });
    const update = vi.fn().mockReturnValue({ eq: updateEq });
    const insertVersion = vi.fn().mockResolvedValue({ error: null });
    const insertKeys = vi.fn().mockResolvedValue({ error: null });

    fromMock.mockImplementation((table: string) => {
      if (table === 'documents') {
        return {
          select: vi.fn().mockReturnValue({
            eq: vi.fn().mockReturnValue({ single: documentSingle }),
          }),
          update,
        };
      }

      if (table === 'document_shares') {
        return {
          select: vi.fn().mockReturnValue({
            eq: vi.fn().mockReturnValue({
              eq: vi.fn().mockReturnValue({
                limit: vi.fn().mockResolvedValue({
                  data: [{ document_id: 'doc-1' }],
                  error: null,
                }),
              }),
            }),
          }),
        };
      }

      if (table === 'document_versions') {
        return {
          select: vi.fn().mockReturnValue({
            eq: vi.fn().mockReturnValue({
              order: vi.fn().mockResolvedValue({
                data: [{ version_label: 'V1.0.0' }],
                error: null,
              }),
            }),
          }),
          insert: insertVersion,
        };
      }

      if (table === 'document_keys') {
        return {
          select: vi.fn().mockImplementation((columns: string) => {
            if (columns === 'wrapped_document_key, key_version') {
              return {
                eq: vi.fn().mockReturnValue({
                  eq: vi.fn().mockReturnValue({
                    order: vi.fn().mockReturnValue({
                      limit: vi.fn().mockResolvedValue({
                        data: [{ wrapped_document_key: 'editor-current-key', key_version: 3 }],
                        error: null,
                      }),
                    }),
                  }),
                }),
              };
            }
            if (columns === 'user_id') {
              return {
                eq: vi.fn().mockResolvedValue({
                  data: [{ user_id: 'owner-1' }, { user_id: 'member-1' }, { user_id: 'member-2' }],
                  error: null,
                }),
              };
            }
            return { eq: vi.fn() };
          }),
          insert: insertKeys,
        };
      }

      return {};
    });

    const blob = new Blob(['shared-doc'], { type: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document' });

    const result = await saveSharedDocumentVersion({
      documentId: 'doc-1',
      editorUserId: 'member-1',
      editorEmail: 'member-1@example.com',
      teamId: 'team-1',
      blob,
      fileName: 'shared.docx',
      version: 'V1.1.0',
      remark: 'member update',
      selectedKeys: ['k2'],
    });

    expect(result.documentId).toBe('doc-1');
    expect(insertVersion).toHaveBeenCalledTimes(1);
    expect(update).toHaveBeenCalledTimes(1);
    expect(vi.mocked(cryptoKeyService.distributeDocumentKey)).toHaveBeenCalledWith('doc-1', expect.anything(), 'owner-1', 4);
    expect(vi.mocked(cryptoKeyService.distributeDocumentKey)).toHaveBeenCalledWith('doc-1', expect.anything(), 'member-2', 4);
  });

  it('输出共享保存 telemetry 阶段日志并包含分发成员数', async () => {
    const fromMock = supabase.from as unknown as MockFn;
    const invokeMock = supabase.functions.invoke as unknown as MockFn;

    invokeMock.mockResolvedValue({
      data: {
        url: 'https://r2.example.com/shared-put',
        method: 'PUT',
        headers: { 'Content-Type': 'application/octet-stream' },
        expiresAt: new Date(Date.now() + 300000).toISOString(),
        r2Key: 'pfm-trae/dev/documents/doc-1/new-ver-uuid/hash.bin',
      },
      error: null,
    });

    global.fetch = vi.fn().mockResolvedValue({ ok: true, status: 200 } as Response);
    vi.mocked(cryptoKeyService.generateDocumentKey).mockResolvedValue({ type: 'secret' } as unknown as CryptoKey);
    vi.mocked(cryptoKeyService.wrapDocumentKey).mockResolvedValue('editor-wrapped-key');
    vi.mocked(cryptoKeyService.distributeDocumentKey).mockResolvedValue(undefined);

    const documentSingle = vi.fn().mockResolvedValue({
      data: {
        id: 'doc-1',
        owner_id: 'owner-1',
        encrypted_title: '共享文档',
        metadata: {
          latestVersion: 'V1.0.0',
          latestRemark: 'old',
          versions: [{ version: 'V1.0.0', remark: 'old', author: 'owner@example.com', createdAt: '2026-05-01T00:00:00Z', sizeBytes: 100 }],
          selectedKeys: ['k1'],
          encryption: { enabled: true, version: 2 },
        },
      },
      error: null,
    });

    const updateEq = vi.fn().mockResolvedValue({ error: null });
    const update = vi.fn().mockReturnValue({ eq: updateEq });
    const insertVersion = vi.fn().mockResolvedValue({ error: null });
    const insertKeys = vi.fn().mockResolvedValue({ error: null });

    fromMock.mockImplementation((table: string) => {
      if (table === 'documents') {
        return {
          select: vi.fn().mockReturnValue({
            eq: vi.fn().mockReturnValue({ single: documentSingle }),
          }),
          update,
        };
      }

      if (table === 'document_shares') {
        return {
          select: vi.fn().mockReturnValue({
            eq: vi.fn().mockReturnValue({
              eq: vi.fn().mockReturnValue({
                limit: vi.fn().mockResolvedValue({
                  data: [{ document_id: 'doc-1' }],
                  error: null,
                }),
              }),
            }),
          }),
        };
      }

      if (table === 'document_versions') {
        return {
          select: vi.fn().mockReturnValue({
            eq: vi.fn().mockReturnValue({
              order: vi.fn().mockResolvedValue({
                data: [{ version_label: 'V1.0.0' }],
                error: null,
              }),
            }),
          }),
          insert: insertVersion,
        };
      }

      if (table === 'document_keys') {
        return {
          select: vi.fn().mockImplementation((columns: string) => {
            if (columns === 'wrapped_document_key, key_version') {
              return {
                eq: vi.fn().mockReturnValue({
                  eq: vi.fn().mockReturnValue({
                    order: vi.fn().mockReturnValue({
                      limit: vi.fn().mockResolvedValue({
                        data: [{ wrapped_document_key: 'editor-current-key', key_version: 3 }],
                        error: null,
                      }),
                    }),
                  }),
                }),
              };
            }
            if (columns === 'user_id') {
              return {
                eq: vi.fn().mockResolvedValue({
                  data: [{ user_id: 'owner-1' }, { user_id: 'member-1' }, { user_id: 'member-2' }],
                  error: null,
                }),
              };
            }
            return { eq: vi.fn() };
          }),
          insert: insertKeys,
        };
      }

      return {};
    });

    const blob = new Blob(['shared-doc'], { type: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document' });

    const result = await saveSharedDocumentVersion({
      documentId: 'doc-1',
      editorUserId: 'member-1',
      editorEmail: 'member-1@example.com',
      teamId: 'team-1',
      blob,
      fileName: 'shared.docx',
      version: 'V1.1.0',
      remark: 'member update',
      selectedKeys: ['k2'],
    });

    expect(result.documentId).toBe('doc-1');

    const infoCalls = vi.mocked(console.info).mock.calls
      .map(([message, payload]) => ({ message, payload }))
      .filter((call) => call.message === '[document-save]');

    expect(infoCalls.length).toBeGreaterThan(0);
    expect(infoCalls.some((call) => call.payload?.mode === 'shared' && call.payload?.step === 'save_started')).toBe(true);
    expect(infoCalls.some((call) => call.payload?.step === 'encryption' && call.payload?.status === 'start')).toBe(true);
    expect(infoCalls.some((call) => call.payload?.step === 'upload' && call.payload?.status === 'end' && typeof call.payload?.durationMs === 'number')).toBe(true);
    expect(infoCalls.some((call) => call.payload?.step === 'documents_write' && call.payload?.status === 'end')).toBe(true);
    expect(infoCalls.some((call) => call.payload?.step === 'document_versions_write' && call.payload?.status === 'end')).toBe(true);
    expect(infoCalls.some((call) => call.payload?.step === 'document_keys_write' && call.payload?.status === 'end')).toBe(true);
    expect(infoCalls.some((call) => call.payload?.step === 'shared_users_fetch' && call.payload?.status === 'end' && call.payload?.memberCount === 3)).toBe(true);
    expect(infoCalls.some((call) => call.payload?.step === 'key_distribution' && call.payload?.status === 'start' && call.payload?.memberCount === 2)).toBe(true);
    expect(infoCalls.some((call) => call.payload?.step === 'key_distribution' && call.payload?.status === 'end' && call.payload?.memberCount === 2 && typeof call.payload?.durationMs === 'number' && call.payload?.actualDistributed === 2 && typeof call.payload?.concurrency === 'number')).toBe(true);
    expect(infoCalls.some((call) => call.payload?.step === 'save_finished' && call.payload?.documentId === 'doc-1' && call.payload?.versionId === 'mock-ver-id' && call.payload?.fileSize === blob.size && call.payload?.memberCount === 2 && typeof call.payload?.durationMs === 'number')).toBe(true);
  });

  it('共享保存 telemetry 记录失败但不吞掉原始异常', async () => {
    const fromMock = supabase.from as unknown as MockFn;
    const invokeMock = supabase.functions.invoke as unknown as MockFn;

    invokeMock.mockResolvedValue({
      data: {
        url: 'https://r2.example.com/shared-put',
        method: 'PUT',
        headers: { 'Content-Type': 'application/octet-stream' },
        expiresAt: new Date(Date.now() + 300000).toISOString(),
        r2Key: 'pfm-trae/dev/documents/doc-1/new-ver-uuid/hash.bin',
      },
      error: null,
    });

    global.fetch = vi.fn().mockResolvedValue({ ok: true, status: 200 } as Response);
    vi.mocked(cryptoKeyService.generateDocumentKey).mockResolvedValue({ type: 'secret' } as unknown as CryptoKey);
    vi.mocked(cryptoKeyService.wrapDocumentKey).mockResolvedValue('editor-wrapped-key');
    vi.mocked(cryptoKeyService.distributeDocumentKey).mockImplementation(async (_docId, _key, userId) => {
      if (userId === 'member-2') {
        throw new Error('分发失败');
      }
    });

    const documentSingle = vi.fn().mockResolvedValue({
      data: {
        id: 'doc-1',
        owner_id: 'owner-1',
        encrypted_title: '共享文档',
        metadata: {
          latestVersion: 'V1.0.0',
          latestRemark: 'old',
          versions: [{ version: 'V1.0.0', remark: 'old', author: 'owner@example.com', createdAt: '2026-05-01T00:00:00Z', sizeBytes: 100 }],
          selectedKeys: ['k1'],
          encryption: { enabled: true, version: 2 },
        },
      },
      error: null,
    });

    const updateEq = vi.fn().mockResolvedValue({ error: null });
    const update = vi.fn().mockReturnValue({ eq: updateEq });
    const insertVersion = vi.fn().mockResolvedValue({ error: null });
    const insertKeys = vi.fn().mockResolvedValue({ error: null });

    fromMock.mockImplementation((table: string) => {
      if (table === 'documents') {
        return {
          select: vi.fn().mockReturnValue({
            eq: vi.fn().mockReturnValue({ single: documentSingle }),
          }),
          update,
        };
      }

      if (table === 'document_shares') {
        return {
          select: vi.fn().mockReturnValue({
            eq: vi.fn().mockReturnValue({
              eq: vi.fn().mockReturnValue({
                limit: vi.fn().mockResolvedValue({
                  data: [{ document_id: 'doc-1' }],
                  error: null,
                }),
              }),
            }),
          }),
        };
      }

      if (table === 'document_versions') {
        return {
          select: vi.fn().mockReturnValue({
            eq: vi.fn().mockReturnValue({
              order: vi.fn().mockResolvedValue({
                data: [{ version_label: 'V1.0.0' }],
                error: null,
              }),
            }),
          }),
          insert: insertVersion,
        };
      }

      if (table === 'document_keys') {
        return {
          select: vi.fn().mockImplementation((columns: string) => {
            if (columns === 'wrapped_document_key, key_version') {
              return {
                eq: vi.fn().mockReturnValue({
                  eq: vi.fn().mockReturnValue({
                    order: vi.fn().mockReturnValue({
                      limit: vi.fn().mockResolvedValue({
                        data: [{ wrapped_document_key: 'editor-current-key', key_version: 3 }],
                        error: null,
                      }),
                    }),
                  }),
                }),
              };
            }
            if (columns === 'user_id') {
              return {
                eq: vi.fn().mockResolvedValue({
                  data: [{ user_id: 'owner-1' }, { user_id: 'member-1' }, { user_id: 'member-2' }],
                  error: null,
                }),
              };
            }
            return { eq: vi.fn() };
          }),
          insert: insertKeys,
        };
      }

      return {};
    });

    const blob = new Blob(['shared-doc'], { type: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document' });

    await expect(saveSharedDocumentVersion({
      documentId: 'doc-1',
      editorUserId: 'member-1',
      editorEmail: 'member-1@example.com',
      teamId: 'team-1',
      blob,
      fileName: 'shared.docx',
      version: 'V1.1.0',
      remark: 'member update',
      selectedKeys: ['k2'],
    })).rejects.toThrow('分发失败');

    const errorCalls = vi.mocked(console.error).mock.calls
      .map(([message, payload]) => ({ message, payload }))
      .filter((call) => call.message === '[document-save]');

    expect(errorCalls.some((call) => call.payload?.mode === 'shared' && call.payload?.step === 'key_distribution' && call.payload?.status === 'failure' && call.payload?.documentId === 'doc-1' && call.payload?.versionId === 'mock-ver-id' && call.payload?.memberCount === 2 && call.payload?.fileSize === blob.size && typeof call.payload?.durationMs === 'number' && typeof call.payload?.error === 'string' && call.payload?.error.includes('分发失败'))).toBe(true);
  });

  it('共享保存 onProgress 被调用：成功时依次经过 preparing → encrypting → uploading → persisting → done', async () => {
    const fromMock = supabase.from as unknown as MockFn;
    const invokeMock = supabase.functions.invoke as unknown as MockFn;

    invokeMock.mockResolvedValue({
      data: {
        url: 'https://r2.example.com/shared-put',
        method: 'PUT',
        headers: { 'Content-Type': 'application/octet-stream' },
        expiresAt: new Date(Date.now() + 300000).toISOString(),
        r2Key: 'pfm-trae/dev/documents/doc-1/new-ver-uuid/hash.bin',
      },
      error: null,
    });

    global.fetch = vi.fn().mockResolvedValue({ ok: true, status: 200 } as Response);
    vi.mocked(cryptoKeyService.generateDocumentKey).mockResolvedValue({ type: 'secret' } as unknown as CryptoKey);
    vi.mocked(cryptoKeyService.wrapDocumentKey).mockResolvedValue('editor-wrapped-key');
    vi.mocked(cryptoKeyService.distributeDocumentKey).mockResolvedValue(undefined);

    // Mock Worker adapter to simulate chunk progress
    vi.mocked(documentEncryptionWorker.encryptDocumentChunkedViaWorker).mockImplementation(
      async (_input, options?: { onProgress?: (chunkIndex: number, totalChunks: number) => void }) => {
        options?.onProgress?.(0, 3);
        options?.onProgress?.(1, 3);
        options?.onProgress?.(2, 3);
        return {
          blob: new Blob(['encrypted'], { type: 'application/octet-stream' }),
          contentHash: 'shared-hash',
        };
      },
    );

    const documentSingle = vi.fn().mockResolvedValue({
      data: {
        id: 'doc-1',
        owner_id: 'owner-1',
        encrypted_title: '共享文档',
        metadata: {
          latestVersion: 'V1.0.0',
          latestRemark: 'old',
          versions: [{ version: 'V1.0.0', remark: 'old', author: 'owner@example.com', createdAt: '2026-05-01T00:00:00Z', sizeBytes: 100 }],
          selectedKeys: ['k1'],
          encryption: { enabled: true, version: 2 },
        },
      },
      error: null,
    });

    const updateEq = vi.fn().mockResolvedValue({ error: null });
    const update = vi.fn().mockReturnValue({ eq: updateEq });
    const insertVersion = vi.fn().mockResolvedValue({ error: null });
    const insertKeys = vi.fn().mockResolvedValue({ error: null });

    fromMock.mockImplementation((table: string) => {
      if (table === 'documents') {
        return {
          select: vi.fn().mockReturnValue({
            eq: vi.fn().mockReturnValue({ single: documentSingle }),
          }),
          update,
        };
      }

      if (table === 'document_shares') {
        return {
          select: vi.fn().mockReturnValue({
            eq: vi.fn().mockReturnValue({
              eq: vi.fn().mockReturnValue({
                limit: vi.fn().mockResolvedValue({
                  data: [{ document_id: 'doc-1' }],
                  error: null,
                }),
              }),
            }),
          }),
        };
      }

      if (table === 'document_versions') {
        return {
          select: vi.fn().mockReturnValue({
            eq: vi.fn().mockReturnValue({
              order: vi.fn().mockResolvedValue({
                data: [{ version_label: 'V1.0.0' }],
                error: null,
              }),
            }),
          }),
          insert: insertVersion,
        };
      }

      if (table === 'document_keys') {
        return {
          select: vi.fn().mockImplementation((columns: string) => {
            if (columns === 'wrapped_document_key, key_version') {
              return {
                eq: vi.fn().mockReturnValue({
                  eq: vi.fn().mockReturnValue({
                    order: vi.fn().mockReturnValue({
                      limit: vi.fn().mockResolvedValue({
                        data: [{ wrapped_document_key: 'editor-current-key', key_version: 3 }],
                        error: null,
                      }),
                    }),
                  }),
                }),
              };
            }
            if (columns === 'user_id') {
              return {
                eq: vi.fn().mockResolvedValue({
                  data: [{ user_id: 'owner-1' }, { user_id: 'member-1' }, { user_id: 'member-2' }],
                  error: null,
                }),
              };
            }
            return { eq: vi.fn() };
          }),
          insert: insertKeys,
        };
      }

      return {};
    });

    const blob = new Blob(['shared-doc'], { type: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document' });
    const onProgress = vi.fn();

    const result = await saveSharedDocumentVersion({
      documentId: 'doc-1',
      editorUserId: 'member-1',
      editorEmail: 'member-1@example.com',
      teamId: 'team-1',
      blob,
      fileName: 'shared.docx',
      version: 'V1.1.0',
      remark: 'member update',
      selectedKeys: ['k2'],
      onProgress,
    });

    expect(result.documentId).toBe('doc-1');

    const stages = onProgress.mock.calls.map(([info]: [{ stage: string }]) => info.stage);
    expect(stages).toContain('preparing');
    expect(stages).toContain('encrypting');
    expect(stages).toContain('uploading');
    expect(stages).toContain('persisting');
    expect(stages).toContain('done');

    // done 是最后一个 stage
    expect(stages[stages.length - 1]).toBe('done');

    // 验证 done 的 percent 和 message
    const doneCall = onProgress.mock.calls.find(
      ([info]: [{ stage: string }]) => info.stage === 'done',
    );
    expect(doneCall![0].percent).toBe(100);
    expect(doneCall![0].message).toBe('保存完成');
  });

  it('共享保存 onProgress 被调用：失败时最后一个 stage 是 failed', async () => {
    vi.mocked(documentEncryptionWorker.encryptDocumentChunkedViaWorker).mockRejectedValue(
      new Error('Worker unavailable'),
    );

    const fromMock = supabase.from as unknown as MockFn;
    const invokeMock = supabase.functions.invoke as unknown as MockFn;

    invokeMock.mockResolvedValue({
      data: {
        url: 'https://r2.example.com/shared-put',
        method: 'PUT',
        headers: { 'Content-Type': 'application/octet-stream' },
        expiresAt: new Date(Date.now() + 300000).toISOString(),
        r2Key: 'pfm-trae/dev/documents/doc-1/new-ver-uuid/hash.bin',
      },
      error: null,
    });

    global.fetch = vi.fn().mockResolvedValue({ ok: true, status: 200 } as Response);

    const documentSingle = vi.fn().mockResolvedValue({
      data: {
        id: 'doc-1',
        owner_id: 'owner-1',
        encrypted_title: '共享文档',
        metadata: {
          latestVersion: 'V1.0.0',
          latestRemark: 'old',
          versions: [],
          selectedKeys: ['k1'],
          encryption: { enabled: true, version: 2 },
        },
      },
      error: null,
    });

    fromMock.mockImplementation((table: string) => {
      if (table === 'documents') {
        return {
          select: vi.fn().mockReturnValue({
            eq: vi.fn().mockReturnValue({ single: documentSingle }),
          }),
          update: vi.fn().mockReturnValue({ eq: vi.fn().mockResolvedValue({ error: null }) }),
        };
      }

      if (table === 'document_shares') {
        return {
          select: vi.fn().mockReturnValue({
            eq: vi.fn().mockReturnValue({
              eq: vi.fn().mockReturnValue({
                limit: vi.fn().mockResolvedValue({
                  data: [{ document_id: 'doc-1' }],
                  error: null,
                }),
              }),
            }),
          }),
        };
      }

      if (table === 'document_versions') {
        return {
          select: vi.fn().mockReturnValue({
            eq: vi.fn().mockReturnValue({
              order: vi.fn().mockResolvedValue({
                data: [],
                error: null,
              }),
            }),
          }),
          insert: vi.fn().mockResolvedValue({ error: null }),
        };
      }

      if (table === 'document_keys') {
        return {
          select: vi.fn().mockImplementation((columns: string) => {
            if (columns === 'wrapped_document_key, key_version') {
              return {
                eq: vi.fn().mockReturnValue({
                  eq: vi.fn().mockReturnValue({
                    order: vi.fn().mockReturnValue({
                      limit: vi.fn().mockResolvedValue({
                        data: [{ wrapped_document_key: 'editor-current-key', key_version: 3 }],
                        error: null,
                      }),
                    }),
                  }),
                }),
              };
            }
            return { eq: vi.fn() };
          }),
          insert: vi.fn().mockResolvedValue({ error: null }),
        };
      }

      return {};
    });

    const blob = new Blob(['shared-doc'], { type: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document' });
    const onProgress = vi.fn();

    await expect(
      saveSharedDocumentVersion({
        documentId: 'doc-1',
        editorUserId: 'member-1',
        editorEmail: 'member-1@example.com',
        teamId: 'team-1',
        blob,
        fileName: 'shared.docx',
        version: 'V1.1.0',
        remark: 'member update',
        selectedKeys: ['k2'],
        onProgress,
      }),
    ).rejects.toThrow('Worker unavailable');

    const stages = onProgress.mock.calls.map(([info]: [{ stage: string }]) => info.stage);
    expect(stages[stages.length - 1]).toBe('failed');

    const failedCall = onProgress.mock.calls.find(
      ([info]: [{ stage: string }]) => info.stage === 'failed',
    );
    expect(failedCall![0].message).toBe('保存失败');
  });
});

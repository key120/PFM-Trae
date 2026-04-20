import { describe, expect, it, vi, beforeEach } from 'vitest';
import {
  savePersonalDocument,
  fetchPersonalDocuments,
  loadPersonalDocument,
} from './documentService';
import { supabase } from '../lib/supabase';
import * as cryptoKeyService from './cryptoKeyService';
import * as encryptionService from './encryptionService';
import * as idGenerator from '../utils/idGenerator';

type MockFn = ReturnType<typeof vi.fn>;

// Mock 加密服务
vi.mock('./encryptionService', () => ({
  encryptDocumentChunked: vi.fn(async () => ({
    blob: new Blob(['encrypted'], { type: 'application/octet-stream' }),
    contentHash: 'abc123hash',
  })),
  decryptDocumentChunked: vi.fn(async () => ({
    file: new File(['decrypted-content'], 'test.docx', {
      type: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
    }),
    meta: { title: 'test.docx', selectedKeys: ['k1', 'k2'] },
  })),
}));

// Mock 密钥服务
vi.mock('./cryptoKeyService', () => ({
  isWebCryptoAvailable: vi.fn(() => true),
  generateDocumentKey: vi.fn(async () => ({ type: 'secret', algorithm: { name: 'AES-GCM' } })),
  wrapDocumentKey: vi.fn(async () => 'wrapped-key-base64'),
  unwrapDocumentKey: vi.fn(async () => ({ type: 'secret', algorithm: { name: 'AES-GCM' } })),
  getUserKeyPair: vi.fn(async () => ({
    publicKey: { type: 'public' },
    privateKey: { type: 'private' },
  })),
  restoreUserPrivateKey: vi.fn(async () => ({ type: 'private' })),
  backupUserPrivateKey: vi.fn(async () => true),
  getDocumentEncryptionStatus: vi.fn(() => ({ isEncrypted: false, encryptionVersion: null })),
}));

// Mock ID 生成器
vi.mock('../utils/idGenerator', () => ({
  generateDocumentId: vi.fn(() => 'new-doc-uuid'),
  generateVersionId: vi.fn(() => 'new-ver-uuid'),
}));

vi.mock('../lib/supabase', () => ({
  supabase: {
    storage: { from: vi.fn() },
    from: vi.fn(),
    functions: { invoke: vi.fn() },
  },
}));

const resetSupabaseMocks = () => {
  (supabase.storage.from as unknown as MockFn).mockReset();
  (supabase.from as unknown as MockFn).mockReset();
  (supabase.functions.invoke as unknown as MockFn).mockReset();
  vi.mocked(encryptionService.encryptDocumentChunked).mockImplementation(async () => ({
    blob: new Blob(['encrypted'], { type: 'application/octet-stream' }),
    contentHash: 'abc123hash',
  }));
  vi.mocked(encryptionService.decryptDocumentChunked).mockImplementation(async () => ({
    file: new File(['decrypted-content'], 'test.docx', {
      type: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
    }),
    meta: { title: 'test.docx', selectedKeys: ['k1', 'k2'] },
  }));
  vi.mocked(cryptoKeyService.isWebCryptoAvailable).mockImplementation(() => true);
  vi.mocked(cryptoKeyService.getUserKeyPair).mockImplementation(async () => ({
    publicKey: { type: 'public' } as unknown as CryptoKey,
    privateKey: { type: 'private' } as unknown as CryptoKey,
  }));
};

describe('savePersonalDocument', () => {
  beforeEach(() => {
    resetSupabaseMocks();
  });

  it('新建文档：加密上传到 R2 并写入 documents / document_versions / document_keys', async () => {
    const fromMock = supabase.from as unknown as MockFn;
    const invokeMock = supabase.functions.invoke as unknown as MockFn;

    // Mock r2-sign-upload
    invokeMock.mockResolvedValue({
      data: {
        url: 'https://r2.example.com/put-url',
        method: 'PUT',
        headers: { 'Content-Type': 'application/octet-stream' },
        expiresAt: new Date(Date.now() + 300000).toISOString(),
        r2Key: 'pfm-trae/dev/documents/new-doc-uuid/new-ver-uuid/abc123hash.bin',
      },
      error: null,
    });

    // Mock global fetch（R2 PUT）
    global.fetch = vi.fn().mockResolvedValue({ ok: true, status: 200 } as Response);

    // Mock documents insert（简单 insert，无需 select/single）
    const insertDoc = vi.fn().mockResolvedValue({ error: null });

    // Mock document_versions insert
    const insertVerResult = vi.fn().mockResolvedValue({ error: null });

    // Mock document_keys 查询现有版本（已有 V2，下次应写入 V3）
    const keyMaybeSingle = vi.fn().mockResolvedValue({ data: { key_version: 2 }, error: null });
    const keyLimit = vi.fn(() => ({ maybeSingle: keyMaybeSingle }));
    const keyOrder = vi.fn(() => ({ limit: keyLimit }));
    const keyEq2 = vi.fn(() => ({ order: keyOrder }));
    const keyEq1 = vi.fn(() => ({ eq: keyEq2 }));
    const keySelect = vi.fn(() => ({ eq: keyEq1 }));

    // Mock document_keys insert
    const insertKeyResult = vi.fn().mockResolvedValue({ error: null });

    fromMock.mockImplementation((table: string) => {
      if (table === 'documents') return { insert: insertDoc };
      if (table === 'document_versions') return { insert: insertVerResult };
      if (table === 'document_keys') return { select: keySelect, insert: insertKeyResult };
      return {};
    });

    const blob = new Blob(['original-docx'], {
      type: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
    });

    const result = await savePersonalDocument({
      userId: 'user-1',
      authorEmail: 'test@example.com',
      blob,
      fileName: 'test.docx',
      version: 'V1.0.0',
      remark: '初始版本',
      selectedKeys: ['k1', 'k2'],
    });

    // 验证返回了正确的 documentId（预生成的 UUID，不依赖 DB 返回）
    expect(vi.mocked(idGenerator.generateDocumentId)).toHaveBeenCalled();
    expect(result.documentId).toBe('new-doc-uuid');

    // 验证调用了 r2-sign-upload
    expect(invokeMock).toHaveBeenCalledWith('r2-sign-upload', expect.objectContaining({
      body: expect.objectContaining({
        documentId: 'new-doc-uuid',
        versionId: 'new-ver-uuid',
        operation: 'upload',
      }),
    }));

    // 验证调用了 fetch PUT 到 R2
    expect(global.fetch).toHaveBeenCalledWith(
      'https://r2.example.com/put-url',
      expect.objectContaining({ method: 'PUT' }),
    );

    // 验证 documents 表写入
    expect(fromMock).toHaveBeenCalledWith('documents');
    const insertDocArg = insertDoc.mock.calls[0][0] as Record<string, unknown>;
    expect(insertDocArg.id).toBe('new-doc-uuid');
    expect(insertDocArg.owner_id).toBe('user-1');
    expect(insertDocArg.encrypted_title).toBe('test.docx');
    expect((insertDocArg.metadata as Record<string, unknown>).encryption).toEqual({ enabled: true, version: 2 });

    // 验证 document_versions 表写入
    expect(fromMock).toHaveBeenCalledWith('document_versions');
    const insertVerArg = insertVerResult.mock.calls[0][0] as Record<string, unknown>;
    expect(insertVerArg.document_id).toBe('new-doc-uuid');
    expect(insertVerArg.version_label).toBe('V1.0.0');
    expect(insertVerArg.author_id).toBe('user-1');
    expect(insertVerArg.content_hash).toBe('abc123hash');
    expect(insertVerArg.key_version).toBe(3);
    expect((insertVerArg.encrypted_meta as Record<string, unknown>).keyVersion).toBe(3);

    // 验证 document_keys 表写入
    expect(fromMock).toHaveBeenCalledWith('document_keys');
    const insertKeyArg = insertKeyResult.mock.calls[0][0] as Record<string, unknown>;
    expect(insertKeyArg.document_id).toBe('new-doc-uuid');
    expect(insertKeyArg.user_id).toBe('user-1');
    expect(insertKeyArg.wrapped_document_key).toBe('wrapped-key-base64');
    expect(insertKeyArg.key_version).toBe(3);

    // 验证会触发用户私钥备份（用于跨浏览器恢复），并与 document key_version 对齐
    expect(vi.mocked(cryptoKeyService.backupUserPrivateKey)).toHaveBeenCalledTimes(1);
    expect(vi.mocked(cryptoKeyService.backupUserPrivateKey)).toHaveBeenCalledWith(
      expect.anything(),
      3,
    );
  });

  it('更新已有文档：沿用 documentId，追加新版本到 versions 列表', async () => {
    const fromMock = supabase.from as unknown as MockFn;
    const invokeMock = supabase.functions.invoke as unknown as MockFn;

    invokeMock.mockResolvedValue({
      data: {
        url: 'https://r2.example.com/put-url',
        method: 'PUT',
        headers: { 'Content-Type': 'application/octet-stream' },
        expiresAt: new Date(Date.now() + 300000).toISOString(),
        r2Key: 'pfm-trae/dev/documents/existing-doc/new-ver-uuid/abc123hash.bin',
      },
      error: null,
    });

    global.fetch = vi.fn().mockResolvedValue({ ok: true, status: 200 } as Response);

    // Mock 读取现有元数据
    const metaSingle = vi.fn().mockResolvedValue({
      data: { metadata: { versions: [{ version: 'V1.0.0', remark: '', author: null, createdAt: '2025-01-01T00:00:00Z' }] } },
      error: null,
    });
    const metaEq2 = vi.fn(() => ({ single: metaSingle }));
    const metaEq1 = vi.fn(() => ({ eq: metaEq2 }));
    const metaSelect = vi.fn(() => ({ eq: metaEq1 }));

    // Mock update
    const updateEq2 = vi.fn().mockResolvedValue({ error: null });
    const updateEq1 = vi.fn(() => ({ eq: updateEq2 }));
    const update = vi.fn(() => ({ eq: updateEq1 }));

    // Mock document_versions insert
    const insertVer = vi.fn().mockResolvedValue({ error: null });

    // Mock document_keys 查询现有版本
    const keyMaybeSingle = vi.fn().mockResolvedValue({ data: null, error: null });
    const keyLimit = vi.fn(() => ({ maybeSingle: keyMaybeSingle }));
    const keyOrder = vi.fn(() => ({ limit: keyLimit }));
    const keyEq2 = vi.fn(() => ({ order: keyOrder }));
    const keyEq1 = vi.fn(() => ({ eq: keyEq2 }));
    const keySelect = vi.fn(() => ({ eq: keyEq1 }));

    // Mock document_keys insert
    const insertKey = vi.fn().mockResolvedValue({ error: null });

    fromMock.mockImplementation((table: string) => {
      if (table === 'documents') return { select: metaSelect, update };
      if (table === 'document_versions') return { insert: insertVer };
      if (table === 'document_keys') return { select: keySelect, insert: insertKey };
      return {};
    });

    const blob = new Blob(['updated-docx'], {
      type: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
    });

    const result = await savePersonalDocument({
      userId: 'user-1',
      authorEmail: 'test@example.com',
      blob,
      fileName: 'test.docx',
      documentId: 'existing-doc',
      version: 'V1.1.0',
      remark: '第二次保存',
      selectedKeys: ['k3'],
    });

    expect(result.documentId).toBe('existing-doc');

    // 验证 update 被调用而非 insert
    expect(update).toHaveBeenCalledTimes(1);
    const updateCalls = update.mock.calls as unknown as [Record<string, unknown>][];
    const updateArg = updateCalls[0][0];
    const meta = updateArg.metadata as Record<string, unknown>;
    const versions = meta.versions as Array<Record<string, unknown>>;
    expect(versions.length).toBe(2); // 新版本 + 旧版本
    expect(versions[0].version).toBe('V1.1.0'); // 最新版本置顶

    // 验证 document_versions 写入
    const verArg = insertVer.mock.calls[0][0] as Record<string, unknown>;
    expect(verArg.version_label).toBe('V1.1.0');
    expect(verArg.document_id).toBe('existing-doc');
    expect(verArg.key_version).toBe(1);
    expect((verArg.encrypted_meta as Record<string, unknown>).keyVersion).toBe(1);
  });

  it('WebCrypto 不可用时抛出明确错误', async () => {
    vi.mocked(cryptoKeyService.isWebCryptoAvailable).mockReturnValueOnce(false);

    const blob = new Blob(['test']);
    await expect(
      savePersonalDocument({
        userId: 'user-1',
        authorEmail: null,
        blob,
        fileName: 'test.docx',
        version: 'V1.0.0',
        remark: '',
        selectedKeys: [],
      }),
    ).rejects.toThrow('Web Crypto API');
  });

  it('用户密钥不存在时抛出明确错误', async () => {
    vi.mocked(cryptoKeyService.getUserKeyPair).mockResolvedValueOnce(null);

    const blob = new Blob(['test']);
    await expect(
      savePersonalDocument({
        userId: 'user-1',
        authorEmail: null,
        blob,
        fileName: 'test.docx',
        version: 'V1.0.0',
        remark: '',
        selectedKeys: [],
      }),
    ).rejects.toThrow('用户密钥');
  });

  it('用例5：R2 上传失败时抛出错误，不写入 document_versions / document_keys', async () => {
    const fromMock = supabase.from as unknown as MockFn;
    const invokeMock = supabase.functions.invoke as unknown as MockFn;

    // 获取签名成功
    invokeMock.mockResolvedValue({
      data: {
        url: 'https://r2.example.com/put-url',
        method: 'PUT',
        headers: { 'Content-Type': 'application/octet-stream' },
        expiresAt: new Date(Date.now() + 300000).toISOString(),
        r2Key: 'pfm-trae/dev/documents/new-doc-uuid/new-ver-uuid/abc123hash.bin',
      },
      error: null,
    });

    // R2 PUT 失败
    global.fetch = vi.fn().mockResolvedValue({ ok: false, status: 503, statusText: 'Service Unavailable' } as Response);

    const insertDoc = vi.fn().mockResolvedValue({ error: null });
    const insertVer = vi.fn().mockResolvedValue({ error: null });
    const insertKey = vi.fn().mockResolvedValue({ error: null });

    const keyMaybeSingle = vi.fn().mockResolvedValue({ data: null, error: null });
    const keyLimit = vi.fn(() => ({ maybeSingle: keyMaybeSingle }));
    const keyOrder = vi.fn(() => ({ limit: keyLimit }));
    const keyEq2 = vi.fn(() => ({ order: keyOrder }));
    const keyEq1 = vi.fn(() => ({ eq: keyEq2 }));
    const keySelect = vi.fn(() => ({ eq: keyEq1 }));

    fromMock.mockImplementation((table: string) => {
      if (table === 'documents') return { insert: insertDoc };
      if (table === 'document_versions') return { insert: insertVer };
      if (table === 'document_keys') return { select: keySelect, insert: insertKey };
      return {};
    });

    const blob = new Blob(['test']);
    await expect(
      savePersonalDocument({ userId: 'user-1', authorEmail: null, blob, fileName: 'test.docx', version: 'V1.0.0', remark: '', selectedKeys: [] }),
    ).rejects.toThrow('R2 upload failed');

    // 上传失败，后续 DB 写入均不应被调用
    expect(insertDoc).not.toHaveBeenCalled();
    expect(insertVer).not.toHaveBeenCalled();
    expect(insertKey).not.toHaveBeenCalled();
  });
});

describe('fetchPersonalDocuments', () => {
  beforeEach(() => {
    resetSupabaseMocks();
  });

  it('过滤 r2 占位路径并映射文档字段', async () => {
    const fromMock = supabase.from as unknown as MockFn;
    const select = vi.fn().mockReturnThis();
    const eq = vi.fn().mockReturnThis();
    const order = vi.fn().mockResolvedValue({
      data: [
        {
          id: 'doc-1',
          encrypted_title: '我的合同文档.docx',
          size: 1024,
          path: 'user-1/1234-abcdef.docx',
          created_at: '2025-01-01T00:00:00Z',
          updated_at: '2025-01-02T00:00:00Z',
          metadata: {
            latestVersion: 'V1.0.0',
            latestRemark: '第一次保存',
            versions: [],
            encryption: { enabled: true, version: 2 },
          },
        },
        {
          id: 'doc-2',
          size: 2048,
          path: 'r2://dummy/legacy',
          created_at: '2025-01-03T00:00:00Z',
          updated_at: '2025-01-04T00:00:00Z',
          metadata: null,
        },
      ],
      error: null,
    });

    fromMock.mockReturnValue({ select, eq, order });

    const result = await fetchPersonalDocuments('user-1');

    expect(result).toHaveLength(1);
    expect(result[0]).toMatchObject({
      id: 'doc-1',
      name: '我的合同文档.docx',
      size: 1024,
      version: 'V1.0.0',
      remark: '第一次保存',
    });
  });

  it('无 encrypted_title 时降级使用 path 文件名', async () => {
    const fromMock = supabase.from as unknown as MockFn;
    const select = vi.fn().mockReturnThis();
    const eq = vi.fn().mockReturnThis();
    const order = vi.fn().mockResolvedValue({
      data: [
        {
          id: 'doc-3',
          encrypted_title: null,
          size: 512,
          path: 'user-1/legacy-name.docx',
          created_at: '2025-01-05T00:00:00Z',
          updated_at: '2025-01-06T00:00:00Z',
          metadata: {
            latestVersion: 'V1.0.0',
            latestRemark: '',
            versions: [],
            encryption: { enabled: true, version: 1 },
          },
        },
      ],
      error: null,
    });

    fromMock.mockReturnValue({ select, eq, order });

    const result = await fetchPersonalDocuments('user-1');
    expect(result).toHaveLength(1);
    expect(result[0].name).toBe('legacy-name.docx');
  });
});

describe('loadPersonalDocument', () => {
  beforeEach(() => {
    resetSupabaseMocks();
  });

  it('根据 owner_id 和文档 id 加载最新版本及元数据', async () => {
    const fromMock = supabase.from as unknown as MockFn;
    const storageFromMock = supabase.storage.from as unknown as MockFn;

    const select = vi.fn().mockReturnThis();
    const eq = vi.fn().mockReturnThis();
    const single = vi.fn().mockResolvedValue({
      data: {
        path: 'user-1/doc-1.docx',
        metadata: {
          latestVersion: 'V1.0.0',
          latestRemark: '第一次保存',
          selectedKeys: ['k1', 'k2'],
        },
      },
      error: null,
    });

    fromMock.mockReturnValue({ select, eq, single });

    const blob = new Blob(['dummy'], {
      type: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
    });
    const download = vi.fn().mockResolvedValue({ data: blob, error: null });
    storageFromMock.mockReturnValue({ download });

    const result = await loadPersonalDocument('user-1', 'doc-1');

    expect(result.file).toBeInstanceOf(File);
    expect(result.file.name).toBe('doc-1.docx');
    expect(result.version).toBe('V1.0.0');
    expect(result.remark).toBe('第一次保存');
    expect(result.selectedKeys).toEqual(['k1', 'k2']);
  });

  it('查询不到文档时抛出错误', async () => {
    const fromMock = supabase.from as unknown as MockFn;
    const select = vi.fn().mockReturnThis();
    const eq = vi.fn().mockReturnThis();
    const single = vi.fn().mockResolvedValue({
      data: null,
      error: new Error('not found'),
    });

    fromMock.mockReturnValue({ select, eq, single });

    await expect(loadPersonalDocument('user-1', 'doc-missing')).rejects.toThrow('not found');
  });

  it('加密文档：从 R2 下载并解密，恢复 file / version / selectedKeys', async () => {
    const fromMock = supabase.from as unknown as MockFn;
    const invokeMock = supabase.functions.invoke as unknown as MockFn;

    fromMock.mockImplementation((table: string) => {
      if (table === 'documents') {
        return {
          select: vi.fn().mockReturnValue({
            eq: vi.fn().mockReturnValue({
              eq: vi.fn().mockReturnValue({
                single: vi.fn().mockResolvedValue({
                  data: {
                    path: 'pfm-trae/dev/documents/doc-enc/ver-001/hash.bin',
                    metadata: { encryption: { enabled: true, version: 2 }, latestVersion: 'V1.0.0', latestRemark: '初始版本' },
                  },
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
              order: vi.fn().mockReturnValue({
                limit: vi.fn().mockReturnValue({
                  single: vi.fn().mockResolvedValue({
                    data: { id: 'ver-uuid-001', r2_key: 'hash.bin', content_hash: 'abc123', encrypted_meta: { title: 'encrypted-doc.docx', selectedKeys: ['k1', 'k2'] }, version_label: 'V1.0.0', note: '初始版本' },
                    error: null,
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
                order: vi.fn().mockReturnValue({
                  limit: vi.fn().mockResolvedValue({
                    data: [{ wrapped_document_key: 'wrapped-key-base64', key_version: 1 }],
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
      ok: true, status: 200,
      blob: async () => new Blob(['encrypted-content'], { type: 'application/octet-stream' }),
    } as unknown as Response);

    const result = await loadPersonalDocument('user-1', 'doc-enc');

    expect(invokeMock).toHaveBeenCalledWith('r2-sign-download', expect.objectContaining({
      body: expect.objectContaining({ documentId: 'doc-enc', versionId: 'ver-uuid-001' }),
    }));
    expect(vi.mocked(cryptoKeyService.unwrapDocumentKey)).toHaveBeenCalled();
    expect(vi.mocked(encryptionService.decryptDocumentChunked)).toHaveBeenCalled();
    expect(result.file).toBeInstanceOf(File);
    expect(result.version).toBe('V1.0.0');
    expect(result.remark).toBe('初始版本');
    expect(result.selectedKeys).toEqual(['k1', 'k2']);
  });

  it('加密文档：最新 wrapped key 解封失败时会回退尝试旧版本 key', async () => {
    const fromMock = supabase.from as unknown as MockFn;
    const invokeMock = supabase.functions.invoke as unknown as MockFn;

    fromMock.mockImplementation((table: string) => {
      if (table === 'documents') {
        return {
          select: vi.fn().mockReturnValue({
            eq: vi.fn().mockReturnValue({
              eq: vi.fn().mockReturnValue({
                single: vi.fn().mockResolvedValue({
                  data: {
                    path: 'pfm-trae/dev/documents/doc-enc/ver-001/hash.bin',
                    metadata: { encryption: { enabled: true, version: 2 }, latestVersion: 'V1.0.0', latestRemark: '初始版本' },
                  },
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
              order: vi.fn().mockReturnValue({
                limit: vi.fn().mockReturnValue({
                  single: vi.fn().mockResolvedValue({
                    data: { id: 'ver-uuid-001', r2_key: 'hash.bin', content_hash: 'abc123', encrypted_meta: { title: 'encrypted-doc.docx', selectedKeys: ['k1', 'k2'] }, version_label: 'V1.0.0', note: '初始版本' },
                    error: null,
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
                order: vi.fn().mockReturnValue({
                  limit: vi.fn().mockResolvedValue({
                    data: [
                      { wrapped_document_key: 'bad-new-key', key_version: 3 },
                      { wrapped_document_key: 'good-old-key', key_version: 2 },
                    ],
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

    vi.mocked(cryptoKeyService.unwrapDocumentKey)
      .mockRejectedValueOnce(new Error('OperationError'))
      .mockResolvedValueOnce({ type: 'secret', algorithm: { name: 'AES-GCM' } } as unknown as CryptoKey);

    const result = await loadPersonalDocument('user-1', 'doc-enc');

    expect(result.file).toBeInstanceOf(File);
    expect(vi.mocked(cryptoKeyService.unwrapDocumentKey)).toHaveBeenCalledTimes(2);
  });

  it('加密文档：本地无密钥时会先 restore 私钥再继续解密下载', async () => {
    const fromMock = supabase.from as unknown as MockFn;
    const invokeMock = supabase.functions.invoke as unknown as MockFn;

    fromMock.mockImplementation((table: string) => {
      if (table === 'documents') {
        return {
          select: vi.fn().mockReturnValue({
            eq: vi.fn().mockReturnValue({
              eq: vi.fn().mockReturnValue({
                single: vi.fn().mockResolvedValue({
                  data: {
                    path: 'pfm-trae/dev/documents/doc-enc/ver-001/hash.bin',
                    metadata: { encryption: { enabled: true, version: 2 } },
                  },
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
              order: vi.fn().mockReturnValue({
                limit: vi.fn().mockReturnValue({
                  single: vi.fn().mockResolvedValue({
                    data: {
                      id: 'ver-uuid-001',
                      r2_key: 'hash.bin',
                      content_hash: 'abc123',
                      encrypted_meta: { title: 'encrypted-doc.docx', selectedKeys: ['k1'] },
                      version_label: 'V1.0.0',
                      note: '初始版本',
                    },
                    error: null,
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
                order: vi.fn().mockReturnValue({
                  limit: vi.fn().mockResolvedValue({
                    data: [{ wrapped_document_key: 'wrapped-key-base64', key_version: 1 }],
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
      data: {
        url: 'https://r2.example.com/get-url',
        method: 'GET',
        headers: {},
        expiresAt: new Date(Date.now() + 300000).toISOString(),
        r2Key: 'hash.bin',
      },
      error: null,
    });

    global.fetch = vi.fn().mockResolvedValue({
      ok: true,
      status: 200,
      blob: async () => new Blob(['encrypted-content'], { type: 'application/octet-stream' }),
    } as unknown as Response);

    vi.mocked(cryptoKeyService.getUserKeyPair)
      .mockResolvedValueOnce(null)
      .mockResolvedValueOnce({
        publicKey: { type: 'public' } as unknown as CryptoKey,
        privateKey: { type: 'private' } as unknown as CryptoKey,
      });

    const restoreMock = vi.mocked(cryptoKeyService.restoreUserPrivateKey);
    restoreMock.mockResolvedValueOnce({ type: 'private' } as unknown as CryptoKey);

    const result = await loadPersonalDocument('user-1', 'doc-enc');

    expect(restoreMock).toHaveBeenCalledTimes(1);
    expect(invokeMock).toHaveBeenCalledWith('r2-sign-download', expect.any(Object));
    expect(result.file).toBeInstanceOf(File);
  });

  it('加密文档：版本密钥解封失败时，仅恢复最新私钥并继续尝试下一版本 key', async () => {
    const fromMock = supabase.from as unknown as MockFn;
    const invokeMock = supabase.functions.invoke as unknown as MockFn;

    fromMock.mockImplementation((table: string) => {
      if (table === 'documents') {
        return {
          select: vi.fn().mockReturnValue({
            eq: vi.fn().mockReturnValue({
              eq: vi.fn().mockReturnValue({
                single: vi.fn().mockResolvedValue({
                  data: {
                    path: 'pfm-trae/dev/documents/doc-enc/ver-001/hash.bin',
                    metadata: { encryption: { enabled: true, version: 2 } },
                  },
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
              order: vi.fn().mockReturnValue({
                limit: vi.fn().mockReturnValue({
                  single: vi.fn().mockResolvedValue({
                    data: {
                      id: 'ver-uuid-001',
                      r2_key: 'hash.bin',
                      content_hash: 'abc123',
                      encrypted_meta: { title: 'encrypted-doc.docx', selectedKeys: ['k1'] },
                      version_label: 'V1.0.0',
                      note: '初始版本',
                      key_version: 5,
                    },
                    error: null,
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
                order: vi.fn().mockReturnValue({
                  limit: vi.fn().mockResolvedValue({
                    data: [
                      { wrapped_document_key: 'wrapped-v5', key_version: 5 },
                      { wrapped_document_key: 'wrapped-v3', key_version: 3 },
                    ],
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
      data: {
        url: 'https://r2.example.com/get-url',
        method: 'GET',
        headers: {},
        expiresAt: new Date(Date.now() + 300000).toISOString(),
        r2Key: 'hash.bin',
      },
      error: null,
    });

    global.fetch = vi.fn().mockResolvedValue({
      ok: true,
      status: 200,
      blob: async () => new Blob(['encrypted-content'], { type: 'application/octet-stream' }),
    } as unknown as Response);

    vi.mocked(cryptoKeyService.getUserKeyPair).mockResolvedValueOnce({
      publicKey: { type: 'public' } as unknown as CryptoKey,
      privateKey: { type: 'bad-private' } as unknown as CryptoKey,
    });

    const restoreMock = vi.mocked(cryptoKeyService.restoreUserPrivateKey);
    restoreMock.mockResolvedValue({ type: 'restored-latest' } as unknown as CryptoKey);

    vi.mocked(cryptoKeyService.unwrapDocumentKey).mockImplementation(
      async (wrappedKey: string, privateKey: CryptoKey) => {
        const typed = privateKey as unknown as { type?: string };
        if (wrappedKey === 'wrapped-v3' && typed.type === 'restored-latest') {
          return { type: 'secret', algorithm: { name: 'AES-GCM' } } as unknown as CryptoKey;
        }
        throw new Error('OperationError');
      },
    );

    const result = await loadPersonalDocument('user-1', 'doc-enc');

    expect(restoreMock).toHaveBeenCalled();
    expect(restoreMock).not.toHaveBeenCalledWith(5);
    expect(restoreMock).not.toHaveBeenCalledWith(3);
    expect(result.file).toBeInstanceOf(File);
  });

  it('加密文档：本地私钥不匹配导致解封失败时抛出 KEY_NOT_READY', async () => {
    const fromMock = supabase.from as unknown as MockFn;

    fromMock.mockImplementation((table: string) => {
      if (table === 'documents') {
        return {
          select: vi.fn().mockReturnValue({
            eq: vi.fn().mockReturnValue({
              eq: vi.fn().mockReturnValue({
                single: vi.fn().mockResolvedValue({
                  data: {
                    path: 'pfm-trae/dev/documents/doc-enc/ver-001/hash.bin',
                    metadata: { encryption: { enabled: true, version: 2 } },
                  },
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
              order: vi.fn().mockReturnValue({
                limit: vi.fn().mockReturnValue({
                  single: vi.fn().mockResolvedValue({
                    data: { id: 'ver-uuid-001', r2_key: 'hash.bin', content_hash: 'abc123', encrypted_meta: null, version_label: 'V1.0.0', note: '初始版本' },
                    error: null,
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
                order: vi.fn().mockReturnValue({
                  limit: vi.fn().mockResolvedValue({
                    data: [{ wrapped_document_key: 'bad-wrapped-key', key_version: 1 }],
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

    vi.mocked(cryptoKeyService.getUserKeyPair)
      .mockResolvedValueOnce({
        publicKey: { type: 'public' } as unknown as CryptoKey,
        privateKey: { type: 'bad-private' } as unknown as CryptoKey,
      })
      .mockResolvedValueOnce({
        publicKey: { type: 'public' } as unknown as CryptoKey,
        privateKey: { type: 'restored-but-still-bad' } as unknown as CryptoKey,
      });

    const restoreMock = vi.mocked(cryptoKeyService.restoreUserPrivateKey);
    restoreMock.mockResolvedValueOnce({ type: 'private' } as unknown as CryptoKey);

    vi.mocked(cryptoKeyService.unwrapDocumentKey).mockRejectedValue(new Error('OperationError'));

    await expect(loadPersonalDocument('user-1', 'doc-enc')).rejects.toMatchObject({ code: 'KEY_NOT_READY' });
    expect(restoreMock).toHaveBeenCalledTimes(1);
    expect(restoreMock).toHaveBeenNthCalledWith(1);
    expect(vi.mocked(cryptoKeyService.unwrapDocumentKey)).toHaveBeenCalledTimes(2);
  });


  it('加密文档但 document_keys 无记录时抛出明确错误', async () => {
    const fromMock = supabase.from as unknown as MockFn;

    fromMock.mockImplementation((table: string) => {
      if (table === 'documents') {
        return {
          select: vi.fn().mockReturnValue({
            eq: vi.fn().mockReturnValue({
              eq: vi.fn().mockReturnValue({
                single: vi.fn().mockResolvedValue({
                  data: { path: 'r2key', metadata: { encryption: { enabled: true, version: 2 } } },
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
              order: vi.fn().mockReturnValue({
                limit: vi.fn().mockReturnValue({
                  single: vi.fn().mockResolvedValue({
                    data: { id: 'ver-1', r2_key: 'key', content_hash: 'h', encrypted_meta: null, version_label: 'V1', note: null },
                    error: null,
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
                order: vi.fn().mockReturnValue({
                  limit: vi.fn().mockResolvedValue({ data: [], error: null }),
                }),
              }),
            }),
          }),
        };
      }
      return {};
    });

    await expect(loadPersonalDocument('user-1', 'doc-enc-no-key')).rejects.toThrow('解密密钥');
  });

  it('用例6：旧版未加密文档（v1 或无 encryption 标记）走 Supabase Storage 兼容链路', async () => {
    const fromMock = supabase.from as unknown as MockFn;
    const storageFromMock = supabase.storage.from as unknown as MockFn;

    // 文档无 encryption 标记（旧版）
    const select = vi.fn().mockReturnThis();
    const eq = vi.fn().mockReturnThis();
    const single = vi.fn().mockResolvedValue({
      data: {
        path: 'user-1/legacy-doc.docx',
        metadata: {
          latestVersion: 'V1.0.0',
          latestRemark: '旧版文档',
          selectedKeys: ['a', 'b'],
          // 无 encryption 字段
        },
      },
      error: null,
    });
    fromMock.mockReturnValue({ select, eq, single });

    const legacyBlob = new Blob(['legacy-docx-content'], {
      type: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
    });
    const download = vi.fn().mockResolvedValue({ data: legacyBlob, error: null });
    storageFromMock.mockReturnValue({ download });

    const result = await loadPersonalDocument('user-1', 'legacy-doc');

    // 应走 Storage 路径，不调用 R2 / 解密
    expect(download).toHaveBeenCalledWith('user-1/legacy-doc.docx');
    expect(supabase.functions.invoke).not.toHaveBeenCalled();
    expect(vi.mocked(encryptionService.decryptDocumentChunked)).not.toHaveBeenCalled();

    expect(result.file).toBeInstanceOf(File);
    expect(result.file.name).toBe('legacy-doc.docx');
    expect(result.version).toBe('V1.0.0');
    expect(result.remark).toBe('旧版文档');
    expect(result.selectedKeys).toEqual(['a', 'b']);
  });
});

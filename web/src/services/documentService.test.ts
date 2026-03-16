import { describe, expect, it, vi, beforeEach } from 'vitest';
import {
  savePersonalDocument,
  fetchPersonalDocuments,
  loadPersonalDocument,
} from './documentService';
import { supabase } from '../lib/supabase';

type MockFn = ReturnType<typeof vi.fn>;

vi.mock('../lib/supabase', () => ({
  supabase: {
    storage: {
      from: vi.fn(),
    },
    from: vi.fn(),
  },
}));

const createInsertBuilder = () => {
  const select = vi.fn().mockReturnThis();
  const single = vi.fn().mockResolvedValue({
    data: { id: 'doc-1' },
    error: null,
  });
  const insert = vi.fn(() => ({
    select,
    single,
  }));
  return { insert, select, single };
};

const createUpdateBuilder = () => {
  const select = vi.fn().mockReturnThis();
  const single = vi.fn().mockResolvedValue({
    data: { id: 'doc-2' },
    error: null,
  });
  const eq = vi.fn().mockReturnThis();
  const update = vi.fn(() => ({
    eq,
    select,
    single,
  }));
  return { update, eq, select, single };
};

const createMetadataBuilder = () => {
  const select = vi.fn().mockReturnThis();
  const single = vi.fn().mockResolvedValue({
    data: { metadata: { versions: [] } },
    error: null,
  });
  const eq = vi.fn().mockReturnThis();
  return { select, single, eq };
};

const resetSupabaseMocks = () => {
  const storageFromMock = supabase.storage.from as unknown as MockFn;
  const fromMock = supabase.from as unknown as MockFn;
  storageFromMock.mockReset();
  fromMock.mockReset();
};

describe('savePersonalDocument', () => {
  beforeEach(() => {
    resetSupabaseMocks();
  });

  it('创建新文档并返回文档 id', async () => {
    const upload = vi.fn().mockResolvedValue({ data: {}, error: null });
    const storageFromMock = supabase.storage.from as unknown as MockFn;
    const fromMock = supabase.from as unknown as MockFn;
    storageFromMock.mockReturnValue({
      upload,
    });
    const insertBuilder = createInsertBuilder();

    fromMock.mockImplementation((table: string) => {
      if (table === 'documents') {
        return {
          insert: insertBuilder.insert,
        };
      }
      return {};
    });

    const blob = new Blob(['test'], { type: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document' });

    const result = await savePersonalDocument({
      userId: 'user-1',
      authorEmail: 'tester@example.com',
      blob,
      fileName: 'test.docx',
      version: 'V1.0.0',
      remark: '第一次保存',
      selectedKeys: ['k1', 'k2'],
    });

    expect(upload).toHaveBeenCalledTimes(1);
    expect(fromMock).toHaveBeenCalledWith('documents');
    expect(insertBuilder.insert).toHaveBeenCalledTimes(1);
    const insertCalls = insertBuilder.insert.mock.calls as unknown as unknown[][];
    const insertArg = insertCalls[0][0] as {
        owner_id: string;
        encrypted_title: string;
        size: number;
        type: string;
        path: string;
        metadata: {
          latestVersion: string;
          latestRemark: string;
          versions: Array<{
            version: string;
            remark: string;
            author: string | null;
            createdAt: string;
          }>;
          selectedKeys: string[];
        };
      };
    expect(insertArg.owner_id).toBe('user-1');
    expect(insertArg.encrypted_title).toBe('test.docx');
    expect(insertArg.size).toBe(blob.size);
    expect(insertArg.type).toBe('docx');
    expect(insertArg.path).toMatch(/user-1\//);
    expect(insertArg.metadata.latestVersion).toBe('V1.0.0');
    expect(insertArg.metadata.latestRemark).toBe('第一次保存');
    expect(Array.isArray(insertArg.metadata.versions)).toBe(true);
    expect(insertArg.metadata.versions.length).toBe(1);
    expect(insertArg.metadata.versions[0].version).toBe('V1.0.0');
    expect(insertArg.metadata.versions[0].remark).toBe('第一次保存');
    expect(insertArg.metadata.versions[0].author).toBe('tester@example.com');
    expect(insertArg.metadata.selectedKeys).toEqual(['k1', 'k2']);
    expect((insertArg.metadata as any).encryption).toEqual({ enabled: true, version: 1 });
    expect(result.documentId).toBe('doc-1');
  });

  it('更新已有文档并返回文档 id', async () => {
    const upload = vi.fn().mockResolvedValue({ data: {}, error: null });
    const storageFromMock = supabase.storage.from as unknown as MockFn;
    const fromMock = supabase.from as unknown as MockFn;
    storageFromMock.mockReturnValue({
      upload,
    });
    const updateBuilder = createUpdateBuilder();
    const metadataBuilder = createMetadataBuilder();

    fromMock.mockImplementation((table: string) => {
      if (table === 'documents') {
        return {
          select: metadataBuilder.select,
          eq: metadataBuilder.eq,
          single: metadataBuilder.single,
          update: updateBuilder.update,
        };
      }
      return {};
    });

    const blob = new Blob(['test2'], { type: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document' });

    const result = await savePersonalDocument({
      userId: 'user-2',
      authorEmail: 'tester2@example.com',
      blob,
      fileName: 'test.docx',
      documentId: 'doc-2',
      version: 'V1.1.0',
      remark: '第二次保存',
      selectedKeys: ['k3'],
    });

    expect(upload).toHaveBeenCalledTimes(1);
    expect(fromMock).toHaveBeenCalledWith('documents');
    expect(updateBuilder.update).toHaveBeenCalledTimes(1);
    const updateCalls = updateBuilder.update.mock.calls as unknown as unknown[][];
    const updateArg = updateCalls[0][0] as {
        encrypted_title: string;
        size: number;
        type: string;
        path: string;
        metadata: {
          latestVersion: string;
          latestRemark: string;
          versions: Array<{
            version: string;
            remark: string;
            author: string | null;
            createdAt: string;
          }>;
          selectedKeys: string[];
        };
      };
    expect(updateArg.encrypted_title).toBe('test.docx');
    expect(updateArg.size).toBe(blob.size);
    expect(updateArg.type).toBe('docx');
    expect(updateArg.path).toMatch(/user-2\//);
    expect(updateArg.metadata.latestVersion).toBe('V1.1.0');
    expect(updateArg.metadata.latestRemark).toBe('第二次保存');
    expect(Array.isArray(updateArg.metadata.versions)).toBe(true);
    expect(updateArg.metadata.versions.length).toBeGreaterThanOrEqual(1);
    expect(updateArg.metadata.selectedKeys).toEqual(['k3']);
    expect((updateArg.metadata as any).encryption).toEqual({ enabled: true, version: 1 });
    const eqCalls = updateBuilder.eq.mock.calls as [string, string][];
    expect(eqCalls[0]).toEqual(['id', 'doc-2']);
    expect(eqCalls[1]).toEqual(['owner_id', 'user-2']);
    expect(result.documentId).toBe('doc-2');
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
          size: 1024,
          path: 'user-1/doc-1.docx',
          created_at: '2025-01-01T00:00:00Z',
          updated_at: '2025-01-02T00:00:00Z',
          metadata: {
            latestVersion: 'V1.0.0',
            latestRemark: '第一次保存',
            versions: [],
            encryption: {
              enabled: true,
              version: 1,
            },
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

    fromMock.mockReturnValue({
      select,
      eq,
      order,
    });

    const result = await fetchPersonalDocuments('user-1');

    expect(fromMock).toHaveBeenCalledWith('documents');
    expect(select).toHaveBeenCalledTimes(1);
    expect(eq).toHaveBeenCalledWith('owner_id', 'user-1');
    expect(order).toHaveBeenCalledWith('updated_at', { ascending: false });

    expect(result).toHaveLength(1);
    expect(result[0]).toMatchObject({
      id: 'doc-1',
      name: 'doc-1.docx',
      size: 1024,
      createdAt: '2025-01-01T00:00:00Z',
      updatedAt: '2025-01-02T00:00:00Z',
      version: 'V1.0.0',
      remark: '第一次保存',
    });
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

    fromMock.mockReturnValue({
      select,
      eq,
      single,
    });

    const blob = new Blob(['dummy'], {
      type: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
    });

    const download = vi.fn().mockResolvedValue({
      data: blob,
      error: null,
    });

    storageFromMock.mockReturnValue({
      download,
    });

    const result = await loadPersonalDocument('user-1', 'doc-1');

    expect(fromMock).toHaveBeenCalledWith('documents');
    expect(select).toHaveBeenCalledTimes(1);
    const eqCalls = eq.mock.calls as [string, string][];
    expect(eqCalls[0]).toEqual(['id', 'doc-1']);
    expect(eqCalls[1]).toEqual(['owner_id', 'user-1']);
    expect(download).toHaveBeenCalledWith('user-1/doc-1.docx');

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

    fromMock.mockReturnValue({
      select,
      eq,
      single,
    });

    await expect(loadPersonalDocument('user-1', 'doc-missing')).rejects.toThrow(
      'not found',
    );
  });
});

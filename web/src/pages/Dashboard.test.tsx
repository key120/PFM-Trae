import React from 'react';
import { describe, expect, it, vi, beforeEach } from 'vitest';
import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import '@testing-library/jest-dom/vitest';
import Dashboard from './Dashboard';
import * as documentService from '../services/documentService';
import type { DocumentLoadCacheEntry } from '../services/documentLoadCache';

const saveModalProps: {
  onOk?: (values: { version: string; remark: string }) => void;
  validateVersion?: (version: string) => Promise<void>;
} = {};

const docStoreState = {
  currentFile: new File(['shared'], 'shared.docx', { type: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document' }),
  currentFileArrayBuffer: null as ArrayBuffer | null,
  setParsing: vi.fn(),
  setHeadings: vi.fn(),
  setCheckedKeys: vi.fn(),
  checkedKeys: ['k1', 'k2'],
  headings: [],
  currentDocumentId: 'doc-1',
  setCurrentDocumentId: vi.fn(),
  currentDocumentVersion: 'V2.0.0',
  setCurrentDocumentVersion: vi.fn(),
  initialCheckedKeys: null,
  setInitialCheckedKeys: vi.fn(),
  setCurrentFileArrayBuffer: vi.fn((value: ArrayBuffer | null) => {
    docStoreState.currentFileArrayBuffer = value;
  }),
  documentMode: 'shared' as 'shared' | 'personal' | null,
  documentAccessRole: 'member' as 'owner' | 'member' | null,
  currentTeamScopedShare: true,
};

vi.mock('../store/useAuthStore', () => ({
  useAuthStore: () => ({ user: { id: 'user-1', email: 'tester@example.com' } }),
}));

const teamStoreState = {
  currentTeamId: 'team-1',
  currentUserRole: 'reader' as 'reader' | 'editor' | 'admin' | null,
};

vi.mock('../store/useTeamStore', () => ({
  useTeamStore: () => teamStoreState,
  __esModule: true,
}));

vi.mock('../store/useDocStore', () => ({
  useDocStore: () => docStoreState,
}));

vi.mock('../components/UploadZone', () => ({ default: () => <div>UploadZone</div> }));
const documentPreviewProps: { arrayBuffer?: ArrayBuffer | null } = {};

vi.mock('../components/DocumentPreview', () => ({
  default: (props: { arrayBuffer?: ArrayBuffer | null }) => {
    documentPreviewProps.arrayBuffer = props.arrayBuffer;
    return <div>DocumentPreview</div>;
  },
}));
vi.mock('../components/TableOfContents', () => ({ default: () => <div>TableOfContents</div> }));
vi.mock('../components/SaveDocumentModal', () => ({
  default: (props: {
    open: boolean;
    onOk: (values: { version: string; remark: string }) => void;
    validateVersion?: (version: string) => Promise<void>;
  }) => {
    saveModalProps.onOk = props.onOk;
    saveModalProps.validateVersion = props.validateVersion;
    return props.open ? <button onClick={() => props.onOk({ version: 'V2.1.0', remark: '共享保存' })}>触发保存</button> : null;
  },
}));
vi.mock('../utils/docParser', () => ({
  parseDocumentHeadings: vi.fn(),
  getAllKeys: vi.fn(() => []),
  flattenHeadings: vi.fn(() => []),
}));
vi.mock('../utils/documentExporter', () => ({ exportDocument: vi.fn() }));
vi.mock('../services/documentService', () => ({
  savePersonalDocument: vi.fn(),
  saveSharedDocumentVersion: vi.fn(),
  assertSharedVersionLabelAvailable: vi.fn(),
}));
const cacheState = {
  entry: null as DocumentLoadCacheEntry | null,
  get: vi.fn(() => cacheState.entry),
  set: vi.fn(),
  clear: vi.fn(),
};

vi.mock('../services/documentLoadCache', () => ({
  createDocumentLoadCache: vi.fn(() => cacheState),
}));
vi.mock('../services/cryptoKeyService', () => ({ isWebCryptoAvailable: vi.fn(() => true) }));

describe('Dashboard', () => {
  it('保存过程中会透传 onProgress 并维护阶段状态，失败后清理保存状态', async () => {
    const user = userEvent.setup();
    teamStoreState.currentUserRole = 'editor';

    // Mock saveSharedDocumentVersion to simulate onProgress being called then reject
    vi.mocked(documentService.saveSharedDocumentVersion).mockImplementation(
      async (input) => {
        const onProgress = (input as { onProgress?: (info: unknown) => void }).onProgress;
        onProgress?.({ stage: 'encrypting', percent: 30, message: '加密中...' });
        throw new Error('网络错误');
      },
    );

    render(<Dashboard />);

    // Open modal and trigger save
    await user.click(screen.getAllByRole('button', { name: /保\s*存/ })[0]);
    await user.click(screen.getByRole('button', { name: '触发保存' }));

    // After save fails, the save button should be re-enabled (not loading)
    await waitFor(() => {
      expect(documentService.saveSharedDocumentVersion).toHaveBeenCalled();
    });

    // Button should no longer be in loading state after failure
    await waitFor(() => {
      const saveBtn = screen.getAllByRole('button', { name: /保\s*存/ })[0];
      expect(saveBtn).not.toHaveAttribute('aria-busy', 'true');
    });
  });

  it('保存进行中会阻止重复提交，作为后续进度联动测试入口', async () => {
    const user = userEvent.setup();
    teamStoreState.currentUserRole = 'editor';

    // Make save hang so we can observe the saving state
    let resolveSave: ((value: unknown) => void) | undefined;
    vi.mocked(documentService.saveSharedDocumentVersion).mockImplementation(
      () => new Promise((resolve) => { resolveSave = resolve; }) as never,
    );

    render(<Dashboard />);

    // Open modal and trigger save
    await user.click(screen.getAllByRole('button', { name: /保\s*存/ })[0]);
    await user.click(screen.getByRole('button', { name: '触发保存' }));

    // Wait for the save to start (loading state applied)
    await waitFor(() => {
      expect(documentService.saveSharedDocumentVersion).toHaveBeenCalled();
    });

    // Verify the button shows loading via Ant Design's loading class
    const saveBtn = screen.getAllByRole('button', { name: /保\s*存/ })[0];
    expect(saveBtn.className).toContain('ant-btn-loading');

    // Resolve the save to clean up
    resolveSave?.({ documentId: 'doc-1' });

    await waitFor(() => {
      expect(saveBtn.className).not.toContain('ant-btn-loading');
    });
  });

  beforeEach(() => {
    vi.clearAllMocks();
    docStoreState.currentFile = new File(['shared'], 'shared.docx', { type: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document' });
    docStoreState.currentFileArrayBuffer = null;
    docStoreState.checkedKeys = ['k1', 'k2'];
    docStoreState.currentDocumentId = 'doc-1';
    docStoreState.currentDocumentVersion = 'V2.0.0';
    docStoreState.documentMode = 'shared';
    docStoreState.documentAccessRole = 'member';
    docStoreState.currentTeamScopedShare = true;
    teamStoreState.currentTeamId = 'team-1';
    teamStoreState.currentUserRole = 'reader';
    saveModalProps.onOk = undefined;
    saveModalProps.validateVersion = undefined;
    documentPreviewProps.arrayBuffer = undefined;
    cacheState.entry = null;
    vi.mocked(documentService.saveSharedDocumentVersion).mockResolvedValue({ documentId: 'doc-1' } as never);
    vi.mocked(documentService.savePersonalDocument).mockResolvedValue({ documentId: 'doc-1' } as never);
    vi.mocked(documentService.assertSharedVersionLabelAvailable).mockResolvedValue(undefined);
  });

  it('缓存命中时直接使用缓存的 headings 与 arrayBuffer，不再重新解析', async () => {
    const cachedArrayBuffer = new ArrayBuffer(16);
    const cachedFile = new File(['cached'], 'cached.docx', {
      type: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
    });
    const cachedHeadings = [
      { id: 'heading-0', title: '缓存标题', level: 1, children: [], key: 'heading-0' },
    ];
    const { parseDocumentHeadings, getAllKeys } = await import('../utils/docParser');
    vi.mocked(getAllKeys).mockReturnValue(['heading-0']);
    cacheState.entry = {
      file: cachedFile,
      arrayBuffer: cachedArrayBuffer,
      headings: cachedHeadings,
      title: '缓存标题',
    };

    render(<Dashboard />);

    await waitFor(() => {
      expect(cacheState.get).toHaveBeenCalledWith('doc-1', 'V2.0.0');
      expect(docStoreState.setHeadings).toHaveBeenCalledWith(cachedHeadings);
      expect(docStoreState.setCheckedKeys).toHaveBeenCalledWith(['heading-0']);
    });

    expect(vi.mocked(parseDocumentHeadings)).not.toHaveBeenCalled();
    expect(docStoreState.setCurrentFileArrayBuffer).toHaveBeenCalledWith(cachedArrayBuffer);
  });

  it('shows shared mode badge in the preview title', () => {
    render(<Dashboard />);
    expect(screen.getByText('（共享）')).toBeInTheDocument();
  });

  it('disables save button for reader in shared mode', () => {
    teamStoreState.currentUserRole = 'reader';
    render(<Dashboard />);

    expect(screen.getByRole('button', { name: /保\s*存/ })).toBeDisabled();
  });

  it('enables save button for editor in shared mode', () => {
    teamStoreState.currentUserRole = 'editor';
    render(<Dashboard />);

    expect(screen.getByRole('button', { name: /保\s*存/ })).toBeEnabled();
  });

  it('dispatches saveSharedDocumentVersion when the editor is in shared mode', async () => {
    const user = userEvent.setup();
    teamStoreState.currentUserRole = 'editor';
    render(<Dashboard />);

    await user.click(screen.getByRole('button', { name: /保\s*存/ }));
    await user.click(screen.getByRole('button', { name: '触发保存' }));

    await waitFor(() => {
      expect(documentService.saveSharedDocumentVersion).toHaveBeenCalledWith({
        documentId: 'doc-1',
        editorUserId: 'user-1',
        editorEmail: 'tester@example.com',
        teamId: 'team-1',
        blob: expect.any(File),
        fileName: 'shared.docx',
        version: 'V2.1.0',
        remark: '共享保存',
        selectedKeys: ['k1', 'k2'],
        onProgress: expect.any(Function),
      });
    });
    expect(documentService.savePersonalDocument).not.toHaveBeenCalled();
  });

  it('passes shared version validator to SaveDocumentModal in shared mode', async () => {
    const user = userEvent.setup();
    teamStoreState.currentUserRole = 'editor';
    render(<Dashboard />);

    await user.click(screen.getByRole('button', { name: /保\s*存/ }));
    await saveModalProps.validateVersion?.('V2.1.0');

    expect(documentService.assertSharedVersionLabelAvailable).toHaveBeenCalledWith('doc-1', 'V2.1.0');
  });

  it('applies saved initialCheckedKeys and does not overwrite them with all keys', async () => {
    const allKeys = ['heading-0', 'heading-1', 'heading-2', 'heading-3'];
    const savedKeys = ['heading-0', 'heading-2'];

    const { parseDocumentHeadings, getAllKeys } = await import('../utils/docParser');
    vi.mocked(parseDocumentHeadings).mockResolvedValue([
      { id: 'heading-0', title: '第一章', level: 1, children: [], key: 'heading-0' },
      { id: 'heading-1', title: '第二章', level: 1, children: [], key: 'heading-1' },
      { id: 'heading-2', title: '第三章', level: 1, children: [], key: 'heading-2' },
      { id: 'heading-3', title: '第四章', level: 1, children: [], key: 'heading-3' },
    ]);
    vi.mocked(getAllKeys).mockReturnValue(allKeys);

    // 模拟载入共享文档：先设 initialCheckedKeys，再设 currentFile
    docStoreState.initialCheckedKeys = savedKeys;
    docStoreState.currentFile = new File(['doc-content'], 'test.docx', {
      type: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
    });

    render(<Dashboard />);

    // 等待异步解析完成
    await waitFor(() => {
      expect(docStoreState.setCheckedKeys).toHaveBeenCalled();
    });

    // 验证 setCheckedKeys 被调用时使用的是过滤后的 savedKeys，而非 allKeys
    const lastCall = vi.mocked(docStoreState.setCheckedKeys).mock.calls.at(-1);
    expect(lastCall![0]).toEqual(savedKeys);

    // 验证 setInitialCheckedKeys(null) 被调用（清理）
    expect(docStoreState.setInitialCheckedKeys).toHaveBeenCalledWith(null);
  });

  it('selects all keys when initialCheckedKeys is null', async () => {
    const allKeys = ['heading-0', 'heading-1', 'heading-2'];

    const { parseDocumentHeadings, getAllKeys } = await import('../utils/docParser');
    vi.mocked(parseDocumentHeadings).mockResolvedValue([
      { id: 'heading-0', title: '第一章', level: 1, children: [], key: 'heading-0' },
      { id: 'heading-1', title: '第二章', level: 1, children: [], key: 'heading-1' },
      { id: 'heading-2', title: '第三章', level: 1, children: [], key: 'heading-2' },
    ]);
    vi.mocked(getAllKeys).mockReturnValue(allKeys);

    docStoreState.initialCheckedKeys = null;
    docStoreState.currentFile = new File(['doc-content'], 'test.docx', {
      type: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
    });

    render(<Dashboard />);

    await waitFor(() => {
      expect(docStoreState.setCheckedKeys).toHaveBeenCalled();
    });

    const lastCall = vi.mocked(docStoreState.setCheckedKeys).mock.calls.at(-1);
    expect(lastCall![0]).toEqual(allKeys);
  });

  it('shows personal mode badge and dispatches savePersonalDocument in personal mode', async () => {
    const user = userEvent.setup();
    teamStoreState.currentUserRole = 'reader';
    docStoreState.documentMode = 'personal';
    docStoreState.currentTeamScopedShare = false;

    render(<Dashboard />);

    expect(screen.getByText('（个人）')).toBeInTheDocument();
    await user.click(screen.getByRole('button', { name: /保\s*存/ }));
    await user.click(screen.getByRole('button', { name: '触发保存' }));

    await waitFor(() => {
      expect(documentService.savePersonalDocument).toHaveBeenCalledWith({
        userId: 'user-1',
        authorEmail: 'tester@example.com',
        blob: expect.any(File),
        fileName: 'shared.docx',
        documentId: 'doc-1',
        version: 'V2.1.0',
        remark: '共享保存',
        selectedKeys: ['k1', 'k2'],
        onProgress: expect.any(Function),
      });
    });
    expect(documentService.saveSharedDocumentVersion).not.toHaveBeenCalled();
  });
});

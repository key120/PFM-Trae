import React from 'react';
import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import '@testing-library/jest-dom/vitest';
import { describe, expect, it, vi, beforeEach } from 'vitest';
import SharedDocumentList from './SharedDocumentList';
import * as documentService from '../services/documentService';
import * as teamService from '../services/teamService';
import type { SharedDocumentCard } from '../services/documentService';
import type { TeamMemberSummary } from '../services/teamService';

const setFile = vi.fn();
const setCurrentDocumentId = vi.fn();
const setCurrentDocumentVersion = vi.fn();
const setInitialCheckedKeys = vi.fn();
const setDocumentMode = vi.fn();
const setDocumentAccessRole = vi.fn();
const setCurrentTeamScopedShare = vi.fn();
const authState = { user: { id: 'user-1', email: 'tester@example.com' } };
const teamState = { currentTeamId: 'team-1' };

const mockTeamMembers: TeamMemberSummary[] = [
  { id: 'member-1', userId: 'member-1-user', name: '成员 1', email: 'member1@example.com', role: 'reader', groupId: null, groupName: null },
  { id: 'member-2', userId: 'member-2-user', name: '成员 2', email: 'member2@example.com', role: 'reader', groupId: null, groupName: null },
];

vi.mock('../store/useAuthStore', () => ({
  useAuthStore: () => authState,
}));

vi.mock('../store/useTeamStore', () => ({
  useTeamStore: () => teamState,
}));

vi.mock('../store/useDocStore', () => ({
  useDocStore: () => ({
    setFile,
    setCurrentDocumentId,
    setCurrentDocumentVersion,
    setInitialCheckedKeys,
    setDocumentMode,
    setDocumentAccessRole,
    setCurrentTeamScopedShare,
  }),
}));

vi.mock('../services/documentService');
vi.mock('../services/teamService', () => ({
  fetchTeamMembers: vi.fn(),
}));
vi.mock('../services/cryptoKeyService', () => ({
  ensureUserKeyPair: vi.fn(),
  restoreUserPrivateKey: vi.fn(),
}));
vi.mock('antd', async () => {
  const actual = await vi.importActual<typeof import('antd')>('antd');
  return {
    ...actual,
    Dropdown: ({ children, menu }: { children: React.ReactNode; menu?: { items?: Array<{ key: string; label: React.ReactNode }> } }) => (
      <div>
        {children}
        {menu?.items?.map((item) => (
          <div key={item.key}>{item.label}</div>
        ))}
      </div>
    ),
  };
});

describe('SharedDocumentList', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.mocked(teamService.fetchTeamMembers).mockResolvedValue(mockTeamMembers);
    vi.mocked(documentService.unshareDocument).mockResolvedValue(undefined as never);
  });

  it('renders owner shared cards with cancel-share and member cards with load only', async () => {
    const sharedDocuments: SharedDocumentCard[] = [
      {
        id: 'doc-owner',
        name: '我共享的文档',
        size: 1024,
        sharedAt: '2026-05-01T00:00:00Z',
        sharedBy: 'tester@example.com',
        version: 'V2.0.0',
        versions: [{ version: 'V2.0.0', remark: 'owner', author: 'tester@example.com', createdAt: '2026-05-01T00:00:00Z', sizeBytes: 1024 }],
        isOwner: true,
      },
      {
        id: 'doc-member',
        name: '共享给我的文档',
        size: 2048,
        sharedAt: '2026-05-02T00:00:00Z',
        sharedBy: 'owner@example.com',
        version: 'V3.0.0',
        versions: [{ version: 'V3.0.0', remark: 'member', author: 'owner@example.com', createdAt: '2026-05-02T00:00:00Z', sizeBytes: 2048 }],
        isOwner: false,
      },
    ];

    vi.mocked(documentService.fetchSharedDocumentsForCurrentTeam).mockResolvedValue(sharedDocuments);

    render(<SharedDocumentList open />);

    await waitFor(() => {
      expect(screen.getByText('我共享的文档')).toBeInTheDocument();
      expect(screen.getByText('共享给我的文档')).toBeInTheDocument();
    });

    expect(screen.getByRole('button', { name: '取消共享' })).toBeInTheDocument();
    expect(screen.getAllByRole('button', { name: /载\s*入/ })).toHaveLength(2);
  });

  it('loads a shared document into shared mode and shows version dropdown details', async () => {
    const user = userEvent.setup();

    const sharedDocuments: SharedDocumentCard[] = [
      {
        id: 'doc-owner',
        name: '我共享的文档',
        size: 1024,
        sharedAt: '2026-05-01T00:00:00Z',
        sharedBy: 'tester@example.com',
        version: 'V2.0.0',
        versions: [{ version: 'V2.0.0', remark: '共享修改', author: 'tester@example.com', createdAt: '2026-05-01T00:00:00Z', sizeBytes: 1024 }],
        isOwner: true,
      },
    ];

    vi.mocked(documentService.fetchSharedDocumentsForCurrentTeam).mockResolvedValue(sharedDocuments);

    vi.mocked(documentService.loadSharedDocument).mockResolvedValue({
      file: new File(['shared'], 'shared.docx', { type: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document' }),
      version: 'V2.0.0',
      remark: '共享修改',
      selectedKeys: ['k1'],
    });

    render(<SharedDocumentList open />);

    await waitFor(() => expect(screen.getByText('我共享的文档')).toBeInTheDocument());

    await user.click(screen.getByText('版本号：V2.0.0'));
    expect(await screen.findByText('作者：tester@example.com')).toBeInTheDocument();

    await user.click(screen.getByRole('button', { name: /载\s*入/ }));

    await waitFor(() => {
      expect(setDocumentMode).toHaveBeenCalledWith('shared');
      expect(setDocumentAccessRole).toHaveBeenCalledWith('owner');
      expect(setCurrentTeamScopedShare).toHaveBeenCalledWith(true);
    });
  });

  it('载入共享文档时显示当前卡片的进度条', async () => {
    const user = userEvent.setup();

    const sharedDocuments: SharedDocumentCard[] = [
      {
        id: 'doc-owner',
        name: '我共享的文档',
        size: 1024,
        sharedAt: '2026-05-01T00:00:00Z',
        sharedBy: 'tester@example.com',
        version: 'V2.0.0',
        versions: [{ version: 'V2.0.0', remark: '共享修改', author: 'tester@example.com', createdAt: '2026-05-01T00:00:00Z', sizeBytes: 1024 }],
        isOwner: true,
      },
    ];

    vi.mocked(documentService.fetchSharedDocumentsForCurrentTeam).mockResolvedValue(sharedDocuments);
    vi.mocked(documentService.loadSharedDocument).mockImplementation(() => new Promise(() => undefined));

    render(<SharedDocumentList open />);

    await waitFor(() => expect(screen.getByText('我共享的文档')).toBeInTheDocument());

    expect(screen.queryByRole('progressbar')).not.toBeInTheDocument();

    await user.click(screen.getByRole('button', { name: /载\s*入/ }));

    await waitFor(() => {
      expect(screen.getByRole('progressbar')).toBeInTheDocument();
    });
  });
});

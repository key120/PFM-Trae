import React, { useEffect, useState } from 'react';
import { Alert, Button, Card, Dropdown, Empty, Skeleton, Tag, Typography, message } from 'antd';
import { useAuthStore } from '../store/useAuthStore';
import { useDocStore } from '../store/useDocStore';
import { useTeamStore } from '../store/useTeamStore';
import {
  fetchSharedDocumentsForCurrentTeam,
  loadSharedDocument,
  SharedDocumentCard,
  unshareDocument,
} from '../services/documentService';
import { ensureUserKeyPair, restoreUserPrivateKey } from '../services/cryptoKeyService';
import { fetchTeamMembers } from '../services/teamService';
import { useVirtualProgress } from '../hooks/useVirtualProgress';
import CardProgressBar from './CardProgressBar';

interface SharedDocumentListProps {
  open: boolean;
  onLoaded?: () => void;
}

const formatDateTime = (value: string) => {
  if (!value) return '—';
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return '—';
  return date.toLocaleString();
};

const formatSize = (value: number | null | undefined) => {
  if (value === null || value === undefined || value <= 0) return '—';
  const kb = 1024;
  const mb = kb * 1024;
  const gb = mb * 1024;
  if (value >= gb) return `${(value / gb).toFixed(1)} GB`;
  if (value >= mb) return `${(value / mb).toFixed(1)} MB`;
  if (value >= kb) return `${(value / kb).toFixed(1)} KB`;
  return `${value} B`;
};

const SharedDocumentList: React.FC<SharedDocumentListProps> = ({ open, onLoaded }) => {
  const { user } = useAuthStore();
  const userId = user?.id ?? null;
  const userEmail = user?.email ?? null;
  const { currentTeamId } = useTeamStore();
  const {
    setFile,
    setCurrentDocumentId,
    setCurrentDocumentVersion,
    setInitialCheckedKeys,
    setDocumentMode,
    setDocumentAccessRole,
    setCurrentTeamScopedShare,
  } = useDocStore();
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [documents, setDocuments] = useState<SharedDocumentCard[]>([]);
  const [loadingDocumentId, setLoadingDocumentId] = useState<string | null>(null);

  const currentLoadingDoc = documents.find((d) => d.id === loadingDocumentId);
  const { percent, message: progressMessage } = useVirtualProgress({
    fileSize: currentLoadingDoc?.size || 0,
    isActive: loadingDocumentId !== null,
    stageMessages: ['准备中...', '获取密钥...', '下载中...', '解密中...'],
  });

  useEffect(() => {
    if (!open || !userId || !currentTeamId) {
      return;
    }

    let active = true;

    const load = async () => {
      try {
        setLoading(true);
        setError(null);
        const list = await fetchSharedDocumentsForCurrentTeam(userId, currentTeamId);
        if (!active) return;
        setDocuments(list);
      } catch (e: unknown) {
        if (!active) return;
        const msg = e instanceof Error && e.message ? e.message : '加载共享文档失败';
        setError(msg);
      } finally {
        if (active) setLoading(false);
      }
    };

    const handleChanged = () => {
      if (!active || !userId || !currentTeamId) return;
      void load();
    };

    void load();
    window.addEventListener('sharedDocumentsChanged', handleChanged);

    return () => {
      active = false;
      window.removeEventListener('sharedDocumentsChanged', handleChanged);
    };
  }, [open, userId, currentTeamId]);

  const handleRetry = () => {
    if (!userId || !currentTeamId) return;
    setLoading(true);
    setError(null);
    fetchSharedDocumentsForCurrentTeam(userId, currentTeamId)
      .then((list) => setDocuments(list))
      .catch((e: unknown) => {
        const msg = e instanceof Error && e.message ? e.message : '加载共享文档失败';
        setError(msg);
      })
      .finally(() => setLoading(false));
  };

  const handleLoadDocument = async (item: SharedDocumentCard) => {
    if (!user) return;

    try {
      setLoadingDocumentId(item.id);
      await ensureUserKeyPair(user);
      try {
        const result = await loadSharedDocument(user.id, item.id);
        applyResult(result, item);
      } catch {
        await restoreUserPrivateKey();
        await ensureUserKeyPair(user);
        const result = await loadSharedDocument(user.id, item.id);
        applyResult(result, item);
      }
    } catch (err) {
      const errMsg = err instanceof Error && err.message ? err.message : '载入共享文档失败';
      console.error('[SharedDocumentList] load failed', err);
      message.error(`载入失败：${errMsg}`);
    } finally {
      setLoadingDocumentId((current) => (current === item.id ? null : current));
    }
  };

  const handleCancelShare = async (item: SharedDocumentCard) => {
    if (!currentTeamId || !item.isOwner) {
      return;
    }

    try {
      const members = await fetchTeamMembers(currentTeamId);
      const memberUserIds = Array.from(new Set(
        members
          .map((member) => member.userId)
          .filter((value): value is string => Boolean(value) && value !== userId),
      ));

      await unshareDocument(item.id, memberUserIds, currentTeamId);
      window.dispatchEvent(new Event('sharedDocumentsChanged'));
      window.dispatchEvent(new Event('personalDocumentsChanged'));
      message.success('已取消当前团队共享');
    } catch (err) {
      const errMsg = err instanceof Error && err.message ? err.message : '取消共享失败';
      message.error(errMsg);
    }
  };

  const applyResult = (result: Awaited<ReturnType<typeof loadSharedDocument>>, item: SharedDocumentCard) => {
    if (Array.isArray(result.selectedKeys)) {
      setInitialCheckedKeys(result.selectedKeys);
    } else {
      setInitialCheckedKeys(null);
    }
    setCurrentDocumentId(item.id);
    setCurrentDocumentVersion(result.version ?? null);
    setFile(result.file);
    setDocumentMode('shared');
    setDocumentAccessRole(item.isOwner ? 'owner' : 'member');
    setCurrentTeamScopedShare(true);
    message.success('已载入共享文档');
    if (onLoaded) onLoaded();
  };

  if (!open) return null;

  if (!userId) {
    return <Empty description="请登录后查看共享文档" />;
  }

  if (!currentTeamId) {
    return <Empty description="请先选择团队后查看共享文档" />;
  }

  if (loading && !error) {
    return <Skeleton active paragraph={{ rows: 3 }} />;
  }

  if (error) {
    return (
      <div>
        <Alert type="error" message="加载共享文档失败" description={error} showIcon />
        <Button type="link" onClick={handleRetry}>重试</Button>
      </div>
    );
  }

  if (!Array.isArray(documents) || documents.length === 0) {
    return (
      <Empty
        image={Empty.PRESENTED_IMAGE_SIMPLE}
        description="暂无共享文档"
      >
        <Typography.Text type="secondary" style={{ fontSize: '13px' }}>
          团队成员共享文档后，将在此显示
        </Typography.Text>
      </Empty>
    );
  }

  return (
    <div style={{ maxHeight: 'calc(100vh - 200px)', overflowY: 'auto' }}>
      {documents.map((item) => {
        const versions = Array.isArray(item.versions) ? item.versions : [];
        const versionLabel = item.version || '—';
        const latestRemark = item.remark || versions[0]?.remark || '—';
        const sharedBy = item.sharedBy || userEmail || '—';

        return (
          <Card key={item.id} size="small" style={{ marginBottom: 12 }}>
            <div style={{ display: 'flex', justifyContent: 'space-between', gap: 16 }}>
              <div style={{ flex: 1, minWidth: 0 }}>
                <div style={{ fontWeight: 500, marginBottom: 4, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
                  {item.name}
                </div>
                <div>
                  {versions.length > 0 ? (
                    <Dropdown
                      trigger={['click']}
                      menu={{
                        items: versions.map((version, index) => ({
                          key: `${item.id}-${index}`,
                          label: (
                            <div>
                              <div>
                                {version.version} {index === 0 && <Tag color="blue">最新</Tag>}
                              </div>
                              <div>备注：{version.remark || '—'}</div>
                              <div>作者：{version.author || sharedBy}</div>
                              <div>时间：{formatDateTime(version.createdAt)}</div>
                              <div>大小：{formatSize(version.sizeBytes)}</div>
                            </div>
                          ),
                        })),
                      }}
                    >
                      <Typography.Text style={{ color: '#1677ff', cursor: 'pointer', userSelect: 'none' }}>
                        版本号：{versionLabel}
                      </Typography.Text>
                    </Dropdown>
                  ) : (
                    <span>版本号：{versionLabel}</span>
                  )}
                </div>
                <div>共享者：{sharedBy}</div>
                <div>共享时间：{formatDateTime(item.sharedAt)}</div>
                <div>备注：{latestRemark}</div>
                <div>大小：{formatSize(item.size)}</div>
              </div>
              <div style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
                <Button
                  type="primary"
                  size="small"
                  loading={loadingDocumentId === item.id}
                  onClick={() => handleLoadDocument(item)}
                >
                  载入
                </Button>
                {item.isOwner && (
                  <Button size="small" onClick={() => void handleCancelShare(item)}>
                    取消共享
                  </Button>
                )}
              </div>
            </div>
            {loadingDocumentId === item.id && (
              <CardProgressBar percent={percent} message={progressMessage} visible={true} />
            )}
          </Card>
        );
      })}
    </div>
  );
};

export default SharedDocumentList;

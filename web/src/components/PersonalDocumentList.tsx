import React, { useEffect, useState } from 'react';
import { Alert, Button, Card, Dropdown, Empty, Skeleton, Tag, Typography, message, Modal } from 'antd';
import { useAuthStore } from '../store/useAuthStore';
import { useDocStore } from '../store/useDocStore';
import { fetchPersonalDocuments, loadPersonalDocument, PersonalDocument } from '../services/documentService';

interface PersonalDocumentListProps {
  open: boolean;
  loader?: (userId: string) => Promise<PersonalDocument[]>;
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

const PersonalDocumentList: React.FC<PersonalDocumentListProps> = ({ open, loader = fetchPersonalDocuments, onLoaded }) => {
  const { user } = useAuthStore();
  const { setFile, setCurrentDocumentId, setCurrentDocumentVersion, setInitialCheckedKeys } = useDocStore();
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [documents, setDocuments] = useState<PersonalDocument[]>([]);
  const [loadingDocumentId, setLoadingDocumentId] = useState<string | null>(null);
  const [shareModalDoc, setShareModalDoc] = useState<PersonalDocument | null>(null);
  const [sharedDocumentIds, setSharedDocumentIds] = useState<Set<string>>(() => new Set());

  useEffect(() => {
    if (!open || !user) {
      return;
    }

    let active = true;

    const load = async () => {
      try {
        setLoading(true);
        setError(null);
        const list = await loader(user.id);
        if (!active) {
          return;
        }
        setDocuments(list);
      } catch (e: unknown) {
        if (!active) {
          return;
        }
        const message =
          e instanceof Error && e.message ? e.message : '加载个人文档失败';
        setError(message);
      } finally {
        if (active) {
          setLoading(false);
        }
      }
    };

    const handleChanged = () => {
      if (!active || !user) {
        return;
      }
      load();
    };

    load();
    window.addEventListener('personalDocumentsChanged', handleChanged);

    return () => {
      active = false;
      window.removeEventListener('personalDocumentsChanged', handleChanged);
    };
  }, [open, user, loader]);

  const handleRetry = () => {
    if (!user) {
      return;
    }

    setLoading(true);
    setError(null);

    loader(user.id)
      .then((list) => {
        setDocuments(list);
      })
      .catch((e: unknown) => {
        const message =
          e instanceof Error && e.message ? e.message : '加载个人文档失败';
        setError(message);
      })
      .finally(() => {
        setLoading(false);
      });
  };

  const handleOpenShare = (item: PersonalDocument) => {
    setShareModalDoc(item);
    setSharedDocumentIds((prev) => {
      if (prev.has(item.id)) {
        return prev;
      }
      const next = new Set(prev);
      next.add(item.id);
      return next;
    });
  };

  const handleCancelShare = (item: PersonalDocument) => {
    setSharedDocumentIds((prev) => {
      if (!prev.has(item.id)) {
        return prev;
      }
      const next = new Set(prev);
      next.delete(item.id);
      return next;
    });
    if (shareModalDoc && shareModalDoc.id === item.id) {
      setShareModalDoc(null);
    }
  };

  const handleLoadDocument = async (item: PersonalDocument) => {
    if (!user) {
      return;
    }
    try {
      setLoadingDocumentId(item.id);
      const result = await loadPersonalDocument(user.id, item.id);
      if (Array.isArray(result.selectedKeys)) {
        setInitialCheckedKeys(result.selectedKeys);
      } else {
        setInitialCheckedKeys(null);
      }
      setFile(result.file);
      setCurrentDocumentId(item.id);
      setCurrentDocumentVersion(result.version);
      message.success('已载入文档');
      if (onLoaded) {
        onLoaded();
      }
    } catch {
      message.error('载入文档失败，请重试');
    } finally {
      setLoadingDocumentId((current) => (current === item.id ? null : current));
    }
  };

  if (!open) {
    return null;
  }

  if (!user) {
    return <Empty description="请登录后查看个人文档" />;
  }

  if (loading && !error) {
    return (
      <div>
        <Skeleton active paragraph={{ rows: 3 }} />
      </div>
    );
  }

  if (error) {
    return (
      <div>
        <Alert type="error" message="加载个人文档失败" description={error} showIcon />
        <Button type="link" onClick={handleRetry}>
          重试
        </Button>
      </div>
    );
  }

  if (!Array.isArray(documents) || documents.length === 0) {
    return <Empty description="暂无个人文档" />;
  }

  return (
    <div
      style={{
        maxHeight: 'calc(100vh - 200px)',
        overflowY: 'auto',
      }}
    >
      {documents.map((item) => {
        const versionLabel = item.version || '—';
        const author = user?.email || '当前用户';
        const remark = item.remark || '—';
        const dateTime = item.updatedAt || item.createdAt;
        const size = item.size;

        const versions = Array.isArray(item.versions) ? item.versions : [];
        const isShared = sharedDocumentIds.has(item.id);

        return (
          <Card
            key={item.id}
            size="small"
            style={{
              marginBottom: 12,
            }}
          >
            <div
              style={{
                display: 'flex',
                justifyContent: 'space-between',
                gap: 16,
              }}
            >
              <div
                style={{
                  flex: 1,
                  minWidth: 0,
                }}
              >
                <div
                  style={{
                    fontWeight: 500,
                    marginBottom: 4,
                    overflow: 'hidden',
                    textOverflow: 'ellipsis',
                    whiteSpace: 'nowrap',
                  }}
                >
                  {item.name}
                </div>
                <div>
                  {versions.length > 0 ? (
                    <Dropdown
                      trigger={['click']}
                      menu={{
                        items: versions.map((v, index) => ({
                          key: `${item.id}-${index}`,
                          label: (
                            <div>
                              <div>
                                {v.version}{' '}
                                {index === 0 && <Tag color="blue">最新</Tag>}
                              </div>
                              <div>备注：{v.remark || '—'}</div>
                              <div>作者：{v.author || author}</div>
                              <div>时间：{formatDateTime(v.createdAt)}</div>
                              <div>大小：{formatSize(v.sizeBytes)}</div>
                            </div>
                          ),
                        })),
                      }}
                    >
                      <Typography.Text
                        style={{
                          color: '#1677ff',
                          cursor: 'pointer',
                          userSelect: 'none',
                        }}
                      >
                        版本号：{versionLabel}
                      </Typography.Text>
                    </Dropdown>
                  ) : (
                    <span>版本号：{versionLabel}</span>
                  )}
                </div>
                <div>时间：{formatDateTime(dateTime)}</div>
                <div>作者：{author}</div>
                <div>备注：{remark}</div>
                <div>大小：{formatSize(size)}</div>
              </div>
              <div
                style={{
                  display: 'flex',
                  flexDirection: 'column',
                  gap: 8,
                }}
              >
                <Button
                  type="primary"
                  size="small"
                  loading={loadingDocumentId === item.id}
                  onClick={() => handleLoadDocument(item)}
                >
                  载入
                </Button>
                <Button
                  size="small"
                  onClick={() =>
                    isShared ? handleCancelShare(item) : handleOpenShare(item)
                  }
                >
                  {isShared ? '取消共享' : '共享'}
                </Button>
              </div>
            </div>
          </Card>
        );
      })}
      <Modal
        open={!!shareModalDoc}
        title="共享设置"
        onCancel={() => setShareModalDoc(null)}
        footer={
          <Button onClick={() => setShareModalDoc(null)}>
            关闭
          </Button>
        }
        maskClosable
        centered
      >
        <Typography.Paragraph type="secondary">
          共享设置功能开发中，当前仅提供入口与状态切换。
        </Typography.Paragraph>
      </Modal>
    </div>
  );
};

export default PersonalDocumentList;

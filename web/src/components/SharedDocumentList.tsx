import React, { useEffect, useState } from 'react';
import { Alert, Button, Card, Empty, Skeleton, message } from 'antd';
import { useAuthStore } from '../store/useAuthStore';
import { useDocStore } from '../store/useDocStore';
import { useTeamStore } from '../store/useTeamStore';
import {
  fetchSharedDocuments,
  loadSharedDocument,
  SharedDocument,
} from '../services/documentService';
import { ensureUserKeyPair, restoreUserPrivateKey } from '../services/cryptoKeyService';

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
  const { currentTeamId } = useTeamStore();
  const { setFile, setCurrentDocumentId, setCurrentDocumentVersion, setInitialCheckedKeys } = useDocStore();
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [documents, setDocuments] = useState<SharedDocument[]>([]);
  const [loadingDocumentId, setLoadingDocumentId] = useState<string | null>(null);
  useEffect(() => {
    if (!open || !user || !currentTeamId) {
      return;
    }

    let active = true;

    const load = async () => {
      try {
        setLoading(true);
        setError(null);
        const list = await fetchSharedDocuments(user.id, currentTeamId);
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
      if (!active || !user || !currentTeamId) return;
      load();
    };

    load();
    window.addEventListener('sharedDocumentsChanged', handleChanged);

    return () => {
      active = false;
      window.removeEventListener('sharedDocumentsChanged', handleChanged);
    };
  }, [open, user, currentTeamId]);

  const handleRetry = () => {
    if (!user || !currentTeamId) return;
    setLoading(true);
    setError(null);
    fetchSharedDocuments(user.id, currentTeamId)
      .then((list) => setDocuments(list))
      .catch((e: unknown) => {
        const msg = e instanceof Error && e.message ? e.message : '加载共享文档失败';
        setError(msg);
      })
      .finally(() => setLoading(false));
  };

  const handleLoadDocument = async (item: SharedDocument) => {
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

  const applyResult = (result: Awaited<ReturnType<typeof loadSharedDocument>>, item: SharedDocument) => {
    if (Array.isArray(result.selectedKeys)) {
      setInitialCheckedKeys(result.selectedKeys);
    } else {
      setInitialCheckedKeys(null);
    }
    setFile(result.file);
    setCurrentDocumentId(item.id);
    setCurrentDocumentVersion(result.version ?? null);
    message.success('已载入共享文档');
    if (onLoaded) onLoaded();
  };

  if (!open) return null;

  if (!user) {
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
    return <Empty description="暂无共享文档" />;
  }

  return (
    <div style={{ maxHeight: 'calc(100vh - 200px)', overflowY: 'auto' }}>
      {documents.map((item) => (
        <Card key={item.id} size="small" style={{ marginBottom: 12 }}>
          <div style={{ display: 'flex', justifyContent: 'space-between', gap: 16 }}>
            <div style={{ flex: 1, minWidth: 0 }}>
              <div style={{ fontWeight: 500, marginBottom: 4, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
                {item.name}
              </div>
              {item.version && <div>版本号：{item.version}</div>}
              <div>共享者：{item.sharedBy || '—'}</div>
              <div>共享时间：{formatDateTime(item.sharedAt)}</div>
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
            </div>
          </div>
        </Card>
      ))}
    </div>
  );
};

export default SharedDocumentList;

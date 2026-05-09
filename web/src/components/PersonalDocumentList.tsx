import React, { useEffect, useMemo, useState } from 'react';
import { Alert, Button, Card, Dropdown, Empty, Skeleton, Tag, Typography, message, Modal, Checkbox, Divider, Space } from 'antd';
import { useAuthStore } from '../store/useAuthStore';
import { useDocStore } from '../store/useDocStore';
import { useTeamStore } from '../store/useTeamStore';
import {
  fetchPersonalDocumentsForCurrentTeam,
  isDocumentSharedInTeam,
  loadPersonalDocument,
  PersonalDocument,
  shareDocument,
  unshareDocument,
} from '../services/documentService';
import { ensureUserKeyPair, restoreUserPrivateKey } from '../services/cryptoKeyService';
import { fetchTeamGroups, fetchTeamMembers, TeamGroupSummary, TeamMemberSummary } from '../services/teamService';

interface PersonalDocumentListProps {
  open: boolean;
  loader?: (userId: string) => Promise<PersonalDocument[]>;
  onLoaded?: () => void;
}

interface SelectedGroupNode {
  groupId: string;
  groupName: string;
  members: TeamMemberSummary[];
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

const PersonalDocumentList: React.FC<PersonalDocumentListProps> = ({ open, loader, onLoaded }) => {
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
  const [documents, setDocuments] = useState<PersonalDocument[]>([]);
  const [loadingDocumentId, setLoadingDocumentId] = useState<string | null>(null);

  const loadPersonalDocs = React.useCallback(
    (targetUserId: string) => {
      if (loader) {
        return loader(targetUserId);
      }
      return fetchPersonalDocumentsForCurrentTeam(targetUserId, currentTeamId);
    },
    [loader, currentTeamId],
  );
  const [shareModalDoc, setShareModalDoc] = useState<PersonalDocument | null>(null);
  const [shareStatusByDocId, setShareStatusByDocId] = useState<Record<string, boolean>>({});
  const [shareTargetLoading, setShareTargetLoading] = useState(false);
  const [shareTargetError, setShareTargetError] = useState<string | null>(null);
  const [teamGroups, setTeamGroups] = useState<TeamGroupSummary[]>([]);
  const [teamMembers, setTeamMembers] = useState<TeamMemberSummary[]>([]);
  const [selectedMemberIds, setSelectedMemberIds] = useState<string[]>([]);

  useEffect(() => {
    if (!open || !userId) {
      return;
    }

    let active = true;

    const load = async () => {
      try {
        setLoading(true);
        setError(null);
        const list = await loadPersonalDocs(userId);
        if (!active) {
          return;
        }
        setDocuments(list);

        const entries = await Promise.all(
          list.map(async (doc) => {
            if (!currentTeamId) {
              return [doc.id, false] as const;
            }
            const shared = await isDocumentSharedInTeam(doc.id, currentTeamId);
            return [doc.id, shared] as const;
          }),
        );

        if (!active) {
          return;
        }

        setShareStatusByDocId(Object.fromEntries(entries));
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
      if (!active || !userId) {
        return;
      }
      void load();
    };

    void load();
    window.addEventListener('personalDocumentsChanged', handleChanged);

    return () => {
      active = false;
      window.removeEventListener('personalDocumentsChanged', handleChanged);
    };
  }, [open, userId, currentTeamId, loadPersonalDocs]);

  const handleRetry = () => {
    if (!userId) {
      return;
    }

    setLoading(true);
    setError(null);

    loadPersonalDocs(userId)
      .then(async (list) => {
        setDocuments(list);
        const entries = await Promise.all(
          list.map(async (doc) => {
            if (!currentTeamId) {
              return [doc.id, false] as const;
            }
            const shared = await isDocumentSharedInTeam(doc.id, currentTeamId);
            return [doc.id, shared] as const;
          }),
        );
        setShareStatusByDocId(Object.fromEntries(entries));
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


  const membersByGroupId = useMemo(() => {
    const map: Record<string, TeamMemberSummary[]> = {};
    teamMembers.forEach((member) => {
      if (!member.groupId) {
        return;
      }
      if (!map[member.groupId]) {
        map[member.groupId] = [];
      }
      map[member.groupId].push(member);
    });
    return map;
  }, [teamMembers]);

  const ungroupedMembers = useMemo(
    () => teamMembers.filter((member) => !member.groupId),
    [teamMembers],
  );

  const memberById = useMemo(() => {
    const map = new Map<string, TeamMemberSummary>();
    teamMembers.forEach((member) => {
      map.set(member.id, member);
    });
    return map;
  }, [teamMembers]);

  const memberIdsByGroupId = useMemo(() => {
    const map: Record<string, string[]> = {};
    teamGroups.forEach((group) => {
      map[group.id] = (membersByGroupId[group.id] ?? []).map((member) => member.id);
    });
    return map;
  }, [membersByGroupId, teamGroups]);

  const selectedMemberIdSet = useMemo(() => new Set(selectedMemberIds), [selectedMemberIds]);

  const selectedUserMap = useMemo(() => {
    const map = new Map<string, TeamMemberSummary>();
    selectedMemberIds.forEach((memberId) => {
      const member = memberById.get(memberId);
      if (member && member.userId) {
        map.set(member.userId, member);
      }
    });
    return map;
  }, [memberById, selectedMemberIds]);

  const selectedGroupedNodes = useMemo<SelectedGroupNode[]>(() => {
    return teamGroups
      .map((group) => {
        const members = (membersByGroupId[group.id] ?? []).filter((member) => selectedMemberIdSet.has(member.id));
        return {
          groupId: group.id,
          groupName: group.name,
          members,
        };
      })
      .filter((node) => node.members.length > 0);
  }, [membersByGroupId, selectedMemberIdSet, teamGroups]);

  const selectedUngroupedMembers = useMemo(
    () => ungroupedMembers.filter((member) => selectedMemberIdSet.has(member.id)),
    [selectedMemberIdSet, ungroupedMembers],
  );

  const isGroupChecked = (groupId: string) => {
    const memberIds = memberIdsByGroupId[groupId] ?? [];
    if (memberIds.length === 0) {
      return false;
    }
    return memberIds.every((id) => selectedMemberIdSet.has(id));
  };

  const isGroupIndeterminate = (groupId: string) => {
    const memberIds = memberIdsByGroupId[groupId] ?? [];
    if (memberIds.length === 0) {
      return false;
    }
    const selectedCount = memberIds.filter((id) => selectedMemberIdSet.has(id)).length;
    return selectedCount > 0 && selectedCount < memberIds.length;
  };

  const getMemberBaseLabel = (member: TeamMemberSummary) => member.name || member.email || member.id;

  const handleOpenShare = async (item: PersonalDocument) => {
    setShareModalDoc(item);
    setSelectedMemberIds([]);

    if (!user) {
      return;
    }

    if (!currentTeamId) {
      setTeamGroups([]);
      setTeamMembers([]);
      setShareTargetError('请先选择团队后再共享文档');
      return;
    }

    setShareTargetLoading(true);
    setShareTargetError(null);
    try {
      const [groups, members] = await Promise.all([
        fetchTeamGroups(currentTeamId),
        fetchTeamMembers(currentTeamId),
      ]);
      setTeamGroups(groups);
      setTeamMembers(members.filter((member) => member.userId !== user.id));
    } catch (e) {
      const errorMessage = e instanceof Error && e.message ? e.message : '加载共享目标失败';
      setShareTargetError(errorMessage);
      setTeamGroups([]);
      setTeamMembers([]);
    } finally {
      setShareTargetLoading(false);
    }
  };

  const handleCloseShareModal = () => {
    setShareModalDoc(null);
    setShareTargetError(null);
    setSelectedMemberIds([]);
  };

  const toggleGroup = (groupId: string, checked: boolean) => {
    const groupMemberIds = memberIdsByGroupId[groupId] ?? [];
    setSelectedMemberIds((prev) => {
      const next = new Set(prev);
      if (checked) {
        groupMemberIds.forEach((id) => next.add(id));
      } else {
        groupMemberIds.forEach((id) => next.delete(id));
      }
      return Array.from(next);
    });
  };

  const toggleMember = (memberId: string, checked: boolean) => {
    setSelectedMemberIds((prev) => {
      if (checked) {
        if (prev.includes(memberId)) {
          return prev;
        }
        return [...prev, memberId];
      }
      return prev.filter((id) => id !== memberId);
    });
  };

  const handleConfirmShare = async () => {
    if (!shareModalDoc || !user || !currentTeamId) {
      return;
    }

    const selectedMemberIdSetForSubmit = new Set(selectedMemberIds);
    const expandedUserIds = Array.from(new Set(
      teamMembers
        .filter((member) => selectedMemberIdSetForSubmit.has(member.id))
        .map((member) => member.userId)
        .filter((userId): userId is string => Boolean(userId)),
    ));

    try {
      const result = await shareDocument({
        documentId: shareModalDoc.id,
        ownerUserId: user.id,
        targetUserIds: expandedUserIds,
        teamId: currentTeamId,
      });

      if (result.failed.length > 0) {
        message.warning(`部分成员共享失败（${result.failed.length}）`);
      } else {
        message.success('共享成功');
      }

      setShareStatusByDocId((prev) => ({
        ...prev,
        [shareModalDoc.id]: result.distributed.length > 0,
      }));
      window.dispatchEvent(new Event('personalDocumentsChanged'));
      window.dispatchEvent(new Event('sharedDocumentsChanged'));
      handleCloseShareModal();
    } catch (err) {
      const errMsg = err instanceof Error ? err.message : '共享失败';
      message.error(`共享失败: ${errMsg}`);
    }
  };

  const handleCancelShare = async (item: PersonalDocument) => {
    if (!currentTeamId) {
      return;
    }

    try {
      const members = await fetchTeamMembers(currentTeamId);
      const memberUserIds = Array.from(new Set(
        members
          .map((member) => member.userId)
          .filter((userId): userId is string => Boolean(userId) && userId !== user?.id),
      ));

      Modal.confirm({
        title: '确认取消共享',
        content: '将撤销当前团队全部共享成员的访问权限，是否继续？',
        onOk: async () => {
          await unshareDocument(item.id, memberUserIds, currentTeamId);
          setShareStatusByDocId((prev) => ({
            ...prev,
            [item.id]: false,
          }));
          message.success('已取消当前团队共享');
          if (shareModalDoc && shareModalDoc.id === item.id) {
            handleCloseShareModal();
          }
        },
      });
    } catch (error) {
      const errorMessage = error instanceof Error && error.message ? error.message : '取消共享失败';
      message.error(errorMessage);
    }
  };

  const handleLoadDocument = async (item: PersonalDocument) => {
    if (!user) {
      return;
    }
    const applyLoadedDocument = (result: Awaited<ReturnType<typeof loadPersonalDocument>>) => {
      if (Array.isArray(result.selectedKeys)) {
        setInitialCheckedKeys(result.selectedKeys);
      } else {
        setInitialCheckedKeys(null);
      }
      setFile(result.file);
      setCurrentDocumentId(item.id);
      setCurrentDocumentVersion(result.version);
      setDocumentMode('personal');
      setDocumentAccessRole('owner');
      setCurrentTeamScopedShare(false);
      message.success('已载入文档');
      if (onLoaded) {
        onLoaded();
      }
    };

    try {
      setLoadingDocumentId(item.id);
      await ensureUserKeyPair(user);
      try {
        const result = await loadPersonalDocument(user.id, item.id);
        applyLoadedDocument(result);
      } catch (error) {
        const errorCode =
          error && typeof error === 'object' && 'code' in error
            ? (error as { code?: string }).code
            : undefined;

        await restoreUserPrivateKey();
        await ensureUserKeyPair(user);

        if (errorCode === 'KEY_NOT_READY') {
          const retryResult = await loadPersonalDocument(user.id, item.id);
          applyLoadedDocument(retryResult);
          return;
        }

        const retryResult = await loadPersonalDocument(user.id, item.id);
        applyLoadedDocument(retryResult);
      }
    } catch (error) {
      const errorMessage =
        error instanceof Error && error.message
          ? error.message
          : '载入文档失败，请重试';
      console.error('[PersonalDocumentList] load document failed', error);
      message.error(`载入文档失败：${errorMessage}`);
    } finally {
      setLoadingDocumentId((current) => (current === item.id ? null : current));
    }
  };

  if (!open) {
    return null;
  }

  if (!userId) {
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
        <Alert type="error" title="加载个人文档失败" description={error} showIcon />
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
        const author = userEmail || '当前用户';
        const remark = item.remark || '—';
        const dateTime = item.updatedAt || item.createdAt;
        const size = item.size;

        const versions = Array.isArray(item.versions) ? item.versions : [];
        const isShared = Boolean(shareStatusByDocId[item.id]);

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
        onCancel={handleCloseShareModal}
        onOk={() => {
          void handleConfirmShare();
        }}
        okText="确认共享"
        cancelText="关闭"
        maskClosable
        centered
      >
        {shareTargetError ? (
          <Alert type="error" showIcon message={shareTargetError} />
        ) : (
          <div
            style={{
              display: 'grid',
              gridTemplateColumns: '1fr 1fr',
              gap: 16,
            }}
          >
            <div>
              <Typography.Text strong>可选目标</Typography.Text>
              <Divider style={{ margin: '8px 0' }} />
              {shareTargetLoading ? (
                <Skeleton active paragraph={{ rows: 4 }} />
              ) : (
                <Space orientation="vertical" size={8} style={{ width: '100%' }}>
                  {teamGroups.map((group) => (
                    <div key={group.id}>
                      <Checkbox
                        checked={isGroupChecked(group.id)}
                        indeterminate={isGroupIndeterminate(group.id)}
                        onChange={(e) => toggleGroup(group.id, e.target.checked)}
                      >
                        {group.name}
                      </Checkbox>
                      {(membersByGroupId[group.id] ?? []).length > 0 && (
                        <div style={{ marginLeft: 24, marginTop: 6 }}>
                          <Space orientation="vertical" size={6}>
                            {(membersByGroupId[group.id] ?? []).map((member) => (
                              <Checkbox
                                key={member.id}
                                checked={selectedMemberIdSet.has(member.id)}
                                onChange={(e) => toggleMember(member.id, e.target.checked)}
                              >
                                {getMemberBaseLabel(member)}
                              </Checkbox>
                            ))}
                          </Space>
                        </div>
                      )}
                    </div>
                  ))}

                  {ungroupedMembers.length > 0 && (
                    <div>
                      <Typography.Text type="secondary">未分组成员</Typography.Text>
                      <div style={{ marginTop: 6 }}>
                        <Space orientation="vertical" size={6}>
                          {ungroupedMembers.map((member) => (
                            <Checkbox
                              key={member.id}
                              aria-label={member.name || member.email || member.id}
                              checked={selectedMemberIdSet.has(member.id)}
                              onChange={(e) => toggleMember(member.id, e.target.checked)}
                            >
                              {getMemberBaseLabel(member)}
                            </Checkbox>
                          ))}
                        </Space>
                      </div>
                    </div>
                  )}
                </Space>
              )}
            </div>

            <div>
              <Typography.Text strong>已选目标</Typography.Text>
              <Divider style={{ margin: '8px 0' }} />
              {selectedUserMap.size === 0 ? (
                <Typography.Text type="secondary">暂无已选目标</Typography.Text>
              ) : (
                <Space orientation="vertical" size={8} style={{ width: '100%' }}>
                  {selectedGroupedNodes.map((node) => (
                    <div key={node.groupId}>
                      <Typography.Text>{node.groupName}</Typography.Text>
                      <div style={{ marginLeft: 20, marginTop: 4 }}>
                        <Space orientation="vertical" size={4}>
                          {node.members.map((member) => (
                            <span key={member.id}>{getMemberBaseLabel(member)}</span>
                          ))}
                        </Space>
                      </div>
                    </div>
                  ))}
                  {selectedUngroupedMembers.map((member) => (
                    <span key={member.id}>{getMemberBaseLabel(member)}</span>
                  ))}
                </Space>
              )}
            </div>
          </div>
        )}
      </Modal>
    </div>
  );
};

export default PersonalDocumentList;

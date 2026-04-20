import React, { useCallback, useEffect, useMemo, useState } from 'react';
import {
  Button,
  Empty,
  Input,
  Modal,
  Popconfirm,
  Select,
  Space,
  Spin,
  Table,
  Typography,
  message,
  Menu,
} from 'antd';
import { PlusOutlined, EditOutlined, DeleteOutlined } from '@ant-design/icons';
import { useAuthStore } from '../store/useAuthStore';
import {
  createGroup,
  deleteGroup,
  fetchTeamGroups,
  fetchTeamMembers,
  getCurrentUserTeamRole,
  inviteMembers,
  removeMember,
  updateGroup,
  updateMember,
  type TeamGroupSummary,
  type TeamMemberSummary,
  type TeamRole,
} from '../services/teamService';

const ROLE_LABELS: Record<TeamRole, string> = {
  reader: '只读',
  editor: '可编辑',
  admin: '管理员',
};

const EMAIL_PATTERN = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
const UNGROUPED_KEY = '__ungrouped__';

interface InviteRowState {
  key: number;
  email: string;
  name: string;
  groupId: string | null;
  role: TeamRole;
}

interface GroupDialogState {
  mode: 'create' | 'edit';
  groupId: string | null;
  name: string;
}

interface TeamInfoModalProps {
  open: boolean;
  teamId: string | null;
  onClose: () => void;
}

function createEmptyInviteRow(key: number): InviteRowState {
  return {
    key,
    email: '',
    name: '',
    groupId: null,
    role: 'reader',
  };
}

function getErrorMessage(error: unknown, fallback: string) {
  if (error instanceof Error && error.message.trim()) {
    return error.message;
  }

  return fallback;
}

const TeamInfoModal: React.FC<TeamInfoModalProps> = ({ open, teamId, onClose }) => {
  const { user } = useAuthStore();
  const [loading, setLoading] = useState(false);
  const [teamRole, setTeamRole] = useState<TeamRole | null>(null);
  const [groups, setGroups] = useState<TeamGroupSummary[]>([]);
  const [members, setMembers] = useState<TeamMemberSummary[]>([]);
  const [selectedMenuKey, setSelectedMenuKey] = useState('invite');
  const [inviteRows, setInviteRows] = useState<InviteRowState[]>([createEmptyInviteRow(0)]);
  const [nextInviteRowKey, setNextInviteRowKey] = useState(1);
  const [inviteErrors, setInviteErrors] = useState<Record<number, string>>({});
  const [inviteSubmitting, setInviteSubmitting] = useState(false);
  const [editingMember, setEditingMember] = useState<TeamMemberSummary | null>(null);
  const [editingMemberName, setEditingMemberName] = useState('');
  const [editingMemberGroupId, setEditingMemberGroupId] = useState<string | null>(null);
  const [editingMemberRole, setEditingMemberRole] = useState<TeamRole>('reader');
  const [memberSubmitting, setMemberSubmitting] = useState(false);
  const [groupDialog, setGroupDialog] = useState<GroupDialogState | null>(null);
  const [groupSubmitting, setGroupSubmitting] = useState(false);

  const isAdmin = teamRole === 'admin';

  const loadModalData = useCallback(async () => {
    if (!open || !teamId || !user?.id) {
      return;
    }

    setLoading(true);
    try {
      const [nextRole, nextGroups, nextMembers] = await Promise.all([
        getCurrentUserTeamRole(teamId, user.id),
        fetchTeamGroups(teamId),
        fetchTeamMembers(teamId),
      ]);

      setTeamRole(nextRole);
      setGroups(nextGroups);
      setMembers(nextMembers);
      setSelectedMenuKey((current) => {
        if (current === 'invite' && nextRole === 'admin') {
          return current;
        }

        if (current.startsWith('group:')) {
          const groupId = current.slice('group:'.length);
          if (groupId === UNGROUPED_KEY || nextGroups.some((group) => group.id === groupId)) {
            return current;
          }
        }

        return nextRole === 'admin' ? 'invite' : `group:${UNGROUPED_KEY}`;
      });
    } catch (error) {
      message.error(getErrorMessage(error, '加载团队信息失败'));
    } finally {
      setLoading(false);
    }
  }, [open, teamId, user?.id]);

  useEffect(() => {
    if (!open) {
      return;
    }

    void loadModalData();
  }, [loadModalData, open]);

  useEffect(() => {
    if (!open) {
      setInviteRows([createEmptyInviteRow(0)]);
      setNextInviteRowKey(1);
      setInviteErrors({});
      setEditingMember(null);
      setGroupDialog(null);
      setSelectedMenuKey('invite');
    }
  }, [open]);

  const filteredMembers = useMemo(() => {
    if (!selectedMenuKey.startsWith('group:')) {
      return members;
    }

    const groupId = selectedMenuKey.slice('group:'.length);
    if (groupId === UNGROUPED_KEY) {
      return members.filter((member) => member.groupId === null);
    }

    return members.filter((member) => member.groupId === groupId);
  }, [members, selectedMenuKey]);

  const handleAddInviteRow = () => {
    setInviteRows((current) => [...current, createEmptyInviteRow(nextInviteRowKey)]);
    setNextInviteRowKey((current) => current + 1);
  };

  const handleInviteRowChange = (key: number, field: keyof Omit<InviteRowState, 'key'>, value: string | TeamRole | null) => {
    setInviteRows((current) => current.map((row) => (row.key === key ? { ...row, [field]: value } : row)));
    setInviteErrors((current) => {
      if (!current[key] || field !== 'email') {
        return current;
      }

      const nextErrors = { ...current };
      delete nextErrors[key];
      return nextErrors;
    });
  };

  const handleRemoveInviteRow = (key: number) => {
    setInviteRows((current) => current.filter((row) => row.key !== key));
    setInviteErrors((current) => {
      const nextErrors = { ...current };
      delete nextErrors[key];
      return nextErrors;
    });
  };

  const handleSubmitInvites = async () => {
    if (!teamId || !user?.id) {
      return;
    }

    const nextErrors: Record<number, string> = {};
    for (const row of inviteRows) {
      const email = row.email.trim();
      if (!email) {
        nextErrors[row.key] = '请输入邮箱';
      } else if (!EMAIL_PATTERN.test(email)) {
        nextErrors[row.key] = '请输入有效邮箱';
      }
    }

    setInviteErrors(nextErrors);
    if (Object.keys(nextErrors).length > 0) {
      return;
    }

    setInviteSubmitting(true);
    try {
      await inviteMembers({
        teamId,
        invitedBy: user.id,
        rows: inviteRows.map((row) => ({
          email: row.email.trim(),
          name: row.name.trim(),
          groupId: row.groupId,
          role: row.role,
        })),
      });
      message.success('邀请已发送');
      setInviteRows([createEmptyInviteRow(0)]);
      setNextInviteRowKey(1);
      setInviteErrors({});
    } catch (error) {
      message.error(getErrorMessage(error, '邀请成员失败'));
    } finally {
      setInviteSubmitting(false);
    }
  };

  const openEditMemberDialog = (member: TeamMemberSummary) => {
    setEditingMember(member);
    setEditingMemberName(member.name);
    setEditingMemberGroupId(member.groupId);
    setEditingMemberRole(member.role);
  };

  const handleSubmitMemberEdit = async () => {
    if (!editingMember) {
      return;
    }

    setMemberSubmitting(true);
    try {
      await updateMember(editingMember.id, {
        name: editingMemberName,
        groupId: editingMemberGroupId,
        role: editingMemberRole,
      });
      message.success('成员已更新');
      setEditingMember(null);
      await loadModalData();
    } catch (error) {
      message.error(getErrorMessage(error, '更新成员失败'));
    } finally {
      setMemberSubmitting(false);
    }
  };

  const handleRemoveMember = async (memberId: string) => {
    try {
      await removeMember(memberId);
      message.success('成员已移除');
      await loadModalData();
    } catch (error) {
      message.error(getErrorMessage(error, '移除成员失败'));
    }
  };

  const handleOpenCreateGroup = () => {
    setGroupDialog({
      mode: 'create',
      groupId: null,
      name: '',
    });
  };

  const handleOpenEditGroup = (group: TeamGroupSummary) => {
    setGroupDialog({
      mode: 'edit',
      groupId: group.id,
      name: group.name,
    });
  };

  const handleSubmitGroupDialog = async () => {
    if (!teamId || !user?.id || !groupDialog) {
      return;
    }

    setGroupSubmitting(true);
    try {
      if (groupDialog.mode === 'create') {
        const createdGroup = await createGroup({
          teamId,
          createdBy: user.id,
          name: groupDialog.name,
        });
        setGroups((current) => [...current, createdGroup]);
        setSelectedMenuKey(`group:${createdGroup.id}`);
        message.success('成员组已创建');
      } else if (groupDialog.groupId) {
        await updateGroup(groupDialog.groupId, groupDialog.name);
        setGroups((current) => current.map((group) => (
          group.id === groupDialog.groupId
            ? { ...group, name: groupDialog.name.trim() }
            : group
        )));
        message.success('成员组已更新');
      }

      setGroupDialog(null);
    } catch (error) {
      message.error(getErrorMessage(error, groupDialog.mode === 'create' ? '创建成员组失败' : '更新成员组失败'));
    } finally {
      setGroupSubmitting(false);
    }
  };

  const handleDeleteGroup = async (groupId: string) => {
    try {
      await deleteGroup(groupId);
      setGroups((current) => current.filter((group) => group.id !== groupId));
      setSelectedMenuKey(`group:${UNGROUPED_KEY}`);
      message.success('成员组已删除');
      await loadModalData();
    } catch (error) {
      message.error(getErrorMessage(error, '删除成员组失败'));
    }
  };

  const memberColumns = [
    {
      title: '名字',
      dataIndex: 'name',
      key: 'name',
      render: (value: string) => value || '—',
    },
    {
      title: '邮箱',
      dataIndex: 'email',
      key: 'email',
    },
    {
      title: '成员组',
      dataIndex: 'groupName',
      key: 'groupName',
      render: (value: string | null) => value ?? '未分组',
    },
    {
      title: '角色',
      dataIndex: 'role',
      key: 'role',
      render: (value: TeamRole) => ROLE_LABELS[value],
    },
    {
      title: '操作',
      key: 'actions',
      render: (_: unknown, member: TeamMemberSummary) => (
        <Space>
          <Button
            disabled={!isAdmin}
            onClick={() => openEditMemberDialog(member)}
            aria-label={`编辑成员 ${member.email}`}
          >
            编辑
          </Button>
          <Popconfirm
            title="确认移除该成员吗？"
            okText="确定"
            cancelText="取消"
            onConfirm={() => handleRemoveMember(member.id)}
            disabled={!isAdmin}
          >
            <Button disabled={!isAdmin} aria-label={`删除成员 ${member.email}`}>
              删除
            </Button>
          </Popconfirm>
        </Space>
      ),
    },
  ];

  const renderInvitePanel = () => (
    <div>
      <Typography.Title level={5}>通过邮箱邀请</Typography.Title>
      <Space orientation="vertical" size={16} style={{ width: '100%' }}>
        {inviteRows.map((row, index) => (
          <div key={row.key} style={{ border: '1px solid #f0f0f0', borderRadius: 8, padding: 12 }}>
            <Space orientation="vertical" size={8} style={{ width: '100%' }}>
              <Input
                aria-label="邮箱"
                placeholder="请输入邮箱"
                value={row.email}
                status={inviteErrors[row.key] ? 'error' : undefined}
                onChange={(event) => handleInviteRowChange(row.key, 'email', event.target.value)}
              />
              {inviteErrors[row.key] ? (
                <Typography.Text type="danger">{inviteErrors[row.key]}</Typography.Text>
              ) : null}
              <Input
                aria-label="姓名"
                placeholder="请输入姓名"
                value={row.name}
                onChange={(event) => handleInviteRowChange(row.key, 'name', event.target.value)}
              />
              <Select
                aria-label="成员组"
                placeholder="请选择成员组"
                value={row.groupId ?? undefined}
                allowClear
                options={groups.map((group) => ({ label: group.name, value: group.id }))}
                onChange={(value) => handleInviteRowChange(row.key, 'groupId', value ?? null)}
              />
              <Select
                aria-label="角色"
                value={row.role}
                options={Object.entries(ROLE_LABELS).map(([value, label]) => ({ value, label }))}
                onChange={(value) => handleInviteRowChange(row.key, 'role', value as TeamRole)}
              />
              {index > 0 ? (
                <Button danger onClick={() => handleRemoveInviteRow(row.key)}>
                  删除该行
                </Button>
              ) : null}
            </Space>
          </div>
        ))}
        <Space>
          <Button onClick={handleAddInviteRow}>再加一个</Button>
          <Button type="primary" loading={inviteSubmitting} onClick={handleSubmitInvites}>
            确定
          </Button>
        </Space>
      </Space>
    </div>
  );

  const renderMemberPanel = () => (
    <div>
      <Typography.Title level={5}>成员管理</Typography.Title>
      <Table
        rowKey="id"
        pagination={{ pageSize: 10 }}
        columns={memberColumns}
        dataSource={filteredMembers}
      />
    </div>
  );

  return (
    <>
      <Modal
        open={open}
        title="团队信息"
        onCancel={onClose}
        footer={null}
        width={800}
        destroyOnHidden
      >
        {!teamId || !user?.id ? (
          <Empty description="暂无可用团队" />
        ) : loading ? (
          <div style={{ minHeight: 280, display: 'flex', alignItems: 'center', justifyContent: 'center' }}>
            <Spin />
          </div>
        ) : (
          <div style={{ display: 'flex', gap: 24, minHeight: 420 }}>
            <div style={{ width: 220, borderRight: '1px solid #f0f0f0', paddingRight: 16 }}>
              <Menu mode="inline" selectedKeys={[selectedMenuKey]} style={{ width: 200 }}>
        {isAdmin && (
          <Menu.Item key="invite" onClick={() => setSelectedMenuKey('invite')}>
            通过邮箱邀请
          </Menu.Item>
        )}
        <Menu.SubMenu
          key="members"
          title={(
            <span>
              成员管理
              <Button type="text" size="small" icon={<PlusOutlined />} style={{ marginLeft: 8 }} onClick={handleOpenCreateGroup} />
            </span>
          )}
        >
          <Menu.Item key={`group:${UNGROUPED_KEY}`} onClick={() => setSelectedMenuKey(`group:${UNGROUPED_KEY}`)}>
            未分组
          </Menu.Item>
          {groups.map((group) => (
            <Menu.Item
              key={`group:${group.id}`}
              onClick={() => setSelectedMenuKey(`group:${group.id}`)}
              style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}
            >
              <span>{group.name}</span>
              {isAdmin && (
                <span>
                  <Button type="text" size="small" icon={<EditOutlined />} onClick={(e) => { e.stopPropagation(); handleOpenEditGroup(group); }} />
                  <Popconfirm title="确认删除该成员组吗？" okText="确定" cancelText="取消" onConfirm={() => handleDeleteGroup(group.id)}>
                    <Button type="text" size="small" danger icon={<DeleteOutlined />} />
                  </Popconfirm>
                </span>
              )}
            </Menu.Item>
          ))}
        </Menu.SubMenu>
      </Menu>
            </div>
            <div style={{ flex: 1 }}>
              {selectedMenuKey === 'invite' && isAdmin ? renderInvitePanel() : renderMemberPanel()}
            </div>
          </div>
        )}
      </Modal>

      <Modal
        open={Boolean(editingMember)}
        title="编辑成员"
        onOk={handleSubmitMemberEdit}
        onCancel={() => setEditingMember(null)}
        okText="确定"
        cancelText="取消"
        confirmLoading={memberSubmitting}
        destroyOnHidden
      >
        <Space orientation="vertical" size={12} style={{ width: '100%' }}>
          <Input
            aria-label="姓名"
            placeholder="请输入姓名"
            value={editingMemberName}
            onChange={(event) => setEditingMemberName(event.target.value)}
          />
          <Select
            aria-label="成员组"
            placeholder="请选择成员组"
            value={editingMemberGroupId ?? undefined}
            allowClear
            options={groups.map((group) => ({ label: group.name, value: group.id }))}
            onChange={(value) => setEditingMemberGroupId(value ?? null)}
          />
          <Select
            aria-label="角色"
            value={editingMemberRole}
            options={Object.entries(ROLE_LABELS).map(([value, label]) => ({ value, label }))}
            onChange={(value) => setEditingMemberRole(value as TeamRole)}
          />
        </Space>
      </Modal>

      <Modal
        open={Boolean(groupDialog)}
        title={groupDialog?.mode === 'edit' ? '编辑成员组' : '新建成员组'}
        onOk={handleSubmitGroupDialog}
        onCancel={() => setGroupDialog(null)}
        okText="确定"
        cancelText="取消"
        confirmLoading={groupSubmitting}
        destroyOnHidden
      >
        <Input
          aria-label="成员组名称"
          placeholder="请输入成员组名称"
          value={groupDialog?.name ?? ''}
          onChange={(event) => {
            if (!groupDialog) {
              return;
            }
            setGroupDialog({ ...groupDialog, name: event.target.value });
          }}
        />
      </Modal>
    </>
  );
};

export default TeamInfoModal;

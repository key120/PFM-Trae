import React, { useEffect, useMemo, useState } from 'react';
import { Outlet, useNavigate } from 'react-router-dom';
import { Layout, Dropdown, Avatar, Typography, Button, Drawer, Space, Tabs, Modal, Form, Input, message, Badge, Tag } from 'antd';
import { UserOutlined, LogoutOutlined, UnorderedListOutlined, BellOutlined } from '@ant-design/icons';
import type { MenuProps } from 'antd';
import { useAuthStore } from '../store/useAuthStore';
import { useTeamStore } from '../store/useTeamStore';
import {
  acceptTeamInvitation,
  createTeam,
  fetchInvitationNotifications,
  fetchUserTeams,
  rejectTeamInvitation,
} from '../services/teamService';
import type { TeamInvitationNotification } from '../services/teamService';
import TeamInfoModal from '../components/TeamInfoModal';
import PersonalDocumentList from '../components/PersonalDocumentList';
import SharedDocumentList from '../components/SharedDocumentList';

const { Header, Content } = Layout;
const { Text } = Typography;

const getCurrentTeamStorageKey = (userId: string) => `pfm-current-team-id:${userId}`;

const getErrorMessage = (error: unknown, fallback: string) => {
  return error instanceof Error ? error.message : fallback;
};

const MainLayout: React.FC = () => {
  const { user, signOut } = useAuthStore();
  const { teams, currentTeamId, setCurrentTeamId, setTeams, addTeam } = useTeamStore();
  const navigate = useNavigate();
  const [docDrawerOpen, setDocDrawerOpen] = useState(false);
  const [docTabKey, setDocTabKey] = useState('personal');
  const [createTeamOpen, setCreateTeamOpen] = useState(false);
  const [createTeamLoading, setCreateTeamLoading] = useState(false);
  const [teamInfoOpen, setTeamInfoOpen] = useState(false);
  const [notificationDrawerOpen, setNotificationDrawerOpen] = useState(false);
  const [invitationNotifications, setInvitationNotifications] = useState<TeamInvitationNotification[]>([]);
  const [notificationActionLoadingId, setNotificationActionLoadingId] = useState<string | null>(null);
  const [teamForm] = Form.useForm<{ teamName: string }>();
  const currentTeamStorageKey = useMemo(() => (user?.id ? getCurrentTeamStorageKey(user.id) : null), [user?.id]);

  useEffect(() => {
    if (!user?.id) {
      setTeams([]);
      return;
    }

    let active = true;

    const loadTeams = async () => {
      try {
        const nextTeams = await fetchUserTeams(user.id);
        if (!active) {
          return;
        }

        const savedTeamId = currentTeamStorageKey
          ? window.localStorage.getItem(currentTeamStorageKey)
          : null;
        if (savedTeamId && nextTeams.some((team) => team.id === savedTeamId)) {
          setCurrentTeamId(savedTeamId);
        }

        setTeams(nextTeams);
      } catch (error) {
        if (!active) {
          return;
        }
        message.error(getErrorMessage(error, '加载团队失败'));
      }
    };

    void loadTeams();

    return () => {
      active = false;
    };
  }, [currentTeamStorageKey, setCurrentTeamId, setTeams, user?.id]);

  useEffect(() => {
    if (!user?.id) {
      setInvitationNotifications([]);
      return;
    }

    let active = true;

    const loadInvitationNotifications = async () => {
      try {
        const nextNotifications = await fetchInvitationNotifications(user.id, user.email ?? null);
        if (!active) {
          return;
        }
        setInvitationNotifications(nextNotifications);
      } catch (error) {
        if (!active) {
          return;
        }
        message.error(getErrorMessage(error, '加载通知失败'));
      }
    };

    void loadInvitationNotifications();

    return () => {
      active = false;
    };
  }, [user?.id, user?.email]);

  useEffect(() => {
    if (!currentTeamStorageKey) {
      return;
    }

    const storedTeamId = window.localStorage.getItem(currentTeamStorageKey);

    if (currentTeamId) {
      if (storedTeamId === currentTeamId) {
        return;
      }

      window.localStorage.setItem(currentTeamStorageKey, currentTeamId);
      return;
    }

    if (storedTeamId) {
      return;
    }

    window.localStorage.removeItem(currentTeamStorageKey);
  }, [currentTeamId, currentTeamStorageKey]);

  const handleLogout = async () => {
    await signOut();
    navigate('/login');
  };

  const handleOpenDocDrawer = () => {
    setDocTabKey('personal');
    setDocDrawerOpen(true);
  };

  const handleOpenCreateTeam = () => {
    teamForm.setFieldsValue({ teamName: '' });
    setCreateTeamOpen(true);
  };

  const handleOpenTeamInfo = () => {
    if (!hasTeams) {
      return;
    }
    setTeamInfoOpen(true);
  };

  const handleCloseTeamInfo = () => {
    setTeamInfoOpen(false);
  };

  const handleCancelCreateTeam = () => {
    setCreateTeamOpen(false);
  };

  const handleConfirmCreateTeam = async () => {
    try {
      const { teamName } = await teamForm.validateFields();
      if (!user?.id) {
        return;
      }

      setCreateTeamLoading(true);
      try {
        const createdTeam = await createTeam({
          userId: user.id,
          teamName,
        });
        addTeam(createdTeam);
        setCurrentTeamId(createdTeam.id);
        setCreateTeamOpen(false);
      } catch (error) {
        message.error(getErrorMessage(error, '创建团队失败'));
      } finally {
        setCreateTeamLoading(false);
      }
    } catch {
    }
  };

  const updateInvitationStatus = (
    notificationId: string,
    status: 'accepted' | 'rejected',
  ) => {
    setInvitationNotifications((prev) => prev.map((item) => {
      if (item.type !== 'team_invitation' || item.notificationId !== notificationId) {
        return item;
      }

      return {
        ...item,
        status,
        isRead: true,
      };
    }));
  };

  const handleAcceptInvitation = async (notification: TeamInvitationNotification) => {
    if (!user?.id || notification.type !== 'team_invitation') {
      return;
    }

    setNotificationActionLoadingId(notification.notificationId);

    try {
      await acceptTeamInvitation({
        invitationId: notification.invitationId,
      });

      const nextTeams = await fetchUserTeams(user.id);
      setTeams(nextTeams);
      setCurrentTeamId(notification.teamId);
      updateInvitationStatus(notification.notificationId, 'accepted');
    } catch (error) {
      message.error(getErrorMessage(error, '接受邀请失败'));
    } finally {
      setNotificationActionLoadingId(null);
    }
  };

  const handleRejectInvitation = async (notification: TeamInvitationNotification) => {
    if (!user?.id || notification.type !== 'team_invitation') {
      return;
    }

    setNotificationActionLoadingId(notification.notificationId);

    try {
      await rejectTeamInvitation({
        invitationId: notification.invitationId,
      });

      updateInvitationStatus(notification.notificationId, 'rejected');
    } catch (error) {
      message.error(getErrorMessage(error, '拒绝邀请失败'));
    } finally {
      setNotificationActionLoadingId(null);
    }
  };

  const hasTeams = teams.length > 0;

  const unreadNotificationCount = invitationNotifications.filter((notification) => {
    if (notification.type === 'team_invitation_result') {
      return !notification.isRead;
    }

    return !notification.isRead && notification.status === 'pending';
  }).length;

  const getNotificationText = (notification: TeamInvitationNotification) => {
    if (notification.type === 'team_invitation_result') {
      return `${notification.inviteeEmail} 已${notification.result === 'accepted' ? '接受' : '拒绝'}邀请`;
    }

    return `你被 ${notification.invitedBy} 邀请加入 ${notification.teamName}`;
  };

  const getInvitationStatusTag = (notification: TeamInvitationNotification) => {
    if (notification.type !== 'team_invitation' || notification.status === 'pending') {
      return null;
    }

    return (
      <Tag color={notification.status === 'accepted' ? 'success' : 'default'}>
        {notification.status === 'accepted' ? '已接受' : '已拒绝'}
      </Tag>
    );
  };

  const switchTeamChildren: MenuProps['items'] = teams.map((team) => ({
    key: `switch-team-${team.id}`,
    label: team.id === currentTeamId ? `${team.name} ✓` : team.name,
    onClick: () => setCurrentTeamId(team.id),
  }));

  const items: MenuProps['items'] = [
    {
      key: 'email',
      label: <Text>{user?.email}</Text>,
      disabled: true,
      style: { cursor: 'default', color: 'rgba(0, 0, 0, 0.88)' }
    },
    {
      type: 'divider',
    },
    {
      key: 'create-team',
      label: '新建团队',
      onClick: handleOpenCreateTeam,
    },
    {
      key: 'team-info',
      label: '团队信息',
      disabled: !hasTeams,
      onClick: handleOpenTeamInfo,
    },
    {
      key: 'switch-team',
      label: '切换团队',
      disabled: !hasTeams,
      children: switchTeamChildren,
    },
    {
      type: 'divider',
    },
    {
      key: 'logout',
      label: '退出登录',
      icon: <LogoutOutlined />,
      onClick: handleLogout,
    },
  ];

  return (
    <Layout style={{ minHeight: '100vh' }}>
      <Header style={{
        display: 'flex',
        alignItems: 'center',
        justifyContent: 'space-between',
        background: '#fff',
        borderBottom: '1px solid #f0f0f0',
        padding: '0 24px'
      }}>
        <div className="demo-logo" style={{ fontSize: '20px', fontWeight: 'bold', color: '#1677ff' }}>
          项目文档管理器
        </div>

        {user && (
          <>
            <Space size={12}>
              <Button icon={<BellOutlined />} onClick={() => setNotificationDrawerOpen(true)}>
                <Badge dot={unreadNotificationCount > 0}>消息通知</Badge>
              </Button>

              <Button
                icon={<UnorderedListOutlined />}
                onClick={handleOpenDocDrawer}
              >
                文档列表
              </Button>

              <Dropdown menu={{ items }} placement="bottomRight" arrow>
                <Avatar
                  icon={<UserOutlined />}
                  style={{ backgroundColor: '#1677ff', cursor: 'pointer' }}
                />
              </Dropdown>
            </Space>

            <Drawer
              title="消息通知"
              placement="right"
              styles={{
                wrapper: { width: 420 },
                header: { padding: '10px 16px 8px' },
                body: { padding: '12px 16px 16px' },
              }}
              open={notificationDrawerOpen}
              onClose={() => setNotificationDrawerOpen(false)}
            >
              <Space orientation="vertical" size={12} style={{ width: '100%' }}>
                {invitationNotifications.length === 0 ? (
                  <div style={{ color: 'rgba(0, 0, 0, 0.65)' }}>暂无消息</div>
                ) : (
                  invitationNotifications.map((notification) => (
                    <div
                      key={notification.notificationId}
                      style={{
                        border: '1px solid #f0f0f0',
                        borderRadius: 8,
                        padding: 12,
                      }}
                    >
                      <div style={{ marginBottom: 10 }}>{getNotificationText(notification)}</div>
                      {notification.type === 'team_invitation' && notification.status === 'pending' ? (
                        <Space>
                          <Button
                            type="primary"
                            size="small"
                            loading={notificationActionLoadingId === notification.notificationId}
                            onClick={() => {
                              void handleAcceptInvitation(notification);
                            }}
                          >
                            接受
                          </Button>
                          <Button
                            size="small"
                            loading={notificationActionLoadingId === notification.notificationId}
                            onClick={() => {
                              void handleRejectInvitation(notification);
                            }}
                          >
                            拒绝
                          </Button>
                        </Space>
                      ) : (
                        getInvitationStatusTag(notification)
                      )}
                    </div>
                  ))
                )}
              </Space>
            </Drawer>

            <Drawer
              title="文档列表"
              placement="right"
              styles={{
                wrapper: { width: 420 },
                header: { padding: '10px 16px 8px' },
                body: { padding: '8px 16px 16px' },
              }}
              open={docDrawerOpen}
              onClose={() => setDocDrawerOpen(false)}
            >
              <Tabs
                style={{ marginTop: 0, paddingTop: 0 }}
                activeKey={docTabKey}
                onChange={setDocTabKey}
                items={[
                  {
                    key: 'personal',
                    label: '个人文档',
                    children: (
                      <PersonalDocumentList
                        open={docDrawerOpen && docTabKey === 'personal'}
                        onLoaded={() => setDocDrawerOpen(false)}
                      />
                    ),
                  },
                  {
                    key: 'shared',
                    label: '共享文档',
                    children: (
                      <SharedDocumentList
                        open={docDrawerOpen && docTabKey === 'shared'}
                        onLoaded={() => setDocDrawerOpen(false)}
                      />
                    ),
                  },
                ]}
              />
            </Drawer>

            <Modal
              open={createTeamOpen}
              title="新建团队"
              onOk={handleConfirmCreateTeam}
              onCancel={handleCancelCreateTeam}
              confirmLoading={createTeamLoading}
              okText="确定"
              cancelText="取消"
            >
              <Form form={teamForm} layout="vertical">
                <Form.Item
                  label="团队名称"
                  name="teamName"
                  rules={[{ required: true, message: '请输入团队名称' }]}
                >
                  <Input placeholder="请输入团队名称" />
                </Form.Item>
              </Form>
            </Modal>

            <TeamInfoModal
              open={teamInfoOpen}
              teamId={currentTeamId}
              onClose={handleCloseTeamInfo}
            />
          </>
        )}
      </Header>
      <Content style={{ padding: '10px', height: 'calc(100vh - 64px)', overflow: 'hidden' }}>
        <Outlet />
      </Content>
    </Layout>
  );
};

export default MainLayout;

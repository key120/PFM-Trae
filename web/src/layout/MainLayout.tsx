import React, { useState } from 'react';
import { Outlet, useNavigate } from 'react-router-dom';
import { Layout, Dropdown, Avatar, Typography, Button, Drawer, Space, Tabs } from 'antd';
import { UserOutlined, LogoutOutlined, UnorderedListOutlined } from '@ant-design/icons';
import type { MenuProps } from 'antd';
import { useAuthStore } from '../store/useAuthStore';
import PersonalDocumentList from '../components/PersonalDocumentList';

const { Header, Content } = Layout;
const { Text } = Typography;

const MainLayout: React.FC = () => {
  const { user, signOut } = useAuthStore();
  const navigate = useNavigate();
  const [docDrawerOpen, setDocDrawerOpen] = useState(false);
  const [docTabKey, setDocTabKey] = useState('personal');

  const handleLogout = async () => {
    await signOut();
    navigate('/login');
  };

  const handleOpenDocDrawer = () => {
    setDocTabKey('personal');
    setDocDrawerOpen(true);
  };

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
                      <div style={{ color: 'rgba(0, 0, 0, 0.65)' }}>共享文档功能开发中</div>
                    ),
                  },
                ]}
              />
            </Drawer>
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

import React from 'react';
import { Outlet, useNavigate } from 'react-router-dom';
import { Layout, Dropdown, Avatar, Typography } from 'antd';
import { UserOutlined, LogoutOutlined } from '@ant-design/icons';
import type { MenuProps } from 'antd';
import { useAuthStore } from '../store/useAuthStore';

const { Header, Content } = Layout;
const { Text } = Typography;

const MainLayout: React.FC = () => {
  // const {
  //   token: { colorBgContainer, borderRadiusLG },
  // } = theme.useToken();
  
  const { user, signOut } = useAuthStore();
  const navigate = useNavigate();

  const handleLogout = async () => {
    await signOut();
    navigate('/login');
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
          <Dropdown menu={{ items }} placement="bottomRight" arrow>
            <Avatar 
              icon={<UserOutlined />} 
              style={{ backgroundColor: '#1677ff', cursor: 'pointer' }} 
            />
          </Dropdown>
        )}
      </Header>
      <Content style={{ padding: '10px', height: 'calc(100vh - 64px)', overflow: 'hidden' }}>
        <Outlet />
      </Content>
    </Layout>
  );
};

export default MainLayout;

import React, { useState } from 'react';
import { Button, Card, Form, Input, Typography, Space, message } from 'antd';
import { UserOutlined, LockOutlined } from '@ant-design/icons';
import { Link, useNavigate } from 'react-router-dom';
import type { FormProps } from 'antd';
import { supabase } from '../lib/supabase';

const { Title, Text } = Typography;

type LoginFieldType = {
  email?: string;
  password?: string;
};

const Login: React.FC = () => {
  const [loading, setLoading] = useState(false);
  const navigate = useNavigate();
  const [messageApi, contextHolder] = message.useMessage();

  const onFinish: FormProps<LoginFieldType>['onFinish'] = async (values) => {
    if (!values.email || !values.password) return;

    setLoading(true);
    const { error } = await supabase.auth.signInWithPassword({
      email: values.email,
      password: values.password,
    });

    setLoading(false);

    if (error) {
      messageApi.error(error.message);
    } else {
      messageApi.success('登录成功');
      navigate('/dashboard');
    }
  };

  return (
    <div style={{ 
      display: 'flex', 
      justifyContent: 'center', 
      alignItems: 'center', 
      height: '100vh', 
      backgroundColor: '#f5f5f5' 
    }}>
      {contextHolder}
      <Card style={{ width: 400, boxShadow: 'none', border: '1px solid #e8e8e8' }}>
        <div style={{ textAlign: 'center', marginBottom: 24 }}>
          <Title level={3}>登录</Title>
          <Text type="secondary">欢迎回来，请登录您的账户</Text>
        </div>
        
        <Form
          name="normal_login"
          initialValues={{ remember: true }}
          onFinish={onFinish}
          size="large"
        >
          <Form.Item
            name="email"
            rules={[{ required: true, message: '请输入您的邮箱!' }]}
          >
            <Input prefix={<UserOutlined className="site-form-item-icon" />} placeholder="邮箱" style={{ fontSize: '14px' }} />
          </Form.Item>
          <Form.Item
            name="password"
            rules={[{ required: true, message: '请输入您的密码!' }]}
          >
            <Input
              prefix={<LockOutlined className="site-form-item-icon" />}
              type="password"
              placeholder="密码"
              style={{ fontSize: '14px' }}
            />
          </Form.Item>
          
          <Form.Item>
            <Button type="primary" htmlType="submit" loading={loading} style={{ width: '100%' }}>
              登录
            </Button>
          </Form.Item>
          
          <div style={{ textAlign: 'center' }}>
            <Space>
              <Text>没有账户？</Text>
              <Link to="/register">立即注册</Link>
            </Space>
          </div>
        </Form>
      </Card>
    </div>
  );
};

export default Login;

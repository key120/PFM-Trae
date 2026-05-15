import React, { useState } from 'react';
import { Button, Card, Form, Input, Typography, Space, message, Modal } from 'antd';
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
  const [resetOpen, setResetOpen] = useState(false);
  const [resetEmail, setResetEmail] = useState('');
  const [resetLoading, setResetLoading] = useState(false);
  const [form] = Form.useForm();

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

  const handleResetPassword = async () => {
    if (!resetEmail) {
      messageApi.warning('请输入邮箱地址');
      return;
    }
    setResetLoading(true);
    const { error } = await supabase.auth.resetPasswordForEmail(resetEmail, {
      redirectTo: `${window.location.origin}/login`,
    });
    setResetLoading(false);
    if (error) {
      messageApi.error(error.message);
    } else {
      messageApi.success('密码重置邮件已发送，请查收邮箱');
      setResetOpen(false);
      setResetEmail('');
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
          form={form}
          name="normal_login"
          initialValues={{ remember: true }}
          onFinish={onFinish}
          size="large"
        >
          <Form.Item
            name="email"
            label="邮箱"
            rules={[{ required: true, message: '请输入您的邮箱!' }]}
          >
            <Input prefix={<UserOutlined className="site-form-item-icon" />} placeholder="请输入邮箱" style={{ fontSize: '14px' }} />
          </Form.Item>
          <Form.Item
            name="password"
            label="密码"
            rules={[{ required: true, message: '请输入您的密码!' }]}
          >
            <Input
              prefix={<LockOutlined className="site-form-item-icon" />}
              type="password"
              placeholder="请输入密码"
              style={{ fontSize: '14px' }}
            />
          </Form.Item>

          <div style={{ textAlign: 'right', marginBottom: 16, marginTop: -8 }}>
            <Text
              type="secondary"
              style={{ cursor: 'pointer', fontSize: '13px' }}
              onClick={() => {
                const emailVal = form.getFieldValue('email');
                setResetEmail(emailVal || '');
                setResetOpen(true);
              }}
            >
              忘记密码？
            </Text>
          </div>
          
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

      <Modal
        title="重置密码"
        open={resetOpen}
        onOk={handleResetPassword}
        onCancel={() => { setResetOpen(false); setResetEmail(''); }}
        confirmLoading={resetLoading}
        okText="发送重置邮件"
        cancelText="取消"
      >
        <div style={{ marginTop: 16 }}>
          <Text type="secondary" style={{ display: 'block', marginBottom: 12 }}>
            输入您注册时使用的邮箱地址，我们将发送密码重置链接。
          </Text>
          <Input
            prefix={<UserOutlined />}
            placeholder="邮箱地址"
            value={resetEmail}
            onChange={(e) => setResetEmail(e.target.value)}
            onPressEnter={handleResetPassword}
          />
        </div>
      </Modal>
    </div>
  );
};

export default Login;

import React, { useState } from 'react';
import { Button, Card, Form, Input, Typography, Space, message } from 'antd';
import { UserOutlined, LockOutlined } from '@ant-design/icons';
import { Link, useNavigate } from 'react-router-dom';
import type { FormProps } from 'antd';
import { supabase } from '../lib/supabase';

const { Title, Text } = Typography;

type RegisterFieldType = {
  email?: string;
  password?: string;
  confirm?: string;
};

const Register: React.FC = () => {
  const [loading, setLoading] = useState(false);
  const navigate = useNavigate();
  const [messageApi, contextHolder] = message.useMessage();

  const onFinish: FormProps<RegisterFieldType>['onFinish'] = async (values) => {
    if (!values.email || !values.password) return;

    setLoading(true);
    const { data, error } = await supabase.auth.signUp({
      email: values.email,
      password: values.password,
    });

    setLoading(false);

    if (error) {
      messageApi.error(error.message);
      return;
    }

    if (data.session) {
      // 注册成功且自动登录的情况下，先登出以确保跳转到登录页
      await supabase.auth.signOut();
      messageApi.success('注册成功，请登录', 1.5, () => {
        navigate('/login');
      });
    } else {
      messageApi.success('注册成功，请检查您的邮箱进行验证！', 3, () => {
        navigate('/login');
      });
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
          <Title level={3}>注册</Title>
          <Text type="secondary">创建一个新账户</Text>
        </div>
        
        <Form
          name="register"
          onFinish={onFinish}
          size="large"
          scrollToFirstError
        >
          <Form.Item
            name="email"
            label="邮箱"
            rules={[
              { type: 'email', message: '请输入有效的邮箱地址!' },
              { required: true, message: '请输入您的邮箱!' },
            ]}
          >
            <Input prefix={<UserOutlined />} placeholder="请输入邮箱" style={{ fontSize: '14px' }} />
          </Form.Item>

          <Form.Item
            name="password"
            label="密码"
            rules={[
              { required: true, message: '请输入您的密码!' },
              { min: 8, message: '密码至少需要8位' }
            ]}
            hasFeedback
          >
            <Input.Password prefix={<LockOutlined />} placeholder="请输入密码（至少8位）" style={{ fontSize: '14px' }} />
          </Form.Item>

          <Form.Item
            name="confirm"
            label="确认密码"
            dependencies={['password']}
            hasFeedback
            rules={[
              { required: true, message: '请确认您的密码!' },
              ({ getFieldValue }) => ({
                validator(_, value) {
                  if (!value || getFieldValue('password') === value) {
                    return Promise.resolve();
                  }
                  return Promise.reject(new Error('两次输入的密码不一致!'));
                },
              }),
            ]}
          >
            <Input.Password prefix={<LockOutlined />} placeholder="请再次输入密码" style={{ fontSize: '14px' }} />
          </Form.Item>

          <Form.Item>
            <Button type="primary" htmlType="submit" loading={loading} style={{ width: '100%' }}>
              注册
            </Button>
          </Form.Item>
          
          <div style={{ textAlign: 'center' }}>
            <Space>
              <Text>已有账户？</Text>
              <Link to="/login">立即登录</Link>
            </Space>
          </div>
        </Form>
      </Card>
    </div>
  );
};

export default Register;

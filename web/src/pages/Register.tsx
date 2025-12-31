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
      messageApi.success('注册成功，正在跳转...');
      navigate('/dashboard');
    } else {
      messageApi.success('注册成功，请检查您的邮箱进行验证！', 5);
      // Optional: navigate to login or stay here
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
            rules={[
              { type: 'email', message: '请输入有效的邮箱地址!' },
              { required: true, message: '请输入您的邮箱!' },
            ]}
          >
            <Input prefix={<UserOutlined />} placeholder="邮箱" />
          </Form.Item>

          <Form.Item
            name="password"
            rules={[
              { required: true, message: '请输入您的密码!' },
              { min: 8, message: '密码至少需要8位' }
            ]}
            hasFeedback
          >
            <Input.Password prefix={<LockOutlined />} placeholder="密码" />
          </Form.Item>

          <Form.Item
            name="confirm"
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
            <Input.Password prefix={<LockOutlined />} placeholder="确认密码" />
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

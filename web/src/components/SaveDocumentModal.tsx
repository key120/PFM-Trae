import React, { useEffect, useRef, useState } from 'react';
import { Modal, Form, Input, Progress } from 'antd';
import { estimateSaveDuration } from '../services/documentSaveProgress';

interface SaveDocumentModalProps {
  open: boolean;
  confirmLoading?: boolean;
  onOk: (values: { version: string; remark: string }) => void;
  onCancel: () => void;
  defaultVersion?: string | null;
  validateVersion?: (version: string) => Promise<void>;
  saving?: boolean;
  fileSize?: number;
}

const SaveDocumentModal: React.FC<SaveDocumentModalProps> = ({
  open,
  confirmLoading,
  onOk,
  onCancel,
  defaultVersion,
  validateVersion,
  saving = false,
  fileSize = 0,
}) => {
  const [form] = Form.useForm<{ version: string; remark: string }>();
  const [percent, setPercent] = useState(0);
  const [message, setMessage] = useState('准备中...');
  const animRef = useRef<number | null>(null);
  const startTimeRef = useRef(0);
  const durationRef = useRef(5000);
  const targetRef = useRef(0);

  useEffect(() => {
    if (open) {
      form.setFieldsValue({
        version: defaultVersion || 'V1.0.0',
        remark: '',
      });
    }
  }, [open, form, defaultVersion]);

  // saving 变为 true 时启动虚拟进度动画
  useEffect(() => {
    if (saving && fileSize > 0) {
      const duration = estimateSaveDuration(fileSize);
      startTimeRef.current = performance.now();
      durationRef.current = duration;
      targetRef.current = 95;
      setPercent(0);
      setMessage('加密中...');

      const tick = (now: number) => {
        const elapsed = now - startTimeRef.current;
        const progress = Math.min((elapsed / durationRef.current) * 95, targetRef.current);
        setPercent(Math.floor(progress));

        // 根据进度更新阶段文案
        if (progress < 5) setMessage('准备中...');
        else if (progress < 30) setMessage('加密中...');
        else if (progress < 85) setMessage('上传中...');
        else setMessage('保存中...');

        if (progress < targetRef.current) {
          animRef.current = requestAnimationFrame(tick);
        }
      };
      animRef.current = requestAnimationFrame(tick);
    }

    return () => {
      if (animRef.current !== null) {
        cancelAnimationFrame(animRef.current);
        animRef.current = null;
      }
    };
  }, [saving, fileSize]);

  // saving 变为 false 时跳到 100%
  useEffect(() => {
    if (!saving && percent > 0 && percent < 100) {
      if (animRef.current !== null) {
        cancelAnimationFrame(animRef.current);
        animRef.current = null;
      }
      setPercent(100);
      setMessage('保存完成');
    }
  }, [saving, percent]);

  const handleOk = async () => {
    const values = await form.validateFields();
    onOk(values);
  };

  return (
    <Modal
      open={open}
      title="保存文档"
      maskClosable={!saving}
      keyboard={!saving}
      closable={!saving}
      destroyOnHidden={false}
      centered
      style={{ ['--ant-modal-content-padding' as string]: '16px 20px' }}
      confirmLoading={confirmLoading}
      onOk={handleOk}
      onCancel={saving ? undefined : onCancel}
      okText="保存"
      cancelText="取消"
      okButtonProps={saving ? { disabled: true } : undefined}
      cancelButtonProps={saving ? { disabled: true } : undefined}
    >
      <Form form={form} layout="vertical">
        <Form.Item
          label="版本号"
          name="version"
          rules={[
            { required: true, message: '请输入版本号' },
            {
              validator: async (_, value: string | undefined) => {
                if (!value || !validateVersion) {
                  return;
                }
                await validateVersion(value.trim());
              },
            },
          ]}
        >
          <Input placeholder="例如：V1.0.0" />
        </Form.Item>
        <Form.Item label="备注" name="remark">
          <Input.TextArea
            placeholder="选填，对本次保存做一个简单说明"
            rows={3}
          />
        </Form.Item>
      </Form>
      {saving && (
        <div style={{ marginTop: 8 }}>
          <Progress percent={percent} status="active" />
          {message && (
            <div style={{ textAlign: 'center', marginTop: 8, color: '#666' }}>
              {message}
            </div>
          )}
        </div>
      )}
    </Modal>
  );
};

export default SaveDocumentModal;

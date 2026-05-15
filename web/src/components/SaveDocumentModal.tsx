import React, { useEffect } from 'react';
import { Modal, Form, Input, Progress } from 'antd';
import type { SaveProgressInfo } from '../services/documentSaveProgress';

interface SaveDocumentModalProps {
  open: boolean;
  confirmLoading?: boolean;
  onOk: (values: { version: string; remark: string }) => void;
  onCancel: () => void;
  defaultVersion?: string | null;
  validateVersion?: (version: string) => Promise<void>;
  saving?: boolean;
  saveProgress?: SaveProgressInfo | null;
}

const SaveDocumentModal: React.FC<SaveDocumentModalProps> = ({
  open,
  confirmLoading,
  onOk,
  onCancel,
  defaultVersion,
  validateVersion,
  saving = false,
  saveProgress = null,
}) => {
  const [form] = Form.useForm<{ version: string; remark: string }>();

  useEffect(() => {
    if (open) {
      form.setFieldsValue({
        version: defaultVersion || 'V1.0.0',
        remark: '',
      });
    }
  }, [open, form, defaultVersion]);

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
      {saving && saveProgress && (
        <div style={{ marginTop: 8 }}>
          <Progress percent={saveProgress.percent} status="active" />
          {saveProgress.message && (
            <div style={{ textAlign: 'center', marginTop: 8, color: '#666' }}>
              {saveProgress.message}
            </div>
          )}
        </div>
      )}
    </Modal>
  );
};

export default SaveDocumentModal;

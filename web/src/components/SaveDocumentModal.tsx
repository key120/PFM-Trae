import React, { useEffect } from 'react';
import { Modal, Form, Input, Progress, Button } from 'antd';
import { useVirtualProgress } from '../hooks/useVirtualProgress';
import './SaveDocumentModal.css';

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
  const { percent, message } = useVirtualProgress({
    fileSize,
    isActive: saving,
    stageMessages: ['准备中...', '加密中...', '上传中...', '保存中...'],
    completionMessage: '保存完成',
  });

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
      footer={
        <div className="save-modal-footer">
          <div className="save-modal-footer-buttons">
            {saving && <span className="save-modal-stage-text">{message}（{percent}%）</span>}
            <Button onClick={saving ? undefined : onCancel} disabled={saving}>取消</Button>
            <Button type="primary" onClick={handleOk} disabled={saving} loading={confirmLoading}>保存</Button>
          </div>
          <div className={`save-modal-progress-row ${saving ? 'visible' : ''}`}>
            {percent > 0 && <Progress percent={percent} showInfo={false} />}
          </div>
        </div>
      }
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
          <Input placeholder="例如：V1.0.0" disabled={saving} />
        </Form.Item>
        <Form.Item label="备注" name="remark">
          <Input.TextArea
            placeholder="选填，对本次保存做一个简单说明"
            rows={3}
            disabled={saving}
          />
        </Form.Item>
      </Form>
    </Modal>
  );
};

export default SaveDocumentModal;

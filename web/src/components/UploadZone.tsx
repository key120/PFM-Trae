import React from 'react';
import { Upload, message, Button } from 'antd';
import type { UploadProps } from 'antd';
import { useDocStore } from '../store/useDocStore';

const { Dragger } = Upload;

interface UploadZoneProps {
  variant?: 'dragger' | 'button';
}

const UploadZone: React.FC<UploadZoneProps> = ({ variant = 'dragger' }) => {
  const { startNewUpload, setUploading } = useDocStore();
  // 使用 ref 来引用 Upload 组件，虽然对于 Button 变体可能不需要直接操作 ref，
  // 但保持一致性是好的。对于 Button 变体，Upload 组件会自动处理点击。

  const handleFile = (file: File) => {
    // Check file type
    const isDocx = file.type === 'application/vnd.openxmlformats-officedocument.wordprocessingml.document' || 
                   file.name.endsWith('.docx');
    if (!isDocx) {
      message.error('只能上传 DOCX 格式的文档!');
      return Upload.LIST_IGNORE;
    }

    // Check file size (50MB)
    const isLt50M = file.size / 1024 / 1024 < 50;
    if (!isLt50M) {
      message.error('文件大小不能超过 50MB!');
      return Upload.LIST_IGNORE;
    }

    // Set file to store
    setUploading(true);
    // Simulate upload delay for better UX
    setTimeout(() => {
      startNewUpload(file);
      setUploading(false);
      message.success(`${file.name} 上传成功`);
    }, 500);

    return false; // Prevent default upload behavior
  };

  const props: UploadProps = {
    name: 'file',
    multiple: false,
    showUploadList: false,
    beforeUpload: handleFile,
    fileList: [], // 确保不受控显示列表
  };

  if (variant === 'button') {
    return (
      <Upload {...props}>
        <Button 
          icon={
            <span role="img" aria-label="upload" className="anticon">
              <svg width="1em" height="1em" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round">
                <path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4"/>
                <polyline points="17 8 12 3 7 8"/>
                <line x1="12" y1="3" x2="12" y2="15"/>
              </svg>
            </span>
          } 
          size="small" 
          type="link" 
          style={{ padding: 0 }}
        >
          重新上传
        </Button>
      </Upload>
    );
  }

  return (
    <div style={{ width: '100%', padding: '0 16px' }}>
      <Dragger {...props} style={{ padding: '20px 0' }}>
        <p className="ant-upload-drag-icon">
          <span role="img" aria-label="inbox" className="anticon" style={{ fontSize: '40px', color: '#1677ff' }}>
            <svg width="1em" height="1em" viewBox="0 0 48 48" fill="none" xmlns="http://www.w3.org/2000/svg">
              <path d="M5 30L10 6H38L43 30" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round"/>
              <path d="M5 30H14.9L16.7 36H31.3L33.1 30H43V42H5V30Z" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round"/>
            </svg>
          </span>
        </p>
        <p className="ant-upload-text" style={{ fontSize: '14px', fontWeight: 500 }}>
          将文件拖到此处上传
        </p>
        <p className="ant-upload-hint" style={{ fontSize: '12px', color: '#8c8c8c' }}>
          或者，您可以 <span style={{ color: '#1677ff', cursor: 'pointer' }}>点击上传</span>
        </p>
        <p className="ant-upload-hint" style={{ fontSize: '12px', color: '#bfbfbf', marginTop: 8 }}>
          仅支持 DOCX 格式，文件大小限制 50MB
        </p>
      </Dragger>
    </div>
  );
};

export default UploadZone;

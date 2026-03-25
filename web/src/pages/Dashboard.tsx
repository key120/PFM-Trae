import React, { useEffect } from 'react';
import { Card, Button, message, Space, Tooltip } from 'antd';
import UploadZone from '../components/UploadZone';
import DocumentPreview from '../components/DocumentPreview';
import TableOfContents from '../components/TableOfContents';
import { useDocStore } from '../store/useDocStore';
import { useAuthStore } from '../store/useAuthStore';
import { parseDocumentHeadings, HeadingNode, getAllKeys, flattenHeadings } from '../utils/docParser';
import { exportDocument } from '../utils/documentExporter';
import SaveDocumentModal from '../components/SaveDocumentModal';
import { savePersonalDocument } from '../services/documentService';
import { isWebCryptoAvailable } from '../services/cryptoKeyService';

const Dashboard: React.FC = () => {
  const { user } = useAuthStore();
  const {
    currentFile,
    setParsing,
    setHeadings,
    setCheckedKeys,
    checkedKeys,
    headings,
    currentDocumentId,
    setCurrentDocumentId,
    currentDocumentVersion,
    setCurrentDocumentVersion,
    initialCheckedKeys,
    setInitialCheckedKeys,
  } = useDocStore();
  const [exporting, setExporting] = React.useState(false);
  const [saving, setSaving] = React.useState(false);
  const webCryptoAvailable = isWebCryptoAvailable();
  const [saveModalOpen, setSaveModalOpen] = React.useState(false);

  // 当 currentFile 改变时，解析目录
  useEffect(() => {
    if (!currentFile) {
      setHeadings([]);
      setCheckedKeys([]);
      return;
    }

    const parse = async () => {
      try {
        setParsing(true);
        const root = await parseDocumentHeadings(currentFile);
        setHeadings(root);
        const allKeys = getAllKeys(root);
        if (initialCheckedKeys && initialCheckedKeys.length > 0) {
          const nextKeys = initialCheckedKeys.filter((key) =>
            allKeys.includes(key),
          );
          setCheckedKeys(nextKeys);
          setInitialCheckedKeys(null);
        } else {
          setCheckedKeys(allKeys);
        }
      } catch (error) {
        console.error(error);
        message.error('解析文档目录失败');
      } finally {
        setParsing(false);
      }
    };

    parse();
  }, [currentFile, setParsing, setHeadings, setCheckedKeys]);

  const handleTocSelect = (node: HeadingNode) => {
    const event = new CustomEvent('scrollToHeading', { detail: { key: node.key, title: node.title } });
    window.dispatchEvent(event);
  };

  const handleExport = async () => {
    if (!currentFile) return;
    
    try {
      setExporting(true);
      const flatHeadings = flattenHeadings(headings);
      await exportDocument(currentFile, checkedKeys as string[], flatHeadings, headings);
      message.success('文档导出成功');
    } catch (error) {
      console.error('Export failed:', error);
      message.error('导出失败，请重试');
    } finally {
      setExporting(false);
    }
  };

  const handleOpenSaveModal = () => {
    setSaveModalOpen(true);
  };

  const handleCloseSaveModal = () => {
    if (saving) {
      return;
    }
    setSaveModalOpen(false);
  };

  const handleSaveConfirm = async (values: { version: string; remark: string }) => {
    if (!currentFile) {
      message.error('当前没有可保存的文档');
      return;
    }

    if (!user) {
      message.error('请登录后再保存文档');
      return;
    }

    try {
      setSaving(true);
      const selectedKeys = checkedKeys as string[];
      const blob: Blob = currentFile;

      const result = await savePersonalDocument({
        userId: user.id,
        authorEmail: user.email ?? null,
        blob,
        fileName: currentFile.name,
        documentId: currentDocumentId,
        version: values.version,
        remark: values.remark,
        selectedKeys,
      });

      setCurrentDocumentId(result.documentId);
      setCurrentDocumentVersion(values.version);
      setSaveModalOpen(false);
      window.dispatchEvent(new Event('personalDocumentsChanged'));
      message.success('保存成功');
    } catch (error) {
      console.error('Save failed:', error);
      message.error('保存失败，请重试');
    } finally {
      setSaving(false);
    }
  };

  return (
    <div style={{ 
      display: 'flex', 
      height: '100%', 
      gap: '10px',
      overflow: 'hidden'
    }}>
      {/* 左侧栏：目录与上传 */}
      <div style={{ 
        width: '320px', 
        display: 'flex', 
        flexDirection: 'column', 
        gap: '10px',
        flexShrink: 0
      }}>
        {/* 文档目录 */}
        <Card 
          title={<span style={{ fontSize: '14px' }}>文档目录</span>}
          extra={currentFile && <UploadZone variant="button" />}
          style={{ flex: 1, display: 'flex', flexDirection: 'column', minHeight: 0, overflow: 'hidden' }}
          styles={{
            header: { minHeight: '48px', height: '48px', padding: '0 16px' },
            body: { 
              flex: 1, 
              overflow: 'hidden',
              display: 'flex',
              flexDirection: 'column',
              padding: 0 
            }
          }}
        >
          {/* 上传区域 - 仅在未上传时显示 */}
          {!currentFile && (
            <div style={{ 
              borderBottom: 'none',
              flex: 1,
              display: 'flex',
              alignItems: 'center',
              justifyContent: 'center'
            }}>
               <UploadZone />
            </div>
          )}

          {/* 目录树区域 */}
          {currentFile && (
            <div style={{ padding: '16px', flex: 1, minHeight: 0, display: 'flex', flexDirection: 'column', overflow: 'hidden' }}>
              <TableOfContents onSelect={handleTocSelect} />
            </div>
          )}
        </Card>
      </div>

      {/* 右侧栏：预览 */}
      <Card 
        title={
          <span style={{ fontSize: '14px' }}>
            文档预览
            {currentFile && (
              <>
                <span style={{ color: '#666666', marginLeft: '4px' }}>
                  ({currentFile.name})
                </span>
                {currentDocumentId && (
                  <span style={{ color: '#1677ff', marginLeft: '4px' }}>
                    （个人）
                  </span>
                )}
              </>
            )}
          </span>
        }
        style={{ flex: 1, display: 'flex', flexDirection: 'column', overflow: 'hidden' }}
        styles={{
          header: { minHeight: '48px', height: '48px', padding: '0 16px', borderBottom: '1px solid #f0f0f0' },
          body: { 
            flex: 1, 
            display: 'flex', 
            flexDirection: 'column',
            padding: 0,
            overflow: 'hidden' 
          }
        }}
        extra={
          currentFile ? (
            <Space size={8}>
              <Tooltip
                title={!webCryptoAvailable ? '当前浏览器不支持加密功能，无法保存文档' : undefined}
              >
                <Button
                  type="default"
                  loading={saving}
                  disabled={!webCryptoAvailable}
                  onClick={handleOpenSaveModal}
                >
                  保存
                </Button>
              </Tooltip>

              <Button 
                type="primary" 
                icon={
                  <span role="img" aria-label="export" className="anticon">
                    <svg width="1em" height="1em" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round">
                      <path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4"/>
                      <polyline points="7 10 12 15 17 10"/>
                      <line x1="12" y1="15" x2="12" y2="3"/>
                    </svg>
                  </span>
                }
                loading={exporting}
                onClick={handleExport}
              >
                导出文档
              </Button>
            </Space>
          ) : null
        }
      >
        <DocumentPreview />
      </Card>
      <SaveDocumentModal
        open={saveModalOpen}
        confirmLoading={saving}
        onOk={handleSaveConfirm}
        onCancel={handleCloseSaveModal}
        defaultVersion={currentDocumentVersion}
      />
    </div>
  );
};

export default Dashboard;

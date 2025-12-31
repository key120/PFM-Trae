import React, { useEffect } from 'react';
import { Card, Button, message } from 'antd';
import { DownloadOutlined, ExportOutlined } from '@ant-design/icons';
import UploadZone from '../components/UploadZone';
import DocumentPreview from '../components/DocumentPreview';
import TableOfContents from '../components/TableOfContents';
import { useDocStore } from '../store/useDocStore';
import { parseDocumentHeadings, HeadingNode, getAllKeys, flattenHeadings } from '../utils/docParser';
import { exportDocument } from '../utils/documentExporter';

const Dashboard: React.FC = () => {
  const { currentFile, setParsing, setHeadings, setCheckedKeys, checkedKeys, headings } = useDocStore();
  const [exporting, setExporting] = React.useState(false);

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
        setCheckedKeys(getAllKeys(root));
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
              <span style={{ color: '#666666', marginLeft: '4px' }}>
                ({currentFile.name})
              </span>
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
          ) : null
        }
      >
        <DocumentPreview />
      </Card>
    </div>
  );
};

export default Dashboard;

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
import {
  assertSharedVersionLabelAvailable,
  savePersonalDocument,
  saveSharedDocumentVersion,
} from '../services/documentService';
import { isWebCryptoAvailable } from '../services/cryptoKeyService';
import { useTeamStore } from '../store/useTeamStore';
import type { SaveProgressInfo } from '../services/documentSaveProgress';
import { createSmoothProgressTracker } from '../services/documentSaveProgress';
import { createDocumentLoadCache } from '../services/documentLoadCache';

const Dashboard: React.FC = () => {
  const { user } = useAuthStore();
  const { currentTeamId, currentUserRole } = useTeamStore();
  const {
    currentFile,
    currentFileArrayBuffer,
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
    setCurrentFileArrayBuffer,
    documentMode,
    currentTeamScopedShare,
  } = useDocStore();
  const [exporting, setExporting] = React.useState(false);
  const [saving, setSaving] = React.useState(false);
  const [saveProgress, setSaveProgress] = React.useState<SaveProgressInfo | null>(null);
  const documentLoadCacheRef = React.useRef(createDocumentLoadCache());
  const renderedHtmlForPreview = React.useMemo(() => {
    if (currentDocumentId && currentDocumentVersion && currentFile) {
      const cached = documentLoadCacheRef.current.get(currentDocumentId, currentDocumentVersion);
      if (cached && cached.file.size === currentFile.size && cached.renderedHtml) {
        return cached.renderedHtml;
      }
    }
    return null;
  }, [currentDocumentId, currentDocumentVersion, currentFile]);
  const webCryptoAvailable = isWebCryptoAvailable();
  const [saveModalOpen, setSaveModalOpen] = React.useState(false);
  const saveDisabledByRole = documentMode === 'shared' && currentUserRole === 'reader';
  const saveDisabled = !webCryptoAvailable || saveDisabledByRole;
  const saveTooltip = !webCryptoAvailable
    ? '当前浏览器不支持加密功能，无法保存文档'
    : saveDisabledByRole
      ? '当前团队角色为只读，无法保存共享文档'
      : undefined;

  // 当 currentFile 改变时，解析目录
  useEffect(() => {
    if (!currentFile) {
      setHeadings([]);
      setCheckedKeys([]);
      setCurrentFileArrayBuffer(null);
      return;
    }

    const applyCheckedKeys = (allKeys: string[]) => {
      if (initialCheckedKeys && initialCheckedKeys.length > 0) {
        const nextKeys = initialCheckedKeys.filter((key) =>
          allKeys.includes(key),
        );
        setCheckedKeys(nextKeys);
        setInitialCheckedKeys(null);
        return;
      }

      setCheckedKeys(allKeys);
    };

    // 捕获闭包值，避免异步执行时引用过期的 store 状态
    const docId = currentDocumentId;
    const docVersion = currentDocumentVersion;

    const parse = async () => {
      try {
        setParsing(true);

        if (docId && docVersion) {
          const cached = documentLoadCacheRef.current.get(docId, docVersion);
          // 校验文件大小防止缓存内容与实际文件不一致
          if (cached && cached.file.size === currentFile.size) {
            console.log(`[Dashboard] 内存缓存命中, 跳过 ArrayBuffer 读取和目录解析`);
            setHeadings(cached.headings as HeadingNode[]);
            applyCheckedKeys(getAllKeys(cached.headings as HeadingNode[]));
            setCurrentFileArrayBuffer(cached.arrayBuffer ?? null);
            return;
          }
        }

        const tAB = performance.now();
        const nextArrayBuffer =
          currentFileArrayBuffer ??
          (typeof currentFile.arrayBuffer === 'function'
            ? await currentFile.arrayBuffer()
            : null);
        if (nextArrayBuffer) {
          setCurrentFileArrayBuffer(nextArrayBuffer);
        }
        console.log(`[Dashboard] ArrayBuffer 读取完成, 耗时 ${(performance.now() - tAB).toFixed(0)}ms`);
        const tParse = performance.now();
        const root = await parseDocumentHeadings(currentFile);
        console.log(`[Dashboard] 目录解析完成, 耗时 ${(performance.now() - tParse).toFixed(0)}ms`);
        setHeadings(root);
        applyCheckedKeys(getAllKeys(root));

        // 写入缓存，后续二次打开可跳过解密和目录解析
        if (docId && docVersion) {
          documentLoadCacheRef.current.set(docId, docVersion, {
            file: currentFile,
            arrayBuffer: nextArrayBuffer ?? undefined,
            headings: root,
            title: root?.length > 0 ? root[0].title : currentFile.name,
          });
        }
      } catch (error) {
        console.error(error);
        message.error('解析文档目录失败');
      } finally {
        setParsing(false);
      }
    };

    parse();
    // initialCheckedKeys / currentDocumentId / currentDocumentVersion / currentFileArrayBuffer 不加入依赖：
    // effect 只应在 currentFile 切换时运行一次，避免 store 内部收尾写入再次触发解析。
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [currentFile]);

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

    const tracker = createSmoothProgressTracker((info) => setSaveProgress(info));

    try {
      setSaving(true);
      const selectedKeys = checkedKeys as string[];
      const blob: Blob = currentFile;

      if (documentMode === 'shared' && currentDocumentId && currentTeamScopedShare && currentTeamId) {
        const result = await saveSharedDocumentVersion({
          documentId: currentDocumentId,
          editorUserId: user.id,
          editorEmail: user.email ?? null,
          teamId: currentTeamId,
          blob,
          fileName: currentFile.name,
          version: values.version,
          remark: values.remark,
          selectedKeys,
          onProgress: (info) => tracker.onStageChange(info.stage, info.encryptingProgress),
        });

        setCurrentDocumentId(result.documentId);
        setCurrentDocumentVersion(values.version);
        setSaveModalOpen(false);
        window.dispatchEvent(new Event('sharedDocumentsChanged'));
        message.success('保存成功');
        setSaveProgress(null);
        return;
      }

      const result = await savePersonalDocument({
        userId: user.id,
        authorEmail: user.email ?? null,
        blob,
        fileName: currentFile.name,
        documentId: currentDocumentId,
        version: values.version,
        remark: values.remark,
        selectedKeys,
        onProgress: (info) => tracker.onStageChange(info.stage, info.encryptingProgress),
      });

      setCurrentDocumentId(result.documentId);
      setCurrentDocumentVersion(values.version);
      setSaveModalOpen(false);
      window.dispatchEvent(new Event('personalDocumentsChanged'));
      message.success('保存成功');
      setSaveProgress(null);
    } catch (error) {
      console.error('Save failed:', error);
      const errorMessage = error instanceof Error && error.message ? error.message : '保存失败，请重试';
      message.error(errorMessage);
      setSaveProgress(null);
    } finally {
      tracker.dispose();
      setSaving(false);
    }
  };

  const validateSharedVersion = React.useCallback(
    async (version: string) => {
      const trimmedVersion = version.trim();
      if (!trimmedVersion || documentMode !== 'shared' || !currentDocumentId) {
        return;
      }
      if (trimmedVersion === (currentDocumentVersion ?? '').trim()) {
        return;
      }
      await assertSharedVersionLabelAvailable(currentDocumentId, trimmedVersion);
    },
    [documentMode, currentDocumentId, currentDocumentVersion],
  );

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
                {currentDocumentId && documentMode === 'personal' && (
                  <span style={{ color: '#1677ff', marginLeft: '4px' }}>
                    （个人）
                  </span>
                )}
                {currentDocumentId && documentMode === 'shared' && (
                  <span style={{ color: '#1677ff', marginLeft: '4px' }}>
                    （共享）
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
              <Tooltip title={saveTooltip}>
                <Button
                  type="default"
                  loading={saving}
                  disabled={saveDisabled}
                  onClick={handleOpenSaveModal}
                  icon={
                    <span role="img" aria-label="save" className="anticon">
                      <svg width="1em" height="1em" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round">
                        <path d="M19 21H5a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h11l5 5v11a2 2 0 0 1-2 2z"/>
                        <polyline points="17 21 17 13 7 13 7 21"/>
                        <polyline points="7 3 7 8 15 8"/>
                      </svg>
                    </span>
                  }
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
        <DocumentPreview
          arrayBuffer={currentFileArrayBuffer}
          renderedHtml={renderedHtmlForPreview}
          onRendered={(html) => {
            // 缓存渲染后的 DOM 快照，供二次打开时跳过 renderAsync
            const docId = currentDocumentId;
            const docVersion = currentDocumentVersion;
            if (docId && docVersion && currentFile) {
              const existing = documentLoadCacheRef.current.get(docId, docVersion);
              if (existing) {
                documentLoadCacheRef.current.set(docId, docVersion, {
                  ...existing,
                  renderedHtml: html,
                });
              }
            }
          }}
        />
      </Card>
      <SaveDocumentModal
        open={saveModalOpen}
        confirmLoading={saving}
        saving={saving}
        saveProgress={saveProgress}
        onOk={handleSaveConfirm}
        onCancel={handleCloseSaveModal}
        defaultVersion={currentDocumentVersion}
        validateVersion={documentMode === 'shared' ? validateSharedVersion : undefined}
      />
    </div>
  );
};

export default Dashboard;

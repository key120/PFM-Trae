import { describe, expect, it, vi } from 'vitest';
import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import SaveDocumentModal from './SaveDocumentModal';
import type { SaveProgressInfo } from '../services/documentSaveProgress';

describe('SaveDocumentModal', () => {
  it('保存中会展示阶段文案与进度条，作为后续进度 UI 的稳定断言位置', async () => {
    const handleOk = vi.fn();
    const handleCancel = vi.fn();
    const progress: SaveProgressInfo = {
      stage: 'encrypting',
      percent: 46,
      message: '加密中...',
    };

    render(
      <SaveDocumentModal
        open
        confirmLoading
        saving
        saveProgress={progress}
        onOk={handleOk}
        onCancel={handleCancel}
      />,
    );

    expect(screen.getByText('加密中...')).toBeInTheDocument();
    const progressEl = document.querySelector('.ant-progress');
    expect(progressEl).toBeTruthy();
  });

  it('保存中会限制取消关闭，保存结束后恢复正常关闭行为', async () => {
    const handleOk = vi.fn();
    const handleCancel = vi.fn();
    const user = userEvent.setup();

    const { rerender } = render(
      <SaveDocumentModal
        open
        confirmLoading
        saving
        saveProgress={{ stage: 'encrypting', percent: 30, message: '加密中...' }}
        onOk={handleOk}
        onCancel={handleCancel}
      />,
    );

    // cancel button is disabled during saving
    const cancelButton = screen.getByRole('button', { name: /取.*消/ });
    expect(cancelButton).toBeDisabled();

    // re-render with saving=false
    rerender(
      <SaveDocumentModal
        open
        confirmLoading={false}
        saving={false}
        saveProgress={null}
        onOk={handleOk}
        onCancel={handleCancel}
      />,
    );

    const cancelButtonAfter = screen.getByRole('button', { name: /取.*消/ });
    expect(cancelButtonAfter).not.toBeDisabled();

    await user.click(cancelButtonAfter);
    expect(handleCancel).toHaveBeenCalled();
  });

  it('打开时使用默认版本号和空备注', async () => {
    const handleOk = vi.fn();
    const handleCancel = vi.fn();

    render(
      <SaveDocumentModal
        open
        confirmLoading={false}
        onOk={handleOk}
        onCancel={handleCancel}
      />,
    );

    const versionInput = screen.getByLabelText('版本号') as HTMLInputElement;
    const remarkInput = screen.getByLabelText('备注') as HTMLTextAreaElement;

    expect(versionInput.value).toBe('V1.0.0');
    expect(remarkInput.value).toBe('');
  });

  it('取消时调用 onCancel，且不校验表单', async () => {
    const handleOk = vi.fn();
    const handleCancel = vi.fn();
    const user = userEvent.setup();

    render(
      <SaveDocumentModal
        open
        confirmLoading={false}
        onOk={handleOk}
        onCancel={handleCancel}
      />,
    );

    await user.click(screen.getByRole('button', { name: /取.*消/ }));

    expect(handleCancel).toHaveBeenCalled();
    expect(handleOk).not.toHaveBeenCalled();
  });

  it('共享模式下保存前会执行异步版本校验', async () => {
    const handleOk = vi.fn();
    const handleCancel = vi.fn();
    const validateVersion = vi.fn().mockResolvedValue(undefined);
    const user = userEvent.setup();

    render(
      <SaveDocumentModal
        open
        confirmLoading={false}
        onOk={handleOk}
        onCancel={handleCancel}
        defaultVersion="V2.0.0"
        validateVersion={validateVersion}
      />,
    );

    await user.clear(screen.getByLabelText('版本号'));
    await user.type(screen.getByLabelText('版本号'), 'V2.1.0');
    await user.click(screen.getByRole('button', { name: /保\s*存/ }));

    await waitFor(() => {
      expect(validateVersion).toHaveBeenCalledWith('V2.1.0');
      expect(handleOk).toHaveBeenCalledWith({ version: 'V2.1.0', remark: '' });
    });
  });
});

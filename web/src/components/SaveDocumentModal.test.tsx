import { describe, expect, it, vi } from 'vitest';
import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import SaveDocumentModal from './SaveDocumentModal';

describe('SaveDocumentModal', () => {
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
});

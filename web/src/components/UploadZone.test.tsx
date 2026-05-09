import React from 'react';
import { describe, expect, it, vi, beforeEach } from 'vitest';
import { render, screen, fireEvent } from '@testing-library/react';
import '@testing-library/jest-dom/vitest';
import UploadZone from './UploadZone';

const { startNewUpload, setUploading, success, error } = vi.hoisted(() => ({
  startNewUpload: vi.fn(),
  setUploading: vi.fn(),
  success: vi.fn(),
  error: vi.fn(),
}));

vi.mock('../store/useDocStore', () => ({
  useDocStore: () => ({
    startNewUpload,
    setUploading,
  }),
}));

vi.mock('antd', async () => {
  const actual = await vi.importActual<typeof import('antd')>('antd');
  const ReactModule = await vi.importActual<typeof import('react')>('react');

  const Upload = ({ beforeUpload, children }: { beforeUpload?: (file: File) => boolean; children: React.ReactNode }) => (
    <div>
      <input
        data-testid="upload-input"
        type="file"
        onChange={(event) => {
          const file = event.target.files?.[0];
          if (file && beforeUpload) {
            beforeUpload(file);
          }
        }}
      />
      {children}
    </div>
  );

  Upload.Dragger = ({ beforeUpload, children }: { beforeUpload?: (file: File) => boolean; children: React.ReactNode }) => (
    <div>
      <input
        data-testid="upload-dragger-input"
        type="file"
        onChange={(event) => {
          const file = event.target.files?.[0];
          if (file && beforeUpload) {
            beforeUpload(file);
          }
        }}
      />
      {children}
    </div>
  );
  Upload.LIST_IGNORE = Symbol('LIST_IGNORE');

  return {
    ...actual,
    Upload,
    Button: ({ children, ...props }: React.ComponentProps<'button'>) => ReactModule.createElement('button', props, children),
    message: {
      success,
      error,
    },
  };
});

describe('UploadZone', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.useFakeTimers();
  });

  it('重新上传 DOCX 后会走新上传重置逻辑', async () => {
    render(<UploadZone variant="button" />);

    const input = screen.getByTestId('upload-input');
    const file = new File(['doc'], 'new.docx', {
      type: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
    });

    fireEvent.change(input, { target: { files: [file] } });
    vi.advanceTimersByTime(500);

    expect(startNewUpload).toHaveBeenCalledWith(file);
    expect(setUploading).toHaveBeenNthCalledWith(1, true);
    expect(setUploading).toHaveBeenLastCalledWith(false);
    expect(success).toHaveBeenCalledWith('new.docx 上传成功');
  });
});

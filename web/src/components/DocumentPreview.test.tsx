import React from 'react';
import { describe, expect, it, vi, beforeEach, afterEach } from 'vitest';
import { render, waitFor } from '@testing-library/react';
import '@testing-library/jest-dom/vitest';
import DocumentPreview from './DocumentPreview';

const renderAsyncMock = vi.fn(async (_data: ArrayBuffer, container: HTMLElement) => {
  container.innerHTML = '<div class="docx"><p>预览内容</p></div>';
});

const docStoreState = {
  currentFile: null as File | null,
  headings: [],
  checkedKeys: [],
};

vi.mock('docx-preview', () => ({
  renderAsync: (...args: unknown[]) => renderAsyncMock(...args),
}));

vi.mock('../store/useDocStore', () => ({
  useDocStore: () => docStoreState,
}));

vi.mock('../utils/docParser', () => ({
  flattenHeadings: vi.fn(() => []),
}));

vi.mock('../utils/styleMapper', () => ({
  StyleMapper: class {
    applyGeneric() {}
    applyHeadingClasses() {}
    destroy() {}
  },
}));

describe('DocumentPreview', () => {
  const originalRequestAnimationFrame = globalThis.requestAnimationFrame;

  beforeEach(() => {
    vi.clearAllMocks();
    docStoreState.currentFile = new File(['doc'], 'preview.docx', {
      type: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
    });
    docStoreState.headings = [];
    docStoreState.checkedKeys = [];
    globalThis.requestAnimationFrame = ((callback: FrameRequestCallback) => {
      callback(0);
      return 0;
    }) as typeof requestAnimationFrame;
  });

  afterEach(() => {
    globalThis.requestAnimationFrame = originalRequestAnimationFrame;
  });

  it('优先使用传入的 arrayBuffer，不再读取 currentFile.arrayBuffer', async () => {
    const cachedArrayBuffer = new ArrayBuffer(32);
    const fileArrayBufferSpy = vi.spyOn(docStoreState.currentFile!, 'arrayBuffer');

    render(<DocumentPreview arrayBuffer={cachedArrayBuffer} />);

    await waitFor(() => {
      expect(renderAsyncMock).toHaveBeenCalled();
    });

    expect(fileArrayBufferSpy).not.toHaveBeenCalled();
    expect(renderAsyncMock.mock.calls[0]?.[0]).toBe(cachedArrayBuffer);
  });
});

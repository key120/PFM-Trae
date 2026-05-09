import { beforeEach, describe, expect, it } from 'vitest';
import { useDocStore } from './useDocStore';

describe('useDocStore', () => {
  beforeEach(() => {
    useDocStore.getState().reset();
  });

  it('reset 时会清空共享文档编辑上下文', () => {
    useDocStore.getState().setDocumentMode('shared');
    useDocStore.getState().setDocumentAccessRole('member');
    useDocStore.getState().setCurrentTeamScopedShare(true);

    useDocStore.getState().reset();

    expect(useDocStore.getState().documentMode).toBeNull();
    expect(useDocStore.getState().documentAccessRole).toBeNull();
    expect(useDocStore.getState().currentTeamScopedShare).toBe(false);
  });

  it('startNewUpload 时会切回个人文档上下文', () => {
    const file = new File(['content'], 'new.docx', {
      type: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
    });

    useDocStore.getState().setDocumentMode('shared');
    useDocStore.getState().setDocumentAccessRole('member');
    useDocStore.getState().setCurrentTeamScopedShare(true);
    useDocStore.getState().setCurrentDocumentId('shared-doc');
    useDocStore.getState().setCurrentDocumentVersion('V2.0.0');
    useDocStore.getState().setInitialCheckedKeys(['k1']);
    useDocStore.getState().setCheckedKeys(['k1']);

    useDocStore.getState().startNewUpload(file);

    expect(useDocStore.getState().currentFile).toBe(file);
    expect(useDocStore.getState().documentMode).toBe('personal');
    expect(useDocStore.getState().documentAccessRole).toBe('owner');
    expect(useDocStore.getState().currentTeamScopedShare).toBe(false);
    expect(useDocStore.getState().currentDocumentId).toBeNull();
    expect(useDocStore.getState().currentDocumentVersion).toBeNull();
    expect(useDocStore.getState().initialCheckedKeys).toBeNull();
    expect(useDocStore.getState().checkedKeys).toEqual([]);
  });
});

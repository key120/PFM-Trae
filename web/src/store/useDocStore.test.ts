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
});

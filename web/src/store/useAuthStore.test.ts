import { describe, expect, it, vi, beforeEach } from 'vitest';
import type { Session, User } from '@supabase/supabase-js';

const ensureUserKeyPair = vi.fn();

const supabaseAuthMock = {
  getSession: vi.fn(),
  onAuthStateChange: vi.fn(),
  signOut: vi.fn(),
};

vi.mock('../lib/supabase', () => ({
  supabase: {
    auth: supabaseAuthMock,
  },
}));

vi.mock('../services/cryptoKeyService', () => ({
  ensureUserKeyPair,
}));

vi.mock('./useDocStore', () => ({
  useDocStore: {
    getState: () => ({
      reset: vi.fn(),
    }),
  },
}));

describe('useAuthStore 密钥初始化集成', () => {
  beforeEach(() => {
    ensureUserKeyPair.mockReset();
    const user: Partial<User> = { id: 'user-1' };
    const session: Partial<Session> = { user: user as User };

    supabaseAuthMock.getSession.mockResolvedValue({
      data: { session: session as Session },
    });
  });

  it('initialize 时会调用 ensureUserKeyPair', async () => {
    const { useAuthStore } = await import('./useAuthStore');

    await useAuthStore.getState().initialize();

    expect(ensureUserKeyPair).toHaveBeenCalled();
    const callArg = ensureUserKeyPair.mock.calls[0][0] as User;
    expect(callArg.id).toBe('user-1');
  });
});

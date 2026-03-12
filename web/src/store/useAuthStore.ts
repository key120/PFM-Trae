import { create } from 'zustand';
import { Session, User } from '@supabase/supabase-js';
import { supabase } from '../lib/supabase';
import { useDocStore } from './useDocStore';

interface AuthState {
  user: User | null;
  session: Session | null;
  loading: boolean;
  initialized: boolean;
  initialize: () => Promise<void>;
  signOut: () => Promise<void>;
}

let lastUserId: string | null = null;

export const useAuthStore = create<AuthState>((set, get) => ({
  user: null,
  session: null,
  loading: true,
  initialized: false,
  initialize: async () => {
    if (get().initialized) return;
    
    const { data: { session } } = await supabase.auth.getSession();
    const user = session?.user ?? null;
    if (user?.id !== lastUserId) {
      useDocStore.getState().reset();
      lastUserId = user?.id ?? null;
    }
    set({ session, user, loading: false, initialized: true });

    supabase.auth.onAuthStateChange((_event, session) => {
      const nextUser = session?.user ?? null;
      if (nextUser?.id !== lastUserId) {
        useDocStore.getState().reset();
        lastUserId = nextUser?.id ?? null;
      }
      set({ session, user: nextUser ?? null, loading: false });
    });
  },
  signOut: async () => {
    await supabase.auth.signOut();
    useDocStore.getState().reset();
    lastUserId = null;
    set({ session: null, user: null });
  },
}));

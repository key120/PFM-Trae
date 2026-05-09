import { create } from 'zustand';
import type { HeadingNode } from '../utils/docParser';

interface DocState {
  currentFile: File | null;
  isUploading: boolean;
  isParsing: boolean;
  headings: HeadingNode[];
  checkedKeys: string[];
  currentDocumentId: string | null;
  currentDocumentVersion: string | null;
  initialCheckedKeys: string[] | null;
  documentMode: 'personal' | 'shared' | null;
  documentAccessRole: 'owner' | 'member' | null;
  currentTeamScopedShare: boolean;

  setFile: (file: File | null) => void;
  setUploading: (status: boolean) => void;
  setParsing: (status: boolean) => void;
  setHeadings: (headings: HeadingNode[]) => void;
  setCheckedKeys: (keys: string[]) => void;
  setCurrentDocumentId: (id: string | null) => void;
  setCurrentDocumentVersion: (version: string | null) => void;
  setInitialCheckedKeys: (keys: string[] | null) => void;
  setDocumentMode: (mode: 'personal' | 'shared' | null) => void;
  setDocumentAccessRole: (role: 'owner' | 'member' | null) => void;
  setCurrentTeamScopedShare: (shared: boolean) => void;
  reset: () => void;
}

export const useDocStore = create<DocState>((set) => ({
  currentFile: null,
  isUploading: false,
  isParsing: false,
  headings: [],
  checkedKeys: [],
  currentDocumentId: null,
  currentDocumentVersion: null,
  initialCheckedKeys: null,
  documentMode: null,
  documentAccessRole: null,
  currentTeamScopedShare: false,

  setFile: (file) => set({ currentFile: file }),
  setUploading: (status) => set({ isUploading: status }),
  setParsing: (status) => set({ isParsing: status }),
  setHeadings: (headings) => set({ headings }),
  setCheckedKeys: (keys) => set({ checkedKeys: keys }),
  setCurrentDocumentId: (id) => set({ currentDocumentId: id }),
  setCurrentDocumentVersion: (version) => set({ currentDocumentVersion: version }),
  setInitialCheckedKeys: (keys) => set({ initialCheckedKeys: keys }),
  setDocumentMode: (mode) => set({ documentMode: mode }),
  setDocumentAccessRole: (role) => set({ documentAccessRole: role }),
  setCurrentTeamScopedShare: (shared) => set({ currentTeamScopedShare: shared }),
  reset: () =>
    set({
      currentFile: null,
      isUploading: false,
      isParsing: false,
      headings: [],
      checkedKeys: [],
      currentDocumentId: null,
      currentDocumentVersion: null,
      initialCheckedKeys: null,
      documentMode: null,
      documentAccessRole: null,
      currentTeamScopedShare: false,
    }),
}));

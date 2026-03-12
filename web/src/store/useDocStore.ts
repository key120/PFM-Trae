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
  
  // Actions
  setFile: (file: File | null) => void;
  setUploading: (status: boolean) => void;
  setParsing: (status: boolean) => void;
  setHeadings: (headings: HeadingNode[]) => void;
  setCheckedKeys: (keys: string[]) => void;
  setCurrentDocumentId: (id: string | null) => void;
  setCurrentDocumentVersion: (version: string | null) => void;
  setInitialCheckedKeys: (keys: string[] | null) => void;
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

  setFile: (file) =>
    set({ currentFile: file, currentDocumentId: null, currentDocumentVersion: null }),
  setUploading: (status) => set({ isUploading: status }),
  setParsing: (status) => set({ isParsing: status }),
  setHeadings: (headings) => set({ headings }),
  setCheckedKeys: (keys) => set({ checkedKeys: keys }),
  setCurrentDocumentId: (id) => set({ currentDocumentId: id }),
   setCurrentDocumentVersion: (version) =>
    set({ currentDocumentVersion: version }),
  setInitialCheckedKeys: (keys) => set({ initialCheckedKeys: keys }),
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
    }),
}));

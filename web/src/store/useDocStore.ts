import { create } from 'zustand';
import type { HeadingNode } from '../utils/docParser';

interface DocState {
  currentFile: File | null;
  isUploading: boolean;
  isParsing: boolean;
  headings: HeadingNode[];
  checkedKeys: string[];
  
  // Actions
  setFile: (file: File | null) => void;
  setUploading: (status: boolean) => void;
  setParsing: (status: boolean) => void;
  setHeadings: (headings: HeadingNode[]) => void;
  setCheckedKeys: (keys: string[]) => void;
  reset: () => void;
}

export const useDocStore = create<DocState>((set) => ({
  currentFile: null,
  isUploading: false,
  isParsing: false,
  headings: [],
  checkedKeys: [],

  setFile: (file) => set({ currentFile: file }),
  setUploading: (status) => set({ isUploading: status }),
  setParsing: (status) => set({ isParsing: status }),
  setHeadings: (headings) => set({ headings }),
  setCheckedKeys: (keys) => set({ checkedKeys: keys }),
  reset: () => set({ currentFile: null, isUploading: false, isParsing: false, headings: [], checkedKeys: [] }),
}));

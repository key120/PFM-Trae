/**
 * documentSaveProgress.ts
 *
 * Save progress model for the document save pipeline.
 * Provides stage-based progress tracking with Chinese UI text,
 * and a helper to compute percentage from chunk-level encryption progress.
 */

export type SaveProgressStage =
  | 'preparing'
  | 'encrypting'
  | 'uploading'
  | 'persisting'
  | 'done'
  | 'failed';

export type SaveProgressInfo = {
  stage: SaveProgressStage;
  percent: number; // 0-100
  message: string; // Chinese text for UI display
  encryptingProgress?: { chunkIndex: number; totalChunks: number }; // only during 'encrypting'
};

export type SaveProgressCallback = (info: SaveProgressInfo) => void;

const STAGE_MESSAGES: Record<SaveProgressStage, string> = {
  preparing: '准备中...',
  encrypting: '加密中...',
  uploading: '上传中...',
  persisting: '保存中...',
  done: '保存完成',
  failed: '保存失败',
};

/**
 * Compute SaveProgressInfo from a stage and optional chunk-level encryption progress.
 *
 * Percentage mapping:
 * - preparing: 0-10%
 * - encrypting: 10-65% (mapped from chunkIndex/totalChunks)
 * - uploading: 65-90%
 * - persisting: 90-99%
 * - done: 100%
 * - failed: defaults to 0
 */
export function computeSaveProgress(
  stage: SaveProgressStage,
  encryptingProgress?: { chunkIndex: number; totalChunks: number },
): SaveProgressInfo {
  let percent: number;

  switch (stage) {
    case 'preparing':
      percent = 0;
      break;
    case 'encrypting': {
      if (encryptingProgress && encryptingProgress.totalChunks > 0) {
        percent = 10 + Math.floor((encryptingProgress.chunkIndex / encryptingProgress.totalChunks) * 55);
      } else {
        percent = 10;
      }
      break;
    }
    case 'uploading':
      percent = 65;
      break;
    case 'persisting':
      percent = 90;
      break;
    case 'done':
      percent = 100;
      break;
    case 'failed':
      percent = 0;
      break;
  }

  return {
    stage,
    percent,
    message: STAGE_MESSAGES[stage],
    encryptingProgress: stage === 'encrypting' ? encryptingProgress : undefined,
  };
}

/**
 * 基于文件大小估算保存总耗时（毫秒）。
 * 加密约 20 MB/s，上传约 2 MB/s，固定开销约 1s。
 */
export function estimateSaveDuration(fileSizeBytes: number): number {
  const mb = fileSizeBytes / (1024 * 1024);
  const encryptionMs = (mb / 20) * 1000;
  const uploadMs = (mb / 2) * 1000;
  const fixedOverheadMs = 1000;
  return Math.max(encryptionMs + uploadMs + fixedOverheadMs, 2000);
}

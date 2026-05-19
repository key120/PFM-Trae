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

/** 每个阶段的最大允许百分比 */
const STAGE_UPPER_BOUNDS: Record<SaveProgressStage, number> = {
  preparing: 5,
  encrypting: 30,
  uploading: 85,
  persisting: 99,
  done: 100,
  failed: 0,
};

export class SmoothProgressTracker {
  private startTime: number;
  private currentStage: SaveProgressStage = 'preparing';
  private estimatedTotal: number;
  private encryptingProgress?: { chunkIndex: number; totalChunks: number };
  private animFrameId: number | null = null;
  private callback: SaveProgressCallback;

  constructor(callback: SaveProgressCallback) {
    this.startTime = Date.now();
    this.estimatedTotal = 5000; // 初始保守估计
    this.callback = callback;
    this.startAnimation();
  }

  onStageChange(
    stage: SaveProgressStage,
    encryptingProgress?: { chunkIndex: number; totalChunks: number },
  ): void {
    // 进入新阶段时，用已完成阶段的实际耗时更新预估总时间
    if (stage !== this.currentStage) {
      const elapsed = Date.now() - this.startTime;
      const prevUpperBound = STAGE_UPPER_BOUNDS[this.currentStage];
      this.currentStage = stage;

      // 用已完成阶段的耗时和其上限百分比来估算总时间
      if (prevUpperBound > 0) {
        this.estimatedTotal = (elapsed / prevUpperBound) * 100;
      }
    }

    if (stage === 'encrypting' && encryptingProgress) {
      this.encryptingProgress = encryptingProgress;
    }
  }

  getCurrentProgress(): SaveProgressInfo {
    return {
      stage: this.currentStage,
      percent: this.computePercent(),
      message: STAGE_MESSAGES[this.currentStage],
      encryptingProgress:
        this.currentStage === 'encrypting' ? this.encryptingProgress : undefined,
    };
  }

  dispose(): void {
    if (this.animFrameId !== null) {
      cancelAnimationFrame(this.animFrameId);
      this.animFrameId = null;
    }
  }

  private computePercent(): number {
    const upperBound = STAGE_UPPER_BOUNDS[this.currentStage];

    if (this.currentStage === 'done') return 100;
    if (this.currentStage === 'failed') return 0;

    const elapsed = Date.now() - this.startTime;
    const rawPercent = this.estimatedTotal > 0
      ? (elapsed / this.estimatedTotal) * 100
      : 0;

    // 加密阶段：融合时间插值与 chunk 进度
    if (this.currentStage === 'encrypting' && this.encryptingProgress) {
      const { chunkIndex, totalChunks } = this.encryptingProgress;
      const chunkPercent = totalChunks > 0
        ? (chunkIndex / totalChunks) * upperBound
        : upperBound;
      return Math.floor(Math.min(Math.max(rawPercent, chunkPercent), upperBound));
    }

    return Math.floor(Math.min(rawPercent, upperBound));
  }

  private startAnimation(): void {
    const tick = () => {
      this.callback(this.getCurrentProgress());
      this.animFrameId = requestAnimationFrame(tick);
    };
    this.animFrameId = requestAnimationFrame(tick);
  }
}

export function createSmoothProgressTracker(callback: SaveProgressCallback): SmoothProgressTracker {
  return new SmoothProgressTracker(callback);
}

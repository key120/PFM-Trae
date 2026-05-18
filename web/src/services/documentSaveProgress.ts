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
  private stageStartTime: number;
  private currentStage: SaveProgressStage = 'preparing';
  private completedStageElapsed = 0;
  private estimatedTotal: number;
  private lastPercent = 0;
  private encryptingProgress?: { chunkIndex: number; totalChunks: number };

  constructor() {
    this.startTime = Date.now();
    this.stageStartTime = this.startTime;
    this.estimatedTotal = 5000; // 初始保守估计
  }

  onStageChange(
    stage: SaveProgressStage,
    encryptingProgress?: { chunkIndex: number; totalChunks: number },
  ): SaveProgressInfo {
    // 进入新阶段时，累加前一阶段的耗时
    if (stage !== this.currentStage) {
      this.completedStageElapsed += Date.now() - this.stageStartTime;
      this.stageStartTime = Date.now();
      this.currentStage = stage;
    }

    if (stage === 'encrypting' && encryptingProgress) {
      this.encryptingProgress = encryptingProgress;
    }

    this.updateEstimatedTotal();

    return this.getCurrentProgress();
  }

  getCurrentProgress(): SaveProgressInfo {
    const percent = this.computePercent();
    return {
      stage: this.currentStage,
      percent,
      message: STAGE_MESSAGES[this.currentStage],
      encryptingProgress:
        this.currentStage === 'encrypting' ? this.encryptingProgress : undefined,
    };
  }

  dispose(): void {
    // 无需清理定时器；方法为 API 一致性保留
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
      const blended = Math.max(rawPercent, chunkPercent);
      this.lastPercent = Math.min(blended, upperBound);
    } else {
      this.lastPercent = Math.min(rawPercent, upperBound);
    }

    return Math.floor(this.lastPercent);
  }

  private updateEstimatedTotal(): number {
    const upperBound = STAGE_UPPER_BOUNDS[this.currentStage];
    if (upperBound <= 0) return this.estimatedTotal;

    const elapsed = Date.now() - this.startTime;
    if (elapsed > 0 && upperBound > 0) {
      this.estimatedTotal = (elapsed / upperBound) * 100;
    }
    return this.estimatedTotal;
  }
}

export function createSmoothProgressTracker(): SmoothProgressTracker {
  return new SmoothProgressTracker();
}

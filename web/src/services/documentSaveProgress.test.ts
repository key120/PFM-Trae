import { describe, expect, it, vi, beforeEach, afterEach } from 'vitest';
import { computeSaveProgress, SmoothProgressTracker } from './documentSaveProgress';

describe('computeSaveProgress', () => {
  it('preparing 阶段返回 0%', () => {
    const result = computeSaveProgress('preparing');
    expect(result.stage).toBe('preparing');
    expect(result.percent).toBe(0);
    expect(result.message).toBe('准备中...');
    expect(result.encryptingProgress).toBeUndefined();
  });

  it('encrypting 阶段按 chunkIndex/totalChunks 映射到 10-65%', () => {
    const result = computeSaveProgress('encrypting', { chunkIndex: 2, totalChunks: 3 });
    expect(result.stage).toBe('encrypting');
    expect(result.percent).toBe(46);
    expect(result.message).toBe('加密中...');
    expect(result.encryptingProgress).toEqual({ chunkIndex: 2, totalChunks: 3 });
  });

  it('encrypting 阶段 totalChunks=0 时返回 10%', () => {
    const result = computeSaveProgress('encrypting', { chunkIndex: 0, totalChunks: 0 });
    expect(result.percent).toBe(10);
  });

  it('encrypting 阶段 chunkIndex=0 时返回 10%', () => {
    const result = computeSaveProgress('encrypting', { chunkIndex: 0, totalChunks: 5 });
    expect(result.percent).toBe(10);
  });

  it('encrypting 阶段最后一块时接近 65% 但不到 65%', () => {
    const result = computeSaveProgress('encrypting', { chunkIndex: 9, totalChunks: 10 });
    expect(result.percent).toBe(59);
    expect(result.percent).toBeLessThan(65);
  });

  it('uploading 阶段返回 65%', () => {
    const result = computeSaveProgress('uploading');
    expect(result.stage).toBe('uploading');
    expect(result.percent).toBe(65);
    expect(result.message).toBe('上传中...');
    expect(result.encryptingProgress).toBeUndefined();
  });

  it('persisting 阶段返回 90%', () => {
    const result = computeSaveProgress('persisting');
    expect(result.stage).toBe('persisting');
    expect(result.percent).toBe(90);
    expect(result.message).toBe('保存中...');
  });

  it('done 阶段返回 100%', () => {
    const result = computeSaveProgress('done');
    expect(result.stage).toBe('done');
    expect(result.percent).toBe(100);
    expect(result.message).toBe('保存完成');
  });

  it('failed 阶段默认返回 0%', () => {
    const result = computeSaveProgress('failed');
    expect(result.stage).toBe('failed');
    expect(result.percent).toBe(0);
    expect(result.message).toBe('保存失败');
  });
});

describe('SmoothProgressTracker', () => {
  let mockRAF: ReturnType<typeof vi.fn>;
  let mockCAF: ReturnType<typeof vi.fn>;
  let rafCallback: FrameRequestCallback | null;

  beforeEach(() => {
    rafCallback = null;
    mockRAF = vi.fn((cb: FrameRequestCallback) => {
      rafCallback = cb;
      return 1;
    });
    mockCAF = vi.fn();
    vi.stubGlobal('requestAnimationFrame', mockRAF);
    vi.stubGlobal('cancelAnimationFrame', mockCAF);
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('初始阶段返回 preparing 且 percent 为 0', () => {
    const tracker = new SmoothProgressTracker(() => {});
    const result = tracker.getCurrentProgress();
    expect(result.stage).toBe('preparing');
    expect(result.percent).toBe(0);
    expect(result.message).toBe('准备中...');
    tracker.dispose();
  });

  it('构造时启动动画循环', () => {
    const tracker = new SmoothProgressTracker(() => {});
    expect(mockRAF).toHaveBeenCalled();
    tracker.dispose();
  });

  it('dispose 取消动画循环', () => {
    const tracker = new SmoothProgressTracker(() => {});
    tracker.dispose();
    expect(mockCAF).toHaveBeenCalled();
  });

  it('onStageChange 后 getCurrentProgress 返回新阶段', () => {
    const tracker = new SmoothProgressTracker(() => {});
    tracker.onStageChange('encrypting');
    expect(tracker.getCurrentProgress().stage).toBe('encrypting');
    tracker.dispose();
  });

  it('进度不超过当前阶段上限', () => {
    const tracker = new SmoothProgressTracker(() => {});
    tracker.onStageChange('encrypting');
    expect(tracker.getCurrentProgress().percent).toBeLessThanOrEqual(30);
    tracker.dispose();
  });

  it('encrypting 阶段带 chunk 进度时在子范围内', () => {
    const tracker = new SmoothProgressTracker(() => {});
    tracker.onStageChange('encrypting', { chunkIndex: 1, totalChunks: 2 });
    const result = tracker.getCurrentProgress();
    expect(result.percent).toBeGreaterThanOrEqual(0);
    expect(result.percent).toBeLessThanOrEqual(30);
    tracker.dispose();
  });

  it('uploading 阶段上限为 85%', () => {
    const tracker = new SmoothProgressTracker(() => {});
    tracker.onStageChange('uploading');
    expect(tracker.getCurrentProgress().percent).toBeLessThanOrEqual(85);
    expect(tracker.getCurrentProgress().stage).toBe('uploading');
    tracker.dispose();
  });

  it('persisting 阶段上限为 99%', () => {
    const tracker = new SmoothProgressTracker(() => {});
    tracker.onStageChange('persisting');
    expect(tracker.getCurrentProgress().percent).toBeLessThanOrEqual(99);
    expect(tracker.getCurrentProgress().stage).toBe('persisting');
    tracker.dispose();
  });

  it('done 阶段返回 100%', () => {
    const tracker = new SmoothProgressTracker(() => {});
    tracker.onStageChange('done');
    expect(tracker.getCurrentProgress().percent).toBe(100);
    expect(tracker.getCurrentProgress().message).toBe('保存完成');
    tracker.dispose();
  });

  it('failed 阶段返回 0%', () => {
    const tracker = new SmoothProgressTracker(() => {});
    tracker.onStageChange('failed');
    expect(tracker.getCurrentProgress().percent).toBe(0);
    expect(tracker.getCurrentProgress().message).toBe('保存失败');
    tracker.dispose();
  });

  it('dispose 后 getCurrentProgress 仍可调用', () => {
    const tracker = new SmoothProgressTracker(() => {});
    tracker.onStageChange('uploading');
    tracker.dispose();
    const result = tracker.getCurrentProgress();
    expect(result.stage).toBe('uploading');
  });

  it('动画循环调用回调', () => {
    const callback = vi.fn();
    const tracker = new SmoothProgressTracker(callback);
    rafCallback?.(performance.now());
    expect(callback).toHaveBeenCalled();
    tracker.dispose();
  });
});

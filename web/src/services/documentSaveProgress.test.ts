import { describe, expect, it } from 'vitest';
import { computeSaveProgress } from './documentSaveProgress';

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
    expect(result.percent).toBe(46); // 10 + floor(2/3 * 55) = 10 + 36 = 46
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
    // 10 + floor(9/10 * 55) = 10 + 49 = 59
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

import { SmoothProgressTracker } from './documentSaveProgress';

describe('SmoothProgressTracker', () => {
  it('初始阶段返回 preparing 且 percent 为 0', () => {
    const tracker = new SmoothProgressTracker();
    const result = tracker.getCurrentProgress();
    expect(result.stage).toBe('preparing');
    expect(result.percent).toBe(0);
    expect(result.message).toBe('准备中...');
    tracker.dispose();
  });

  it('阶段推进时进度单调递增', () => {
    const tracker = new SmoothProgressTracker();
    const p1 = tracker.onStageChange('preparing');
    const p2 = tracker.onStageChange('encrypting');
    const p3 = tracker.onStageChange('uploading');
    expect(p2.percent).toBeGreaterThanOrEqual(p1.percent);
    expect(p3.percent).toBeGreaterThanOrEqual(p2.percent);
    tracker.dispose();
  });

  it('进度不超过当前阶段上限', () => {
    const tracker = new SmoothProgressTracker();
    tracker.onStageChange('preparing');
    const result = tracker.onStageChange('encrypting');
    expect(result.percent).toBeLessThanOrEqual(30);
    tracker.dispose();
  });

  it('encrypting 阶段带 chunk 进度时在子范围内', () => {
    const tracker = new SmoothProgressTracker();
    tracker.onStageChange('preparing');
    const half = tracker.onStageChange('encrypting', { chunkIndex: 1, totalChunks: 2 });
    const full = tracker.onStageChange('encrypting', { chunkIndex: 2, totalChunks: 2 });
    expect(half.percent).toBeGreaterThanOrEqual(0);
    expect(half.percent).toBeLessThanOrEqual(30);
    expect(full.percent).toBeGreaterThanOrEqual(half.percent);
    expect(full.percent).toBeLessThanOrEqual(30);
    tracker.dispose();
  });

  it('uploading 阶段上限为 85%', () => {
    const tracker = new SmoothProgressTracker();
    tracker.onStageChange('preparing');
    tracker.onStageChange('encrypting');
    const result = tracker.onStageChange('uploading');
    expect(result.percent).toBeLessThanOrEqual(85);
    expect(result.stage).toBe('uploading');
    tracker.dispose();
  });

  it('persisting 阶段上限为 99%', () => {
    const tracker = new SmoothProgressTracker();
    tracker.onStageChange('preparing');
    tracker.onStageChange('encrypting');
    tracker.onStageChange('uploading');
    const result = tracker.onStageChange('persisting');
    expect(result.percent).toBeLessThanOrEqual(99);
    expect(result.stage).toBe('persisting');
    tracker.dispose();
  });

  it('done 阶段返回 100%', () => {
    const tracker = new SmoothProgressTracker();
    const result = tracker.onStageChange('done');
    expect(result.percent).toBe(100);
    expect(result.message).toBe('保存完成');
    tracker.dispose();
  });

  it('failed 阶段返回 0%', () => {
    const tracker = new SmoothProgressTracker();
    const result = tracker.onStageChange('failed');
    expect(result.percent).toBe(0);
    expect(result.message).toBe('保存失败');
    tracker.dispose();
  });

  it('dispose 后 getCurrentProgress 返回最后状态', () => {
    const tracker = new SmoothProgressTracker();
    tracker.onStageChange('uploading');
    tracker.dispose();
    const result = tracker.getCurrentProgress();
    expect(result.stage).toBe('uploading');
  });
});

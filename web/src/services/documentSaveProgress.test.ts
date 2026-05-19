import { describe, expect, it } from 'vitest';
import { computeSaveProgress, estimateSaveDuration } from './documentSaveProgress';

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

describe('estimateSaveDuration', () => {
  it('小文件（500KB）估算约 2s（最小值）', () => {
    const ms = estimateSaveDuration(500 * 1024);
    expect(ms).toBeGreaterThanOrEqual(2000);
    expect(ms).toBeLessThan(3000);
  });

  it('1MB 文件估算约 2.5s', () => {
    const ms = estimateSaveDuration(1024 * 1024);
    // 0.5/20*1000 + 0.5/2*1000 + 1000 = 25 + 250 + 1000 = 1275, capped at 2000
    expect(ms).toBeGreaterThanOrEqual(2000);
    expect(ms).toBeLessThan(3000);
  });

  it('5MB 文件估算约 3.7s', () => {
    const ms = estimateSaveDuration(5 * 1024 * 1024);
    // 5/20*1000 + 5/2*1000 + 1000 = 250 + 2500 + 1000 = 3750
    expect(ms).toBeGreaterThanOrEqual(3500);
    expect(ms).toBeLessThan(4000);
  });

  it('20MB 文件估算约 12s', () => {
    const ms = estimateSaveDuration(20 * 1024 * 1024);
    // 20/20*1000 + 20/2*1000 + 1000 = 1000 + 10000 + 1000 = 12000
    expect(ms).toBeGreaterThanOrEqual(11000);
    expect(ms).toBeLessThan(13000);
  });

  it('返回值始终 >= 2000ms', () => {
    expect(estimateSaveDuration(0)).toBeGreaterThanOrEqual(2000);
    expect(estimateSaveDuration(100)).toBeGreaterThanOrEqual(2000);
  });
});

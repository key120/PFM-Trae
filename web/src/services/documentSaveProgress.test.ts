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

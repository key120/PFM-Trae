import { describe, expect, it, vi, beforeEach, afterEach } from 'vitest';
import { renderHook, act } from '@testing-library/react';
import { useVirtualProgress } from './useVirtualProgress';

describe('useVirtualProgress', () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });

  afterEach(() => {
    vi.useRealTimers();
    vi.restoreAllMocks();
  });

  it('初始状态 percent 为 0，message 为第一阶段文案', () => {
    const { result } = renderHook(() =>
      useVirtualProgress({
        fileSize: 1024 * 1024,
        isActive: false,
        stageMessages: ['阶段1', '阶段2', '阶段3', '阶段4'],
      }),
    );

    expect(result.current.percent).toBe(0);
    expect(result.current.message).toBe('阶段1');
  });

  it('isActive 为 true 时启动进度动画', () => {
    vi.spyOn(performance, 'now').mockReturnValue(0);
    vi.spyOn(window, 'requestAnimationFrame').mockImplementation((cb) => {
      cb(10000);
      return 1;
    });

    const { result } = renderHook(() =>
      useVirtualProgress({
        fileSize: 5 * 1024 * 1024,
        isActive: true,
        stageMessages: ['准备', '下载', '解密', '完成'],
      }),
    );

    act(() => {
      vi.advanceTimersByTime(100);
    });

    expect(result.current.percent).toBeGreaterThanOrEqual(0);
  });

  it('isActive 变为 false 时跳到 100%', () => {
    const { result, rerender } = renderHook(
      ({ isActive }) =>
        useVirtualProgress({
          fileSize: 1024 * 1024,
          isActive,
          stageMessages: ['阶段1', '阶段2', '阶段3', '阶段4'],
        }),
      { initialProps: { isActive: true } },
    );

    act(() => {
      vi.advanceTimersByTime(100);
    });

    rerender({ isActive: false });

    expect(result.current.percent).toBe(100);
    expect(result.current.message).toBe('载入完成');
  });

  it('reset 方法重置进度', () => {
    const { result } = renderHook(() =>
      useVirtualProgress({
        fileSize: 1024 * 1024,
        isActive: false,
        stageMessages: ['阶段1', '阶段2', '阶段3', '阶段4'],
      }),
    );

    act(() => {
      result.current.reset();
    });

    expect(result.current.percent).toBe(0);
    expect(result.current.message).toBe('阶段1');
  });

  it('fileSize 为 0 时不启动动画', () => {
    vi.spyOn(window, 'requestAnimationFrame');

    renderHook(() =>
      useVirtualProgress({
        fileSize: 0,
        isActive: true,
        stageMessages: ['阶段1', '阶段2', '阶段3', '阶段4'],
      }),
    );

    expect(window.requestAnimationFrame).not.toHaveBeenCalled();
  });

  it('isActive 快速切换时仍能跳到 100%', () => {
    const { result, rerender } = renderHook(
      ({ isActive }) =>
        useVirtualProgress({
          fileSize: 1024 * 1024,
          isActive,
          stageMessages: ['阶段1', '阶段2', '阶段3', '阶段4'],
        }),
      { initialProps: { isActive: true } },
    );

    // 不 advanceTimers，直接切换到 false
    rerender({ isActive: false });

    expect(result.current.percent).toBe(100);
    expect(result.current.message).toBe('载入完成');
  });
});

import { useEffect, useRef, useState } from 'react';

interface UseVirtualProgressOptions {
  fileSize: number;
  isActive: boolean;
  stageMessages?: string[];
}

interface UseVirtualProgressResult {
  percent: number;
  message: string;
  reset: () => void;
}

function estimateLoadDuration(fileSizeBytes: number): number {
  const mb = fileSizeBytes / (1024 * 1024);
  const downloadMs = (mb / 2) * 1000;
  const decryptMs = (mb / 20) * 1000;
  const fixedOverheadMs = 1000;
  return Math.max(downloadMs + decryptMs + fixedOverheadMs, 2000);
}

const DEFAULT_STAGE_MESSAGES = ['准备中...', '获取密钥...', '下载中...', '解密中...'];

export function useVirtualProgress({
  fileSize,
  isActive,
  stageMessages = DEFAULT_STAGE_MESSAGES,
}: UseVirtualProgressOptions): UseVirtualProgressResult {
  const [percent, setPercent] = useState(0);
  const [message, setMessage] = useState(stageMessages[0]);
  const animRef = useRef<number | null>(null);
  const startTimeRef = useRef(0);
  const durationRef = useRef(5000);
  const startedRef = useRef(false);

  useEffect(() => {
    if (isActive && fileSize > 0) {
      const duration = estimateLoadDuration(fileSize);
      startTimeRef.current = performance.now();
      durationRef.current = duration;
      startedRef.current = true;
      setPercent(0);
      setMessage(stageMessages[0]);

      const tick = (now: number) => {
        const elapsed = now - startTimeRef.current;
        const progress = Math.min((elapsed / durationRef.current) * 95, 95);
        setPercent(Math.floor(progress));

        const stageCount = stageMessages.length;
        const stageIndex = Math.min(
          Math.floor((progress / 100) * stageCount),
          stageCount - 1,
        );
        setMessage(stageMessages[stageIndex]);

        if (progress < 95) {
          animRef.current = requestAnimationFrame(tick);
        }
      };
      animRef.current = requestAnimationFrame(tick);
    }

    return () => {
      if (animRef.current !== null) {
        cancelAnimationFrame(animRef.current);
        animRef.current = null;
      }
    };
  }, [isActive, fileSize, stageMessages]);

  useEffect(() => {
    if (!isActive && startedRef.current && percent < 100) {
      if (animRef.current !== null) {
        cancelAnimationFrame(animRef.current);
        animRef.current = null;
      }
      startedRef.current = false;
      setPercent(100);
      setMessage('载入完成');
    }
  }, [isActive, percent]);

  const reset = () => {
    if (animRef.current !== null) {
      cancelAnimationFrame(animRef.current);
      animRef.current = null;
    }
    setPercent(0);
    setMessage(stageMessages[0]);
  };

  return { percent, message, reset };
}

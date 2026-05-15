import {
  parseDocumentHeadingsResultOnMainThread,
  type DocumentHeadingExtractionResult,
  type HeadingNode,
} from '../utils/docHeadingExtraction';

interface ExtractHeadingsViaWorkerOptions {
  fallback?: () => Promise<DocumentHeadingExtractionResult>;
}

interface ParseDocumentHeadingsViaWorkerOptions {
  fallback?: () => Promise<HeadingNode[]>;
}

const createDefaultFallback = (file: Blob) => async (): Promise<DocumentHeadingExtractionResult> => {
  return parseDocumentHeadingsResultOnMainThread(file);
};

const runFallback = async (
  file: Blob,
  fallback: (() => Promise<DocumentHeadingExtractionResult>) | undefined,
  error: unknown,
): Promise<DocumentHeadingExtractionResult> => {
  console.warn('[docHeadingExtractWorker] Worker unavailable, falling back to main-thread parsing', error);
  return (fallback ?? createDefaultFallback(file))();
};

// Worker 单例：复用已创建的 Worker 实例，避免每次调用都重新创建
let cachedWorker: Worker | null = null;

const getWorker = (): Worker | null => {
  if (cachedWorker) return cachedWorker;
  try {
    const url = new URL('../workers/docHeadingExtract.worker.ts', import.meta.url).href;
    cachedWorker = new Worker(url, { type: 'module' });
    return cachedWorker;
  } catch {
    return null;
  }
};

const invalidateWorker = () => {
  if (cachedWorker) {
    try { cachedWorker.terminate(); } catch { /* ignore */ }
    cachedWorker = null;
  }
};

export const extractHeadingsViaWorker = async (
  file: Blob,
  options: ExtractHeadingsViaWorkerOptions = {},
): Promise<DocumentHeadingExtractionResult> => {
  const worker = getWorker();
  if (!worker) {
    return runFallback(file, options.fallback, new Error('Worker creation failed'));
  }

  return new Promise<DocumentHeadingExtractionResult>((resolve, reject) => {
    const settleWithFallback = (error: unknown) => {
      invalidateWorker();
      runFallback(file, options.fallback, error).then(resolve).catch(reject);
    };

    const timeout = setTimeout(() => {
      invalidateWorker();
      settleWithFallback(new Error('Worker heading extraction timed out'));
    }, 120_000);

    worker.onmessage = (event: MessageEvent) => {
      const message = event.data as
        | { type: 'success'; headings: HeadingNode[]; title: string }
        | { type: 'error'; message: string };

      if (message.type === 'success') {
        clearTimeout(timeout);
        resolve({
          headings: message.headings,
          title: message.title,
        });
        return;
      }

      if (message.type === 'error') {
        clearTimeout(timeout);
        settleWithFallback(new Error(message.message));
      }
    };

    worker.onerror = (event) => {
      clearTimeout(timeout);
      settleWithFallback(event.error ?? new Error(event.message ?? 'Worker heading extraction failed'));
    };

    const arrayBufferPromise = 'arrayBuffer' in file
      ? (file as Blob & { arrayBuffer: () => Promise<ArrayBuffer> }).arrayBuffer()
      : new Promise<ArrayBuffer>((resolve, reject) => {
          const reader = new FileReader();
          reader.onload = () => {
            const result = reader.result;
            if (result instanceof ArrayBuffer) {
              resolve(result);
            } else {
              reject(new Error('Unexpected FileReader result type'));
            }
          };
          reader.onerror = () => reject(reader.error ?? new Error('Failed to read Blob'));
          reader.readAsArrayBuffer(file);
        });

    arrayBufferPromise
      .then((arrayBuffer) => {
        worker.postMessage({ type: 'extract', arrayBuffer }, [arrayBuffer]);
      })
      .catch((error) => {
        clearTimeout(timeout);
        settleWithFallback(error);
      });
  });
};

export const parseDocumentHeadingsViaWorker = async (
  file: Blob,
  options: ParseDocumentHeadingsViaWorkerOptions = {},
): Promise<HeadingNode[]> => {
  const result = await extractHeadingsViaWorker(file, {
    fallback: options.fallback
      ? async () => ({
          headings: (await options.fallback!()) ?? [],
          title: '',
        })
      : undefined,
  });

  return result.headings;
};

export type SaveTelemetryMode = 'personal' | 'shared';

export type SaveTelemetryStep =
  | 'save_started'
  | 'save_finished'
  | 'encryption'
  | 'upload'
  | 'documents_write'
  | 'document_versions_write'
  | 'document_keys_write'
  | 'shared_users_fetch'
  | 'key_distribution';

interface SaveTelemetryContext {
  documentId: string;
  versionId: string;
  mode: SaveTelemetryMode;
  fileSize: number;
}

interface SaveTelemetryExtra {
  memberCount?: number;
  actualDistributed?: number;
  concurrency?: number;
}

type SaveTelemetryStatus = 'start' | 'end' | 'failure';

interface SaveTelemetryPayload extends SaveTelemetryContext, SaveTelemetryExtra {
  step: SaveTelemetryStep;
  status: SaveTelemetryStatus;
  durationMs?: number;
  error?: string;
}

export interface SaveTelemetry {
  markStepStart: (step: SaveTelemetryStep, extra?: SaveTelemetryExtra) => void;
  markStepEnd: (step: SaveTelemetryStep, extra?: SaveTelemetryExtra) => void;
  markFailure: (step: SaveTelemetryStep, error: unknown, extra?: SaveTelemetryExtra) => void;
  finish: (extra?: SaveTelemetryExtra) => void;
}

function getNow(): number {
  if (typeof performance !== 'undefined' && typeof performance.now === 'function') {
    return performance.now();
  }
  return Date.now();
}

function toErrorMessage(error: unknown): string {
  if (error instanceof Error) {
    return error.message;
  }
  return String(error);
}

function safeLog(method: 'info' | 'error', payload: SaveTelemetryPayload): void {
  try {
    console[method]('[document-save]', payload);
  } catch {
    // telemetry is best-effort only
  }
}

export function createSaveTelemetry(context: SaveTelemetryContext): SaveTelemetry {
  const createdAt = getNow();
  const stepStartTimes = new Map<SaveTelemetryStep, number>();

  const buildPayload = (
    step: SaveTelemetryStep,
    status: SaveTelemetryStatus,
    extra?: SaveTelemetryExtra,
    durationMs?: number,
    error?: unknown,
  ): SaveTelemetryPayload => ({
    ...context,
    ...extra,
    step,
    status,
    durationMs,
    error: error === undefined ? undefined : toErrorMessage(error),
  });

  const readDuration = (step: SaveTelemetryStep): number => {
    const startedAt = stepStartTimes.get(step) ?? createdAt;
    return Math.max(0, Math.round(getNow() - startedAt));
  };

  return {
    markStepStart(step, extra) {
      try {
        stepStartTimes.set(step, getNow());
        safeLog('info', buildPayload(step, 'start', extra));
      } catch {
        // telemetry is best-effort only
      }
    },
    markStepEnd(step, extra) {
      try {
        safeLog('info', buildPayload(step, 'end', extra, readDuration(step)));
      } catch {
        // telemetry is best-effort only
      }
    },
    markFailure(step, error, extra) {
      try {
        safeLog('error', buildPayload(step, 'failure', extra, readDuration(step), error));
      } catch {
        // telemetry is best-effort only
      }
    },
    finish(extra) {
      try {
        safeLog('info', buildPayload('save_finished', 'end', extra, Math.max(0, Math.round(getNow() - createdAt))));
      } catch {
        // telemetry is best-effort only
      }
    },
  };
}

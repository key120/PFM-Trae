import { describe, expect, it, vi, beforeEach } from 'vitest';
import {
  distributeDocumentKeyConcurrently,
  type DistributeKeyFn,
} from './sharedDocumentKeyDistribution';

const mockKey = { type: 'secret', algorithm: { name: 'AES-GCM' } } as unknown as CryptoKey;

function createMockDistributeFn(
  behavior?: (userId: string) => Promise<void> | void,
): DistributeKeyFn {
  return vi.fn(async (_docId, _wrappedKey, userId, _keyVersion) => {
    if (behavior) {
      await behavior(userId);
    }
  });
}

describe('distributeDocumentKeyConcurrently', () => {
  it('所有用户成功时返回 distributed 包含全部 userId，failed 为空', async () => {
    const distributeFn = createMockDistributeFn();
    const result = await distributeDocumentKeyConcurrently(
      {
        documentId: 'doc-1',
        wrappedKey: mockKey,
        targetUserIds: ['user-a', 'user-b', 'user-c'],
        keyVersion: 2,
      },
      distributeFn,
    );

    expect(result.distributed).toEqual(['user-a', 'user-b', 'user-c']);
    expect(result.failed).toHaveLength(0);
    expect(distributeFn).toHaveBeenCalledTimes(3);
    expect(distributeFn).toHaveBeenCalledWith('doc-1', mockKey, 'user-a', 2);
    expect(distributeFn).toHaveBeenCalledWith('doc-1', mockKey, 'user-b', 2);
    expect(distributeFn).toHaveBeenCalledWith('doc-1', mockKey, 'user-c', 2);
  });

  it('部分用户失败时 failed 包含对应的 userId 和 reason', async () => {
    const distributeFn = createMockDistributeFn((userId) => {
      if (userId === 'user-b') {
        throw new Error('无法获取用户公钥');
      }
    });

    const result = await distributeDocumentKeyConcurrently(
      {
        documentId: 'doc-1',
        wrappedKey: mockKey,
        targetUserIds: ['user-a', 'user-b', 'user-c'],
        keyVersion: 3,
      },
      distributeFn,
    );

    expect(result.distributed).toEqual(['user-a', 'user-c']);
    expect(result.failed).toHaveLength(1);
    expect(result.failed[0]).toMatchObject({
      userId: 'user-b',
      reason: '无法获取用户公钥',
    });
  });

  it('非 Error 类型的异常也能正确捕获 reason', async () => {
    const distributeFn = vi.fn(async (_docId, _wrappedKey, userId) => {
      if (userId === 'user-x') {
        throw 'string error'; // eslint-disable-line no-throw-literal
      }
    }) as DistributeKeyFn;

    const result = await distributeDocumentKeyConcurrently(
      {
        documentId: 'doc-1',
        wrappedKey: mockKey,
        targetUserIds: ['user-x'],
        keyVersion: 1,
      },
      distributeFn,
    );

    expect(result.distributed).toHaveLength(0);
    expect(result.failed).toHaveLength(1);
    expect(result.failed[0]).toMatchObject({
      userId: 'user-x',
      reason: 'string error',
    });
  });

  it('所有用户都失败时返回空 distributed 和全部 failed', async () => {
    const distributeFn = createMockDistributeFn(() => {
      throw new Error('网络错误');
    });

    const result = await distributeDocumentKeyConcurrently(
      {
        documentId: 'doc-1',
        wrappedKey: mockKey,
        targetUserIds: ['user-a', 'user-b'],
        keyVersion: 1,
      },
      distributeFn,
    );

    expect(result.distributed).toHaveLength(0);
    expect(result.failed).toHaveLength(2);
    expect(result.failed[0]).toMatchObject({ userId: 'user-a', reason: '网络错误' });
    expect(result.failed[1]).toMatchObject({ userId: 'user-b', reason: '网络错误' });
  });

  it('targetUserIds 为空时立即返回空结果，不调用 distributeFn', async () => {
    const distributeFn = createMockDistributeFn();

    const result = await distributeDocumentKeyConcurrently(
      {
        documentId: 'doc-1',
        wrappedKey: mockKey,
        targetUserIds: [],
        keyVersion: 1,
      },
      distributeFn,
    );

    expect(result.distributed).toHaveLength(0);
    expect(result.failed).toHaveLength(0);
    expect(distributeFn).not.toHaveBeenCalled();
  });

  it('concurrency 参数控制并行度', async () => {
    const callLog: string[] = [];
    const activeCalls = new Map<string, number>();
    let maxConcurrent = 0;

    const distributeFn: DistributeKeyFn = async (_docId, _wrappedKey, userId, _keyVersion) => {
      const active = (activeCalls.get('current') ?? 0) + 1;
      activeCalls.set('current', active);
      if (active > maxConcurrent) maxConcurrent = active;

      callLog.push(`start:${userId}`);
      // Simulate async work
      await new Promise((r) => setTimeout(r, 10));
      callLog.push(`end:${userId}`);

      const afterActive = (activeCalls.get('current') ?? 1) - 1;
      activeCalls.set('current', afterActive);
    };

    const result = await distributeDocumentKeyConcurrently(
      {
        documentId: 'doc-1',
        wrappedKey: mockKey,
        targetUserIds: ['u1', 'u2', 'u3', 'u4', 'u5', 'u6'],
        keyVersion: 1,
        concurrency: 2,
      },
      distributeFn,
    );

    expect(result.distributed).toEqual(['u1', 'u2', 'u3', 'u4', 'u5', 'u6']);
    expect(result.failed).toHaveLength(0);
    expect(maxConcurrent).toBeLessThanOrEqual(2);
    // u1 and u2 should start before u3 ends (chunked execution)
    expect(callLog.indexOf('start:u3')).toBeGreaterThan(callLog.indexOf('start:u1'));
  });

  it('返回结果包含 actualDistributed、concurrencyUsed 和 durationMs 指标', async () => {
    const distributeFn = createMockDistributeFn();

    const result = await distributeDocumentKeyConcurrently(
      {
        documentId: 'doc-1',
        wrappedKey: mockKey,
        targetUserIds: ['user-a', 'user-b', 'user-c'],
        keyVersion: 2,
        concurrency: 2,
      },
      distributeFn,
    );

    expect(result.actualDistributed).toBe(3);
    expect(result.concurrencyUsed).toBe(2);
    expect(typeof result.durationMs).toBe('number');
    expect(result.durationMs).toBeGreaterThanOrEqual(0);
  });

  it('部分失败时 actualDistributed 只计成功的数量', async () => {
    const distributeFn = createMockDistributeFn((userId) => {
      if (userId === 'user-b') {
        throw new Error('网络错误');
      }
    });

    const result = await distributeDocumentKeyConcurrently(
      {
        documentId: 'doc-1',
        wrappedKey: mockKey,
        targetUserIds: ['user-a', 'user-b', 'user-c'],
        keyVersion: 1,
        concurrency: 4,
      },
      distributeFn,
    );

    expect(result.actualDistributed).toBe(2);
    expect(result.concurrencyUsed).toBe(4);
    expect(result.durationMs).toBeGreaterThanOrEqual(0);
  });

  it('targetUserIds 为空时返回零值指标', async () => {
    const distributeFn = createMockDistributeFn();

    const result = await distributeDocumentKeyConcurrently(
      {
        documentId: 'doc-1',
        wrappedKey: mockKey,
        targetUserIds: [],
        keyVersion: 1,
      },
      distributeFn,
    );

    expect(result.actualDistributed).toBe(0);
    expect(result.concurrencyUsed).toBe(4); // default concurrency
    expect(result.durationMs).toBeGreaterThanOrEqual(0);
  });

  it('默认并发度为 4', async () => {
    let maxConcurrent = 0;
    const activeCalls = { current: 0 };

    const distributeFn: DistributeKeyFn = async (_docId, _wrappedKey, userId) => {
      activeCalls.current += 1;
      if (activeCalls.current > maxConcurrent) maxConcurrent = activeCalls.current;
      await new Promise((r) => setTimeout(r, 10));
      activeCalls.current -= 1;
    };

    const result = await distributeDocumentKeyConcurrently(
      {
        documentId: 'doc-1',
        wrappedKey: mockKey,
        targetUserIds: ['u1', 'u2', 'u3', 'u4', 'u5', 'u6', 'u7', 'u8'],
        keyVersion: 1,
      },
      distributeFn,
    );

    expect(result.distributed).toHaveLength(8);
    expect(maxConcurrent).toBeLessThanOrEqual(4);
  });
});

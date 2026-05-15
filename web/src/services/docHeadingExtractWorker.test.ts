import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const convertToHtmlMock = vi.fn();

vi.mock('mammoth', () => ({
  default: {
    convertToHtml: convertToHtmlMock,
  },
}));

const createDocxFile = () =>
  new File(['dummy'], 'sample.docx', {
    type: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
  });


describe('docHeadingExtractWorker', () => {
  let originalWorker: typeof Worker;

  beforeEach(() => {
    vi.resetModules();
    convertToHtmlMock.mockReset();
    originalWorker = globalThis.Worker;
  });

  afterEach(() => {
    globalThis.Worker = originalWorker;
  });

  it('extractHeadingsFromHtml 能提取多级标题并构建树', async () => {
    const docParserModule = await import('../utils/docParser');

    expect(docParserModule.extractHeadingsFromHtml).toBeTypeOf('function');

    const headings = docParserModule.extractHeadingsFromHtml?.(`
      <p class="toc-entry toc-level-1">第1章 项目概述\t1</p>
      <p class="toc-entry toc-level-2">1.1 背景\t2</p>
      <h1><span>项目概述</span></h1>
      <h2><em>1.1 背景</em></h2>
      <h3><strong>目标</strong></h3>
    `);

    expect(headings).toEqual([
      {
        id: 'heading-0',
        key: 'heading-0',
        title: '第1章 项目概述',
        level: 1,
        children: [
          {
            id: 'heading-1',
            key: 'heading-1',
            title: '背景',
            level: 2,
            children: [
              {
                id: 'heading-2',
                key: 'heading-2',
                title: '目标',
                level: 3,
                children: [],
              },
            ],
          },
        ],
      },
    ]);
  });

  it('extractHeadingsFromHtml 会剥离标题中的内嵌 HTML 标签', async () => {
    const docParserModule = await import('../utils/docParser');

    expect(docParserModule.extractHeadingsFromHtml).toBeTypeOf('function');

    const headings = docParserModule.extractHeadingsFromHtml?.(`
      <h2><span>1.2 <em>范围</em><sup>[草案]</sup></span></h2>
    `);

    expect(headings).toEqual([
      {
        id: 'heading-0',
        key: 'heading-0',
        title: '范围[草案]',
        level: 2,
        children: [],
      },
    ]);
  });

  it('extractHeadingsFromHtml 会跳过空标题', async () => {
    const docParserModule = await import('../utils/docParser');

    expect(docParserModule.extractHeadingsFromHtml).toBeTypeOf('function');

    const headings = docParserModule.extractHeadingsFromHtml?.(`
      <h1> </h1>
      <h2><span></span></h2>
      <h3>保留标题</h3>
    `);

    expect(headings).toEqual([
      {
        id: 'heading-2',
        key: 'heading-2',
        title: '保留标题',
        level: 3,
        children: [],
      },
    ]);
  });

  it('Worker 成功消息会包含 title', async () => {
    const postMessageSpy = vi.fn();
    const originalPostMessage = self.postMessage;

    Object.defineProperty(self, 'postMessage', {
      configurable: true,
      value: postMessageSpy,
    });

    convertToHtmlMock.mockResolvedValue({
      value: '<h1>1. 总览</h1><h2><span>1.1 目标</span></h2>',
    });

    await import('../workers/docHeadingExtract.worker');

    await self.onmessage?.(
      new MessageEvent('message', {
        data: { type: 'extract', arrayBuffer: new ArrayBuffer(8) },
      }) as MessageEvent,
    );

    expect(postMessageSpy).toHaveBeenCalledWith({
      type: 'success',
      title: '总览',
      headings: [
        {
          id: 'heading-0',
          key: 'heading-0',
          title: '总览',
          level: 1,
          children: [
            {
              id: 'heading-1',
              key: 'heading-1',
              title: '目标',
              level: 2,
              children: [],
            },
          ],
        },
      ],
    });

    Object.defineProperty(self, 'postMessage', {
      configurable: true,
      value: originalPostMessage,
    });
  });

  it('适配层在 Worker 不可用时会回退到主线程解析并返回 headings 与 title', async () => {
    globalThis.Worker = class {
      constructor() {
        throw new Error('Worker unavailable');
      }
    } as unknown as typeof Worker;

    convertToHtmlMock.mockResolvedValue({
      value: '<h1>1. 总览</h1><h2><span>1.1 目标</span></h2>',
    });

    const workerModule = await import('./docHeadingExtractWorker');

    expect(workerModule.extractHeadingsViaWorker).toBeTypeOf('function');

    const result = await workerModule.extractHeadingsViaWorker(createDocxFile());

    expect(convertToHtmlMock).toHaveBeenCalledTimes(1);
    expect(result).toEqual({
      title: '总览',
      headings: [
        {
          id: 'heading-0',
          key: 'heading-0',
          title: '总览',
          level: 1,
          children: [
            {
              id: 'heading-1',
              key: 'heading-1',
              title: '目标',
              level: 2,
              children: [],
            },
          ],
        },
      ],
    });
  });

  it('适配层在 Worker 运行返回错误时会回退到主线程解析并返回 title', async () => {
    globalThis.Worker = class {
      onmessage: ((event: MessageEvent) => void) | null = null;
      onerror: ((event: ErrorEvent) => void) | null = null;

      constructor(_url: string | URL, _options?: WorkerOptions) {}

      postMessage(_message: unknown) {
        queueMicrotask(() => {
          this.onmessage?.(
            new MessageEvent('message', {
              data: { type: 'error', message: 'worker parse failed' },
            }),
          );
        });
      }

      terminate() {}
    } as unknown as typeof Worker;

    convertToHtmlMock.mockResolvedValue({
      value: '<h1>1. 主线程回退</h1><h2>1.1 成功</h2>',
    });

    const workerModule = await import('./docHeadingExtractWorker');
    const result = await workerModule.extractHeadingsViaWorker(createDocxFile());

    expect(convertToHtmlMock).toHaveBeenCalledTimes(1);
    expect(result).toEqual({
      title: '主线程回退',
      headings: [
        {
          id: 'heading-0',
          key: 'heading-0',
          title: '主线程回退',
          level: 1,
          children: [
            {
              id: 'heading-1',
              key: 'heading-1',
              title: '成功',
              level: 2,
              children: [],
            },
          ],
        },
      ],
    });
  });

  it('适配层会把 ArrayBuffer 发送给 Worker 并返回 title', async () => {
    const postMessageSpy = vi.fn();

    globalThis.Worker = class {
      onmessage: ((event: MessageEvent) => void) | null = null;
      onerror: ((event: ErrorEvent) => void) | null = null;

      constructor(_url: string | URL, _options?: WorkerOptions) {}

      postMessage(message: unknown, transfer?: Transferable[]) {
        postMessageSpy(message, transfer);
        queueMicrotask(() => {
          this.onmessage?.(
            new MessageEvent('message', {
              data: { type: 'success', headings: [], title: '缓存标题' },
            }),
          );
        });
      }

      terminate() {}
    } as unknown as typeof Worker;

    const workerModule = await import('./docHeadingExtractWorker');
    const result = await workerModule.extractHeadingsViaWorker(createDocxFile());

    expect(postMessageSpy).toHaveBeenCalledTimes(1);
    expect(postMessageSpy.mock.calls[0]?.[0]).toMatchObject({
      type: 'extract',
      arrayBuffer: expect.any(ArrayBuffer),
    });
    expect(postMessageSpy.mock.calls[0]?.[1]).toEqual([
      postMessageSpy.mock.calls[0]?.[0].arrayBuffer,
    ]);
    expect(result).toEqual({ headings: [], title: '缓存标题' });
  });

  it('parseDocumentHeadings 入口在 Worker 可用时优先使用 Worker 结果', async () => {
    const workerHeadings = [
      {
        id: 'heading-0',
        key: 'heading-0',
        title: 'Worker 标题',
        level: 1,
        children: [],
      },
    ];

    globalThis.Worker = class {
      onmessage: ((event: MessageEvent) => void) | null = null;
      onerror: ((event: ErrorEvent) => void) | null = null;

      constructor(_url: string | URL, _options?: WorkerOptions) {}

      postMessage(_message: unknown) {
        queueMicrotask(() => {
          this.onmessage?.(
            new MessageEvent('message', {
              data: { type: 'success', headings: workerHeadings, title: 'Worker 标题' },
            }),
          );
        });
      }

      terminate() {}
    } as unknown as typeof Worker;

    convertToHtmlMock.mockRejectedValue(new Error('main-thread parser should not run'));

    const { parseDocumentHeadings } = await import('../utils/docParser');
    const headings = await parseDocumentHeadings(createDocxFile());

    expect(headings).toEqual(workerHeadings);
    expect(convertToHtmlMock).not.toHaveBeenCalled();
  });
});

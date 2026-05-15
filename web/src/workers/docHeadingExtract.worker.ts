import mammoth from 'mammoth';
import {
  DOC_HEADING_MAMMOTH_OPTIONS,
  extractHeadingsAndTitleFromHtml,
  type HeadingNode,
} from '../utils/docHeadingExtraction';

interface ExtractMessage {
  type: 'extract';
  arrayBuffer: ArrayBuffer;
}

type WorkerOutput =
  | { type: 'success'; headings: HeadingNode[]; title: string }
  | { type: 'error'; message: string };

const post = (message: WorkerOutput) => {
  (self as unknown as Worker).postMessage(message);
};

const extractDocumentHeadings = async (
  arrayBuffer: ArrayBuffer,
): Promise<{ headings: HeadingNode[]; title: string }> => {
  const result = await mammoth.convertToHtml({ arrayBuffer }, DOC_HEADING_MAMMOTH_OPTIONS);
  return extractHeadingsAndTitleFromHtml(result.value);
};

self.onmessage = async (event: MessageEvent<ExtractMessage>) => {
  try {
    const message = event.data;
    if (message.type !== 'extract') {
      post({ type: 'error', message: `Unknown message type: ${(message as { type: string }).type}` });
      return;
    }

    const { headings, title } = await extractDocumentHeadings(message.arrayBuffer);
    post({ type: 'success', headings, title });
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    post({ type: 'error', message });
  }
};

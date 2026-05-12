import { supabase } from '../lib/supabase';
import { decryptDocumentChunked } from './encryptionService';
import { encryptDocumentChunkedViaWorker } from './documentEncryptionWorker';
import {
  generateDocumentKey,
  wrapDocumentKey,
  unwrapDocumentKey,
  getUserKeyPair,
  ensureUserKeyPair,
  isWebCryptoAvailable,
  distributeDocumentKey,
  revokeDocumentKeyAccess,
  backupUserPrivateKey,
  restoreUserPrivateKey,
} from './cryptoKeyService';
import { generateDocumentId, generateVersionId } from '../utils/idGenerator';
import { distributeDocumentKeyConcurrently } from './sharedDocumentKeyDistribution';
import { createSaveTelemetry, type SaveTelemetryStep } from './documentSaveTelemetry';
import {
  type SaveProgressCallback,
  computeSaveProgress,
} from './documentSaveProgress';

export interface PersonalDocument {
  id: string;
  name: string;
  size: number | null;
  createdAt: string;
  updatedAt: string;
  version?: string | null;
  remark?: string | null;
  versions?: VersionInfo[];
}

export interface VersionInfo {
  version: string;
  remark: string;
  author: string | null;
  createdAt: string;
  sizeBytes?: number | null;
}

interface DocumentMetadata {
  latestVersion?: string | null;
  latestRemark?: string | null;
  versions?: VersionInfo[];
  selectedKeys?: string[];
  encryption?: {
    enabled: boolean;
    version: number;
  };
  originalFileName?: string;
  mimeType?: string;
}

export interface DocumentVersionRow {
  id: string;
  document_id: string;
  version_label: string;        // 版本号，如 V1.0.0
  note: string | null;          // 备注
  author_id: string | null;     // 作者 user_id
  r2_key: string;
  content_hash: string;
  encrypted_meta: Record<string, unknown> | null;
  key_version: number;
  size_bytes: number;
  created_at: string;
}

export interface DocumentKeyRow {
  document_id: string;
  user_id: string;
  wrapped_document_key: string;  // 线上实际字段名
  key_version: number;
  created_at: string;
  updated_at: string;
}

interface DocumentsRow {
  id: string;
  encrypted_title: string | null;
  size: number | string | null;
  path: string | null;
  created_at: string;
  updated_at: string;
  metadata?: DocumentMetadata | null;
}

interface SavePersonalDocumentInput {
  userId: string;
  authorEmail: string | null;
  blob: Blob;
  fileName: string;
  documentId?: string | null;
  version: string;
  remark: string;
  selectedKeys: string[];
  onProgress?: SaveProgressCallback;
}

interface SavePersonalDocumentResult {
  documentId: string;
}

interface LoadedPersonalDocument {
  file: File;
  version: string | null;
  remark: string | null;
  selectedKeys?: string[];
}

interface KeyNotReadyError extends Error {
  code: 'KEY_NOT_READY';
}

function createKeyNotReadyError(message: string): KeyNotReadyError {
  return Object.assign(new Error(message), { code: 'KEY_NOT_READY' as const });
}

async function runSaveStep<T>(
  telemetry: ReturnType<typeof createSaveTelemetry>,
  step: SaveTelemetryStep,
  operation: () => Promise<T>,
  extra?: { memberCount?: number; actualDistributed?: number; concurrency?: number },
): Promise<T> {
  telemetry.markStepStart(step, extra);
  try {
    const result = await operation();
    telemetry.markStepEnd(step, extra);
    return result;
  } catch (error) {
    telemetry.markFailure(step, error, extra);
    throw error;
  }
}

function createSafeEmitter(onProgress?: SaveProgressCallback) {
  return (info: ReturnType<typeof computeSaveProgress>) => {
    try {
      onProgress?.(info);
    } catch {
      // swallow callback errors — never break the save pipeline
    }
  };
}

export async function fetchPersonalDocuments(userId: string): Promise<PersonalDocument[]> {
  const { data, error } = await supabase
    .from('documents')
    .select('id, encrypted_title, size, path, created_at, updated_at, metadata')
    .eq('owner_id', userId)
    .order('updated_at', { ascending: false });

  if (error) {
    throw error;
  }

  if (!data) {
    return [];
  }

  const rows = (data as DocumentsRow[]).filter((row) => {
    if (row.path && row.path.startsWith('r2://dummy')) {
      return false;
    }
    const meta = (row.metadata as DocumentMetadata | null) ?? null;
    const encryption = meta?.encryption;
    return !!encryption?.enabled;
  });

  if (rows.length === 0) {
    return [];
  }

  return rows.map((row) => {
    const meta = row.metadata ?? null;
    const latestVersion =
      meta && typeof meta.latestVersion === 'string' ? meta.latestVersion : null;
    const latestRemark =
      meta && typeof meta.latestRemark === 'string' ? meta.latestRemark : null;
    const versions =
      meta && Array.isArray(meta.versions) ? (meta.versions as VersionInfo[]) : [];

    return {
      id: row.id,
      name: row.encrypted_title || (row.path ? row.path.split('/').pop() || '未命名文档' : '未命名文档'),
      size:
        typeof row.size === 'number'
          ? row.size
          : row.size === null
          ? null
          : Number(row.size) || null,
      createdAt: row.created_at,
      updatedAt: row.updated_at,
      version: latestVersion,
      remark: latestRemark,
      versions,
    };
  });
}

export async function savePersonalDocument(
  input: SavePersonalDocumentInput,
): Promise<SavePersonalDocumentResult> {
  if (!isWebCryptoAvailable()) {
    throw new Error('当前浏览器不支持 Web Crypto API，无法加密保存文档');
  }

  // Step 1：生成 documentId（新建）或沿用已有 ID
  const documentId = input.documentId || generateDocumentId();
  const versionId = generateVersionId();
  const telemetry = createSaveTelemetry({
    documentId,
    versionId,
    mode: 'personal',
    fileSize: input.blob.size,
  });
  telemetry.markStepStart('save_started');
  telemetry.markStepEnd('save_started');

  const emit = createSafeEmitter(input.onProgress);
  emit(computeSaveProgress('preparing'));

  try {
    // Step 2：获取当前用户的 RSA 公钥（用于封装文档密钥）
    const keyPair = await getUserKeyPair(input.userId);
    if (!keyPair) {
      throw new Error('未找到用户密钥，请重新登录后重试');
    }

    // 提前计算本次 key_version：供 document_keys 写入与私钥备份版本保持一致。
    const { data: existingKeyData } = await supabase
      .from('document_keys')
      .select('key_version')
      .eq('document_id', documentId)
      .eq('user_id', input.userId)
      .order('key_version', { ascending: false })
      .limit(1)
      .maybeSingle();

    const nextKeyVersion = existingKeyData ? (existingKeyData.key_version as number) + 1 : 1;

    // 每次保存时尝试备份私钥，保证跨浏览器可恢复。
    await backupUserPrivateKey(keyPair.privateKey, nextKeyVersion);

    // Step 3：生成本次版本的 DocumentKey（AES-GCM-256）
    const documentKey = await generateDocumentKey();

    // Step 4：用公钥封装 DocumentKey → wrappedKey（用于写入 document_keys）
    const wrappedKey = await wrapDocumentKey(documentKey, keyPair.publicKey);

    // Step 5：加密原始 DOCX Blob（分块加密，携带 title/remark/selectedKeys 等元数据）
    // 优先尝试 Worker 加密，Worker 不可用或失败时回退到主线程加密
    const encryptInput = {
      file: input.blob,
      key: documentKey,
      meta: {
        title: input.fileName,
        remark: input.remark,
        selectedKeys: input.selectedKeys,
        originalFileName: input.fileName,
        mimeType: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
      },
    };
    const { blob: encryptedBlob, contentHash } = await runSaveStep(
      telemetry,
      'encryption',
      () => encryptDocumentChunkedViaWorker(encryptInput, {
        onProgress: (chunkIndex, totalChunks) => {
          emit(computeSaveProgress('encrypting', { chunkIndex, totalChunks }));
        },
      }),
    );

    // Step 6：获取预签名 PUT URL 并上传到 R2
    emit(computeSaveProgress('uploading'));
    const r2Key = await runSaveStep(
      telemetry,
      'upload',
      () => uploadToR2(documentId, versionId, contentHash, encryptedBlob),
    );

    const size = encryptedBlob.size;
    const now = new Date().toISOString();
    const versionEntry: VersionInfo = {
      version: input.version,
      remark: input.remark,
      author: input.authorEmail,
      createdAt: now,
      sizeBytes: size,
    };

    // Step 7：写入或更新 documents 表（元数据摘要）
    emit(computeSaveProgress('persisting'));
    await runSaveStep(telemetry, 'documents_write', async () => {
      if (!input.documentId) {
        const metadata: DocumentMetadata = {
          latestVersion: input.version,
          latestRemark: input.remark,
          versions: [versionEntry],
          selectedKeys: input.selectedKeys,
          encryption: { enabled: true, version: 2 },
        };
        const { error } = await supabase
          .from('documents')
          .insert({
            id: documentId,
            owner_id: input.userId,
            encrypted_title: input.fileName,
            size,
            type: 'docx',
            path: r2Key,
            metadata,
            updated_at: now,
          });

        if (error) {
          throw error;
        }
        return;
      }

      const { data: existing, error: loadError } = await supabase
        .from('documents')
        .select('metadata')
        .eq('id', documentId)
        .eq('owner_id', input.userId)
        .single();

      if (loadError || !existing) {
        throw loadError || new Error('Failed to load existing document metadata');
      }

      const existingMeta = (existing.metadata as DocumentMetadata | null) ?? null;
      const existingVersions =
        existingMeta && Array.isArray(existingMeta.versions)
          ? (existingMeta.versions as VersionInfo[])
          : [];

      const metadata: DocumentMetadata = {
        latestVersion: input.version,
        latestRemark: input.remark,
        versions: [versionEntry, ...existingVersions],
        selectedKeys: input.selectedKeys,
        encryption: { enabled: true, version: 2 },
      };

      const { error } = await supabase
        .from('documents')
        .update({
          encrypted_title: input.fileName,
          size,
          type: 'docx',
          path: r2Key,
          metadata,
          updated_at: now,
        })
        .eq('id', documentId)
        .eq('owner_id', input.userId);

      if (error) {
        throw error;
      }
    });

    // Step 8：写入 document_versions 表（真实版本下载源）
    await runSaveStep(telemetry, 'document_versions_write', async () => {
      const { error: versionError } = await supabase.from('document_versions').insert({
        id: versionId,
        document_id: documentId,
        version_label: input.version,
        note: input.remark || null,
        author_id: input.userId,
        r2_key: r2Key,
        content_hash: contentHash,
        encrypted_meta: {
          title: input.fileName,
          selectedKeys: input.selectedKeys,
          keyVersion: nextKeyVersion,
        },
        key_version: nextKeyVersion,
        size_bytes: size,
      });

      if (versionError) {
        throw versionError;
      }
    });

    // Step 9：写入 document_keys 表（owner 的 wrapped key，确保自己也能解密）
    await runSaveStep(telemetry, 'document_keys_write', async () => {
      const { error: keyError } = await supabase.from('document_keys').insert({
        document_id: documentId,
        user_id: input.userId,
        wrapped_document_key: wrappedKey,
        key_version: nextKeyVersion,
      });

      if (keyError) {
        // 23505 = unique_violation，并发双击场景下同 key_version 已存在，可安全忽略
        if ((keyError as { code?: string }).code !== '23505') {
          throw new Error(`document_keys 写入失败：${keyError.message}`);
        }
      }
    });

    telemetry.finish();
    emit(computeSaveProgress('done'));
    return { documentId };
  } catch (error) {
    emit(computeSaveProgress('failed'));
    telemetry.markFailure('save_finished', error);
    throw error;
  }
}

// ─── R2 上传/下载辅助函数 ─────────────────────────────────────────────────────
// 这两个函数封装了调用 Edge Function 获取预签名 URL 并直接与 R2 交互的逻辑。
// 子任务 3（savePersonalDocument 加密上传）和子任务 4（loadPersonalDocument 解密下载）
// 将调用这两个函数替换当前的 Supabase Storage 链路。

export interface R2UploadSignature {
  url: string;
  method: 'PUT';
  headers: Record<string, string>;
  expiresAt: string;
  r2Key: string;
}

export interface R2DownloadSignature {
  url: string;
  method: 'GET';
  headers: Record<string, string>;
  expiresAt: string;
  r2Key: string;
}

/**
 * 向 Edge Function 请求 R2 预签名上传 URL，然后直接 PUT 上传 blob。
 * 返回最终写入 R2 的对象键（r2Key）。
 */
export async function uploadToR2(
  documentId: string,
  versionId: string,
  contentHash: string,
  blob: Blob,
): Promise<string> {
  const { data: signData, error: signError } = await supabase.functions.invoke('r2-sign-upload', {
    body: {
      documentId,
      versionId,
      operation: 'upload',
      contentHash,
      sizeBytes: blob.size,
    },
  });

  if (signError || !signData?.url) {
    throw signError || new Error('Failed to get R2 upload signature');
  }

  const sig = signData as R2UploadSignature;

  const uploadResp = await fetch(sig.url, {
    method: 'PUT',
    headers: sig.headers,
    body: blob,
  });

  if (!uploadResp.ok) {
    throw new Error(`R2 upload failed: ${uploadResp.status} ${uploadResp.statusText}`);
  }

  return sig.r2Key;
}

/**
 * 向 Edge Function 请求 R2 预签名下载 URL，然后直接 GET 拉取密文 Blob。
 * 对网络层瞬态错误（如 ERR_CONTENT_LENGTH_MISMATCH）自动重试。
 */
export async function downloadFromR2(
  documentId: string,
  versionId: string,
): Promise<Blob> {
  const { data: signData, error: signError } = await supabase.functions.invoke('r2-sign-download', {
    body: { documentId, versionId },
  });

  if (signError || !signData?.url) {
    throw signError || new Error('Failed to get R2 download signature');
  }

  const sig = signData as R2DownloadSignature;

  const maxAttempts = 3;
  let lastError: unknown;

  for (let attempt = 1; attempt <= maxAttempts; attempt++) {
    try {
      const downloadResp = await fetch(sig.url, { method: 'GET' });

      if (!downloadResp.ok) {
        throw new Error(`R2 download failed: ${downloadResp.status} ${downloadResp.statusText}`);
      }

      return downloadResp.blob();
    } catch (err) {
      lastError = err;
      // 仅对网络层瞬态错误重试，HTTP 错误（如 403/404）不重试
      const isTransient = err instanceof TypeError
        || (err instanceof Error && /content.length.mismatch|failed to fetch|network/i.test(err.message));
      if (!isTransient || attempt === maxAttempts) {
        throw err;
      }
      // 指数退避：1s, 2s
      await new Promise((r) => setTimeout(r, 1000 * attempt));
    }
  }

  throw lastError;
}

// ─────────────────────────────────────────────────────────────────────────────

export async function loadPersonalDocument(
  userId: string,
  documentId: string,
): Promise<LoadedPersonalDocument> {
  // Step 1：读取文档元数据
  const { data, error } = await supabase
    .from('documents')
    .select('path, metadata')
    .eq('id', documentId)
    .eq('owner_id', userId)
    .single();

  if (error || !data) {
    throw error || new Error('Failed to load document metadata');
  }

  const metadata = (data.metadata as DocumentMetadata | null) ?? null;
  const isEncrypted = metadata?.encryption?.enabled === true && metadata?.encryption?.version === 2;

  // Step 2a：加密文档 → R2 下载 + 解密链路
  if (isEncrypted) {
    if (!isWebCryptoAvailable()) {
      throw new Error('当前浏览器不支持 Web Crypto API，无法解密文档');
    }

    // 获取最新版本记录（取 created_at 最新的一条）
    const { data: versionData, error: versionError } = await supabase
      .from('document_versions')
      .select('id, r2_key, content_hash, encrypted_meta, version_label, note, key_version')
      .eq('document_id', documentId)
      .order('created_at', { ascending: false })
      .limit(1)
      .single();

    if (versionError || !versionData) {
      throw versionError || new Error('Failed to load document version');
    }

    // 先按当前版本的 key_version 精确获取 wrapped key，确保版本与密钥一一对应
    const versionKeyVersion =
      typeof (versionData as { key_version?: unknown }).key_version === 'number'
        ? ((versionData as { key_version: number }).key_version)
        : null;

    let keyRows: Array<{ wrapped_document_key: string; key_version: number }> = [];

    if (versionKeyVersion !== null) {
      try {
        const { data: exactKeyData, error: exactKeyError } = await supabase
          .from('document_keys')
          .select('wrapped_document_key, key_version')
          .eq('document_id', documentId)
          .eq('user_id', userId)
          .eq('key_version', versionKeyVersion)
          .limit(1);

        if (exactKeyError) {
          throw createKeyNotReadyError('无法找到版本对应的解密密钥，请确认您有权限访问此文档');
        }

        if (exactKeyData && exactKeyData.length > 0) {
          keyRows = exactKeyData as Array<{ wrapped_document_key: string; key_version: number }>;
        }
      } catch {
        // 测试桩或异常链路下回退到通用 key 回退查询
      }
    }

    // 若版本精确匹配为空，再回退按 key_version 倒序取最近几条（容错兜底）
    if (keyRows.length === 0) {
      const { data: fallbackKeyRows, error: fallbackKeyError } = await supabase
        .from('document_keys')
        .select('wrapped_document_key, key_version')
        .eq('document_id', documentId)
        .eq('user_id', userId)
        .order('key_version', { ascending: false })
        .limit(5);

      if (fallbackKeyError || !fallbackKeyRows || fallbackKeyRows.length === 0) {
        throw createKeyNotReadyError('无法找到解密密钥，请确认您有权限访问此文档');
      }

      keyRows = fallbackKeyRows as Array<{ wrapped_document_key: string; key_version: number }>;
    }

    // 获取用户私钥并解封 DocumentKey（若本地缺失则尝试先恢复）
    let keyPair = await getUserKeyPair(userId);
    if (!keyPair) {
      await restoreUserPrivateKey();
      keyPair = await getUserKeyPair(userId);
    }
    if (!keyPair) {
      throw createKeyNotReadyError('未找到用户密钥，请重新登录后重试');
    }

    let documentKey: CryptoKey | null = null;
    for (const row of keyRows as Array<{ wrapped_document_key: string; key_version: number }>) {
      try {
        documentKey = await unwrapDocumentKey(row.wrapped_document_key, keyPair.privateKey);
        break;
      } catch {
        // 本地私钥可能已过期，仅尝试恢复最新私钥后继续回退 key
        const restoredLatest = await restoreUserPrivateKey();
        if (!restoredLatest) {
          continue;
        }

        keyPair = {
          ...keyPair,
          privateKey: restoredLatest,
        };

        try {
          documentKey = await unwrapDocumentKey(row.wrapped_document_key, restoredLatest);
          break;
        } catch {
          // 继续尝试回退 key
        }
      }
    }

    if (!documentKey) {
      throw createKeyNotReadyError('解密密钥不可用，请重新初始化密钥后重试');
    }

    // 从 R2 下载密文 Blob
    const encryptedBlob = await downloadFromR2(documentId, versionData.id as string);

    // 解密
    const encMeta = (versionData.encrypted_meta as { title?: string; selectedKeys?: string[] } | null) ?? null;
    const fileName = encMeta?.title || '未命名文档';

    const { file, meta } = await decryptDocumentChunked(
      encryptedBlob,
      documentKey,
      fileName,
      'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
    );

    // 元数据优先从加密内容中的 meta 恢复，其次 encrypted_meta，最后 documents.metadata
    const selectedKeys =
      Array.isArray(meta?.selectedKeys)
        ? (meta.selectedKeys as string[])
        : Array.isArray(encMeta?.selectedKeys)
          ? encMeta.selectedKeys
          : Array.isArray(metadata?.selectedKeys)
            ? (metadata.selectedKeys as string[])
            : undefined;

    const version =
      (versionData.version_label as string | null) ??
      (metadata?.latestVersion ?? null);

    const remark =
      (versionData.note as string | null) ??
      (metadata?.latestRemark ?? null);

    return { file, version, remark, selectedKeys };
  }

  // Step 2b：旧版未加密文档 → Supabase Storage 兼容链路
  const path = (data as DocumentsRow).path;

  if (!path) {
    throw new Error('Document path is missing');
  }

  const { data: fileData, error: downloadError } = await supabase.storage
    .from('documents')
    .download(path);

  if (downloadError || !fileData) {
    throw downloadError || new Error('Failed to download document');
  }

  const blob = fileData as Blob;
  const legacyFileName = path.split('/').pop() || '未命名文档';
  const file = new File([blob], legacyFileName, {
    type: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
  });

  const latestVersion =
    metadata && typeof metadata.latestVersion === 'string' ? metadata.latestVersion : null;
  const latestRemark =
    metadata && typeof metadata.latestRemark === 'string' ? metadata.latestRemark : null;
  const selectedKeys =
    metadata && Array.isArray(metadata.selectedKeys)
      ? (metadata.selectedKeys as string[])
      : undefined;

  return { file, version: latestVersion, remark: latestRemark, selectedKeys };
}

// ─── 文档共享 ──────────────────────────────────────────────────────────────────

export interface ShareDocumentInput {
  documentId: string;
  ownerUserId: string;
  targetUserIds: string[];  // 要共享给的用户 ID 列表（按用户粒度）
  teamId?: string;          // 可选：关联的团队（写入 document_shares 时使用）
}

export interface ShareDocumentResult {
  distributed: string[];  // 成功分发密钥的用户 ID
  failed: Array<{ userId: string; reason: string }>;  // 分发失败的用户
}

/**
 * 共享文档：
 * 1. owner 自己先解封 DocumentKey（需要自己的 wrapped_document_key）
 * 2. 为每个目标用户分发 wrapped_document_key（用对方公钥加密）
 * 3. 写入 document_shares 表（授权关系）
 */
export async function shareDocument(input: ShareDocumentInput): Promise<ShareDocumentResult> {
  if (!isWebCryptoAvailable()) {
    throw new Error('当前浏览器不支持 Web Crypto API，无法共享文档');
  }

  // 诊断：检查当前 auth session 状态
  const { data: { session: currentSession } } = await supabase.auth.getSession();
  console.log('[shareDocument] auth uid:', currentSession?.user?.id, 'input ownerUserId:', input.ownerUserId, 'token expires:', currentSession?.expires_at);

  // Step 1：获取最新版本的 key_version，找到 owner 的 wrapped_document_key
  const { data: keyData, error: keyError } = await supabase
    .from('document_keys')
    .select('wrapped_document_key, key_version')
    .eq('document_id', input.documentId)
    .eq('user_id', input.ownerUserId)
    .order('key_version', { ascending: false })
    .limit(1)
    .single();

  if (keyError) {
    console.error('[shareDocument] 查询 document_keys 失败:', keyError);
    throw new Error(`无法获取文档密钥: ${keyError.message}`);
  }
  if (!keyData) {
    console.error('[shareDocument] 未找到 document_keys 记录, documentId:', input.documentId, 'ownerUserId:', input.ownerUserId);
    throw new Error('无法获取文档密钥，请确认您是文档所有者');
  }

  // Step 2：owner 解封自己的 DocumentKey
  let ownerKeyPair = await getUserKeyPair(input.ownerUserId);
  if (!ownerKeyPair) {
    // 密钥对可能未初始化（登录时 ensureUserKeyPair 异步失败），尝试重新初始化
    console.warn('[shareDocument] 密钥对不存在，尝试重新初始化...');
    const { data: { user: currentUser } } = await supabase.auth.getUser();
    if (currentUser) {
      await ensureUserKeyPair(currentUser);
      ownerKeyPair = await getUserKeyPair(input.ownerUserId);
    }
  }
  if (!ownerKeyPair) {
    throw new Error('未找到用户密钥，请重新登录后重试');
  }

  const documentKey = await unwrapDocumentKey(
    (keyData as { wrapped_document_key: string; key_version: number }).wrapped_document_key,
    ownerKeyPair.privateKey,
  );

  const keyVersion = (keyData as { key_version: number }).key_version;

  // Step 3：为每个目标用户分发 DocumentKey（逐个处理，失败不中断整体）
  const distributed: string[] = [];
  const failed: Array<{ userId: string; reason: string }> = [];

  for (const targetUserId of input.targetUserIds) {
    try {
      await distributeDocumentKey(input.documentId, documentKey, targetUserId, keyVersion);
      distributed.push(targetUserId);
    } catch (e) {
      const reason = e instanceof Error ? e.message : '未知错误';
      failed.push({ userId: targetUserId, reason });
    }
  }

  // Step 4：写入 document_shares 授权关系（仅在至少有一个用户分发成功时写入）
  if (distributed.length > 0 && input.teamId) {
    await supabase.from('document_shares').upsert(
      {
        document_id: input.documentId,
        team_id: input.teamId,
        shared_by: input.ownerUserId,
      },
      { onConflict: 'document_id,team_id' },
    );
    // document_shares 写入失败不影响密钥分发结果，忽略错误
  }

  return { distributed, failed };
}

/**
 * 取消共享：
 * 1. 撤销目标用户的 document_keys 记录（无法再解密）
 * 2. 若 teamId 传入，同时删除 document_shares 记录
 */

export async function isDocumentSharedInTeam(
  documentId: string,
  teamId: string,
): Promise<boolean> {
  const { data, error } = await supabase
    .from('document_shares')
    .select('id')
    .eq('document_id', documentId)
    .eq('team_id', teamId)
    .limit(1)
    .maybeSingle();

  if (error) {
    throw error;
  }

  return Boolean(data?.id);
}

export async function unshareDocument(
  documentId: string,
  targetUserIds: string[],
  teamId?: string,
): Promise<void> {
  // 逐个撤销密钥访问权
  for (const targetUserId of targetUserIds) {
    await revokeDocumentKeyAccess(documentId, targetUserId);
  }

  // 若有 teamId，同时删除 document_shares 授权记录
  if (teamId) {
    await supabase
      .from('document_shares')
      .delete()
      .eq('document_id', documentId)
      .eq('team_id', teamId);
  }
}

// ─── 共享文档列表（被共享方视角） ─────────────────────────────────────────────────

export interface SharedDocumentVersionSummary {
  version: string;
  remark: string;
  author: string | null;
  createdAt: string;
  sizeBytes?: number | null;
}

export interface SharedDocumentCard {
  id: string;
  name: string;
  size: number | null;
  sharedAt: string;
  sharedBy: string | null;
  version: string | null;
  remark?: string | null;
  versions: SharedDocumentVersionSummary[];
  isOwner: boolean;
}

function readVersionSummaries(metadata: DocumentMetadata | null | undefined): VersionInfo[] {
  if (!metadata || !Array.isArray(metadata.versions)) {
    return [];
  }
  return metadata.versions as VersionInfo[];
}

export async function fetchDocumentVersionLabels(documentId: string): Promise<string[]> {
  const { data, error } = await supabase
    .from('document_versions')
    .select('version_label')
    .eq('document_id', documentId)
    .order('created_at', { ascending: false });

  if (error) {
    throw error;
  }

  return (data ?? [])
    .map((row) => row.version_label as string | null)
    .filter((value): value is string => Boolean(value));
}

export async function assertSharedVersionLabelAvailable(
  documentId: string,
  nextVersion: string,
): Promise<void> {
  const labels = await fetchDocumentVersionLabels(documentId);
  if (labels.includes(nextVersion)) {
    throw new Error('版本号已存在，请输入新的版本号');
  }
}

export async function fetchPersonalDocumentsForCurrentTeam(
  userId: string,
  teamId: string | null,
): Promise<PersonalDocument[]> {
  const docs = await fetchPersonalDocuments(userId);
  if (!teamId || docs.length === 0) {
    return docs;
  }

  const { data: shares, error } = await supabase
    .from('document_shares')
    .select('document_id')
    .eq('team_id', teamId)
    .in('document_id', docs.map((doc) => doc.id));

  if (error) {
    throw error;
  }

  const sharedIds = new Set((shares ?? []).map((row) => row.document_id as string));
  return docs.filter((doc) => !sharedIds.has(doc.id));
}

export async function fetchSharedDocumentsForCurrentTeam(
  userId: string,
  teamId: string,
): Promise<SharedDocumentCard[]> {
  const { data: shares, error: sharesError } = await supabase
    .from('document_shares')
    .select('document_id, shared_by, created_at')
    .eq('team_id', teamId);

  if (sharesError) {
    throw sharesError;
  }

  if (!shares || shares.length === 0) {
    return [];
  }

  const docIds = Array.from(new Set(shares.map((share) => share.document_id as string)));
  const { data: docs, error: docsError } = await supabase
    .from('documents')
    .select('id, owner_id, encrypted_title, size, metadata')
    .in('id', docIds);

  if (docsError) {
    throw docsError;
  }

  const shareByDocId = new Map(shares.map((share) => [share.document_id as string, share]));
  const accessibleDocIds = new Set<string>();

  for (const doc of docs ?? []) {
    const ownerId = doc.owner_id as string | null;
    if (ownerId === userId) {
      accessibleDocIds.add(doc.id as string);
      continue;
    }

    const { data: keyRows, error: keyError } = await supabase
      .from('document_keys')
      .select('document_id')
      .eq('document_id', doc.id)
      .eq('user_id', userId)
      .limit(1);

    if (keyError) {
      throw keyError;
    }

    if (keyRows && keyRows.length > 0) {
      accessibleDocIds.add(doc.id as string);
    }
  }

  const ownerIds = Array.from(new Set(
    (shares ?? [])
      .map((share) => share.shared_by as string | null)
      .filter((value): value is string => Boolean(value)),
  ));

  const { data: profiles } = ownerIds.length
    ? await supabase.from('profiles').select('id, email').in('id', ownerIds)
    : { data: [] };

  const emailMap = new Map((profiles ?? []).map((row) => [row.id as string, row.email as string]));

  return (docs ?? [])
    .filter((doc) => accessibleDocIds.has(doc.id as string))
    .map((doc) => {
      const metadata = (doc.metadata as DocumentMetadata | null) ?? null;
      const versions = readVersionSummaries(metadata);
      const share = shareByDocId.get(doc.id as string);
      const sharedById = share?.shared_by as string | null;

      return {
        id: doc.id as string,
        name: (doc.encrypted_title as string) || '未命名文档',
        size: typeof doc.size === 'number' ? doc.size : doc.size === null ? null : Number(doc.size) || null,
        sharedAt: (share?.created_at as string) || '',
        sharedBy: sharedById ? emailMap.get(sharedById) || sharedById : null,
        version: metadata?.latestVersion ?? null,
        remark: metadata?.latestRemark ?? null,
        versions,
        isOwner: (doc.owner_id as string | null) === userId,
      };
    })
    .sort((a, b) => new Date(b.sharedAt).getTime() - new Date(a.sharedAt).getTime());
}

export type SharedDocument = SharedDocumentCard;
export const fetchSharedDocuments = fetchSharedDocumentsForCurrentTeam;

interface SaveSharedDocumentVersionInput {
  documentId: string;
  editorUserId: string;
  editorEmail: string | null;
  teamId: string;
  blob: Blob;
  fileName: string;
  version: string;
  remark: string;
  selectedKeys: string[];
  onProgress?: SaveProgressCallback;
}

interface SaveSharedDocumentVersionResult {
  documentId: string;
}

export async function saveSharedDocumentVersion(
  input: SaveSharedDocumentVersionInput,
): Promise<SaveSharedDocumentVersionResult> {
  if (!isWebCryptoAvailable()) {
    throw new Error('当前浏览器不支持 Web Crypto API，无法保存共享文档');
  }

  const versionId = generateVersionId();
  const telemetry = createSaveTelemetry({
    documentId: input.documentId,
    versionId,
    mode: 'shared',
    fileSize: input.blob.size,
  });
  telemetry.markStepStart('save_started');
  telemetry.markStepEnd('save_started');

  const emit = createSafeEmitter(input.onProgress);
  emit(computeSaveProgress('preparing'));

  try {
    await assertSharedVersionLabelAvailable(input.documentId, input.version);

    const { data: documentRow, error: documentError } = await supabase
      .from('documents')
      .select('id, owner_id, encrypted_title, metadata')
      .eq('id', input.documentId)
      .single();

    if (documentError || !documentRow) {
      throw documentError || new Error('共享文档不存在');
    }

    const { data: shareRows, error: shareError } = await supabase
      .from('document_shares')
      .select('document_id')
      .eq('document_id', input.documentId)
      .eq('team_id', input.teamId)
      .limit(1);

    if (shareError || !shareRows || shareRows.length === 0) {
      throw new Error('共享权限已失效，请重新载入后重试');
    }

    const { data: currentKeyRows, error: keyError } = await supabase
      .from('document_keys')
      .select('wrapped_document_key, key_version')
      .eq('document_id', input.documentId)
      .eq('user_id', input.editorUserId)
      .order('key_version', { ascending: false })
      .limit(1);

    if (keyError || !currentKeyRows || currentKeyRows.length === 0) {
      throw new Error('共享权限已失效，请重新载入后重试');
    }

    let editorKeyPair = await getUserKeyPair(input.editorUserId);
    if (!editorKeyPair) {
      await restoreUserPrivateKey();
      editorKeyPair = await getUserKeyPair(input.editorUserId);
    }
    if (!editorKeyPair) {
      throw new Error('未找到用户密钥，请重新登录后重试');
    }

    const currentRow = currentKeyRows[0] as { wrapped_document_key: string; key_version: number };
    const nextKeyVersion = currentRow.key_version + 1;

    await backupUserPrivateKey(editorKeyPair.privateKey, nextKeyVersion);

    const nextDocumentKey = await generateDocumentKey();
    const editorWrappedKey = await wrapDocumentKey(nextDocumentKey, editorKeyPair.publicKey);
    const sharedEncryptInput = {
      file: input.blob,
      key: nextDocumentKey,
      meta: {
        title: input.fileName,
        remark: input.remark,
        selectedKeys: input.selectedKeys,
        originalFileName: input.fileName,
        mimeType: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
      },
    };
    const { blob: encryptedBlob, contentHash } = await runSaveStep(
      telemetry,
      'encryption',
      () => encryptDocumentChunkedViaWorker(sharedEncryptInput, {
        onProgress: (chunkIndex, totalChunks) => {
          emit(computeSaveProgress('encrypting', { chunkIndex, totalChunks }));
        },
      }),
    );

    emit(computeSaveProgress('uploading'));
    const r2Key = await runSaveStep(
      telemetry,
      'upload',
      () => uploadToR2(input.documentId, versionId, contentHash, encryptedBlob),
    );
    const size = encryptedBlob.size;
    const now = new Date().toISOString();
    const metadata = (documentRow.metadata as DocumentMetadata | null) ?? null;
    const existingVersions = readVersionSummaries(metadata);
    const versionEntry: VersionInfo = {
      version: input.version,
      remark: input.remark,
      author: input.editorEmail,
      createdAt: now,
      sizeBytes: size,
    };

    emit(computeSaveProgress('persisting'));
    await runSaveStep(telemetry, 'document_versions_write', async () => {
      const { error: insertVersionError } = await supabase.from('document_versions').insert({
        id: versionId,
        document_id: input.documentId,
        version_label: input.version,
        note: input.remark || null,
        author_id: input.editorUserId,
        r2_key: r2Key,
        content_hash: contentHash,
        encrypted_meta: {
          title: input.fileName,
          selectedKeys: input.selectedKeys,
          keyVersion: nextKeyVersion,
        },
        key_version: nextKeyVersion,
        size_bytes: size,
      });

      if (insertVersionError) {
        throw insertVersionError;
      }
    });

    await runSaveStep(telemetry, 'documents_write', async () => {
      const { error: updateError } = await supabase
        .from('documents')
        .update({
          encrypted_title: input.fileName,
          size,
          path: r2Key,
          metadata: {
            ...metadata,
            latestVersion: input.version,
            latestRemark: input.remark,
            versions: [versionEntry, ...existingVersions],
            selectedKeys: input.selectedKeys,
            encryption: { enabled: true, version: 2 },
          },
          updated_at: now,
        })
        .eq('id', input.documentId);

      if (updateError) {
        throw updateError;
      }
    });

    telemetry.markStepStart('shared_users_fetch');
    let eligibleKeyRows: Array<{ user_id: string | null }> | null = null;
    try {
      const result = await supabase
        .from('document_keys')
        .select('user_id')
        .eq('document_id', input.documentId);

      if (result.error) {
        throw result.error;
      }

      eligibleKeyRows = (result.data as Array<{ user_id: string | null }> | null) ?? null;
    } catch (error) {
      telemetry.markFailure('shared_users_fetch', error);
      throw error;
    }

    const targetUserIds = Array.from(new Set(
      (eligibleKeyRows ?? [])
        .map((row) => row.user_id as string | null)
        .filter((value): value is string => Boolean(value)),
    ));
    const eligibleMemberCount = targetUserIds.length;
    const distributionTargetUserIds = targetUserIds.filter((userId) => userId !== input.editorUserId);
    const distributionMemberCount = distributionTargetUserIds.length;
    telemetry.markStepEnd('shared_users_fetch', { memberCount: eligibleMemberCount });

    await runSaveStep(telemetry, 'document_keys_write', async () => {
      await supabase.from('document_keys').insert({
        document_id: input.documentId,
        user_id: input.editorUserId,
        wrapped_document_key: editorWrappedKey,
        key_version: nextKeyVersion,
      });
    });

    telemetry.markStepStart('key_distribution', { memberCount: distributionMemberCount });
    try {
      const { distributed, failed, actualDistributed, concurrencyUsed, durationMs } = await distributeDocumentKeyConcurrently(
        {
          documentId: input.documentId,
          wrappedKey: nextDocumentKey,
          targetUserIds: distributionTargetUserIds,
          keyVersion: nextKeyVersion,
        },
        (docId, key, userId, version) => distributeDocumentKey(docId, key, userId, version),
      );

      if (failed.length > 0) {
        throw new Error(`密钥分发失败：${failed.map(f => f.userId).join(', ')}`);
      }

      telemetry.markStepEnd('key_distribution', {
        memberCount: distributionMemberCount,
        actualDistributed,
        concurrency: concurrencyUsed,
      });
    } catch (error) {
      telemetry.markFailure('key_distribution', error, { memberCount: distributionMemberCount });
      throw error;
    }

    telemetry.finish({ memberCount: distributionMemberCount });
    emit(computeSaveProgress('done'));
    return { documentId: input.documentId };
  } catch (error) {
    emit(computeSaveProgress('failed'));
    telemetry.markFailure('save_finished', error);
    throw error;
  }
}

export async function loadSharedDocument(
  userId: string,
  documentId: string,
): Promise<LoadedPersonalDocument> {
  const { data, error } = await supabase
    .from('documents')
    .select('path, metadata')
    .eq('id', documentId)
    .single();

  if (error || !data) {
    throw error || new Error('无法加载共享文档信息');
  }

  const metadata = (data.metadata as DocumentMetadata | null) ?? null;

  const { data: versionData, error: versionError } = await supabase
    .from('document_versions')
    .select('id, r2_key, content_hash, encrypted_meta, version_label, note, key_version')
    .eq('document_id', documentId)
    .order('created_at', { ascending: false })
    .limit(1)
    .single();

  if (versionError || !versionData) {
    throw versionError || new Error('无法加载文档版本');
  }

  const versionKeyVersion =
    typeof (versionData as { key_version?: unknown }).key_version === 'number'
      ? ((versionData as { key_version: number }).key_version)
      : null;

  let keyRows: Array<{ wrapped_document_key: string; key_version: number }> = [];

  if (versionKeyVersion !== null) {
    const { data: exactKeyData } = await supabase
      .from('document_keys')
      .select('wrapped_document_key, key_version')
      .eq('document_id', documentId)
      .eq('user_id', userId)
      .eq('key_version', versionKeyVersion)
      .limit(1);

    if (exactKeyData && exactKeyData.length > 0) {
      keyRows = exactKeyData as Array<{ wrapped_document_key: string; key_version: number }>;
    }
  }

  if (keyRows.length === 0) {
    const { data: fallbackKeyRows, error: fallbackKeyError } = await supabase
      .from('document_keys')
      .select('wrapped_document_key, key_version')
      .eq('document_id', documentId)
      .eq('user_id', userId)
      .order('key_version', { ascending: false })
      .limit(5);

    if (fallbackKeyError || !fallbackKeyRows || fallbackKeyRows.length === 0) {
      throw new Error('无法找到解密密钥，您可能没有该文档的访问权限');
    }

    keyRows = fallbackKeyRows as Array<{ wrapped_document_key: string; key_version: number }>;
  }

  let keyPair = await getUserKeyPair(userId);
  if (!keyPair) {
    await restoreUserPrivateKey();
    keyPair = await getUserKeyPair(userId);
  }
  if (!keyPair) {
    throw new Error('未找到用户密钥，请重新登录后重试');
  }

  let documentKey: CryptoKey | null = null;
  for (const row of keyRows) {
    try {
      documentKey = await unwrapDocumentKey(row.wrapped_document_key, keyPair.privateKey);
      break;
    } catch {
      const restoredLatest = await restoreUserPrivateKey();
      if (!restoredLatest) continue;
      keyPair = { ...keyPair, privateKey: restoredLatest };
      try {
        documentKey = await unwrapDocumentKey(row.wrapped_document_key, restoredLatest);
        break;
      } catch {
        continue;
      }
    }
  }

  if (!documentKey) {
    throw new Error('解密密钥不可用，无法解密该共享文档');
  }

  const encryptedBlob = await downloadFromR2(documentId, versionData.id as string);

  const encMeta = (versionData.encrypted_meta as { title?: string; selectedKeys?: string[] } | null) ?? null;
  const fileName = encMeta?.title || '未命名文档';

  const { file, meta } = await decryptDocumentChunked(
    encryptedBlob,
    documentKey,
    fileName,
    'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
  );

  const selectedKeys =
    Array.isArray(meta?.selectedKeys)
      ? (meta.selectedKeys as string[])
      : Array.isArray(encMeta?.selectedKeys)
        ? encMeta.selectedKeys
        : Array.isArray(metadata?.selectedKeys)
          ? (metadata.selectedKeys as string[])
          : undefined;

  const version =
    (versionData.version_label as string | null) ??
    (metadata?.latestVersion ?? null);

  const remark =
    (versionData.note as string | null) ??
    (metadata?.latestRemark ?? null);

  return { file, version, remark, selectedKeys };
}


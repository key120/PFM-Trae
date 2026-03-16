import { supabase } from '../lib/supabase';

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

interface VersionInfo {
  version: string;
  remark: string;
  author: string | null;
  createdAt: string;
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
}

interface DocumentsRow {
  id: string;
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

export async function fetchPersonalDocuments(userId: string): Promise<PersonalDocument[]> {
  const { data, error } = await supabase
    .from('documents')
    .select('id, size, path, created_at, updated_at, metadata')
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
      name: row.path ? row.path.split('/').pop() || '未命名文档' : '未命名文档',
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
  const objectName = `${input.userId}/${Date.now()}-${Math.random()
    .toString(36)
    .slice(2)}.docx`;

  const { error: uploadError } = await supabase.storage
    .from('documents')
    .upload(objectName, input.blob, {
      contentType:
        'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
    });

  if (uploadError) {
    throw uploadError;
  }

  const size = input.blob.size;
  const now = new Date().toISOString();
  const versionEntry: VersionInfo = {
    version: input.version,
    remark: input.remark,
    author: input.authorEmail,
    createdAt: now,
  };
  const encryptedTitle = input.fileName;

  if (!input.documentId) {
    const metadata: DocumentMetadata = {
      latestVersion: input.version,
      latestRemark: input.remark,
      versions: [versionEntry],
      selectedKeys: input.selectedKeys,
      encryption: { enabled: true, version: 1 },
    };
    const { data, error } = await supabase
      .from('documents')
      .insert({
        owner_id: input.userId,
        encrypted_title: encryptedTitle,
        size,
        type: 'docx',
        path: objectName,
        metadata,
        updated_at: now,
      })
      .select('id')
      .single();

    if (error || !data) {
      throw error || new Error('Failed to create document');
    }

    return { documentId: data.id as string };
  }

  const { data: existing, error: loadError } = await supabase
    .from('documents')
    .select('metadata')
    .eq('id', input.documentId)
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
    encryption: { enabled: true, version: 1 },
  };

  const { data, error } = await supabase
    .from('documents')
    .update({
      encrypted_title: encryptedTitle,
      size,
      type: 'docx',
      path: objectName,
      metadata,
      updated_at: now,
    })
    .eq('id', input.documentId)
    .eq('owner_id', input.userId)
    .select('id')
    .single();

  if (error || !data) {
    throw error || new Error('Failed to update document');
  }

  return { documentId: data.id as string };
}

export async function loadPersonalDocument(
  userId: string,
  documentId: string,
): Promise<LoadedPersonalDocument> {
  const { data, error } = await supabase
    .from('documents')
    .select('path, metadata')
    .eq('id', documentId)
    .eq('owner_id', userId)
    .single();

  if (error || !data) {
    throw error || new Error('Failed to load document metadata');
  }

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
  const fileName = path.split('/').pop() || '未命名文档';
  const file = new File([blob], fileName, {
    type: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
  });

  const metadata = (data.metadata as DocumentMetadata | null) ?? null;
  const latestVersion =
    metadata && typeof metadata.latestVersion === 'string'
      ? metadata.latestVersion
      : null;
  const latestRemark =
    metadata && typeof metadata.latestRemark === 'string'
      ? metadata.latestRemark
      : null;
  const selectedKeys =
    metadata && Array.isArray(metadata.selectedKeys)
      ? (metadata.selectedKeys as string[])
      : undefined;

  return {
    file,
    version: latestVersion,
    remark: latestRemark,
    selectedKeys,
  };
}

-- 创建 document_versions 表作为真实版本下载源
-- 注意：字段以线上实际结构为准（2026-03-24 Task F 联调后确认）
CREATE TABLE IF NOT EXISTS document_versions (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  document_id UUID NOT NULL REFERENCES documents(id) ON DELETE CASCADE,
  version_label TEXT NOT NULL,                    -- 版本号，如 V1.0.0
  note TEXT,                                      -- 备注
  author_id UUID REFERENCES auth.users(id),       -- 作者
  r2_key TEXT,                                    -- R2 对象键
  content_hash TEXT,                              -- 加密内容 SHA-256 哈希
  encrypted_meta JSONB,                           -- 加密后的元数据（title/selectedKeys 等）
  size_bytes BIGINT,                              -- 加密内容字节数
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX idx_document_versions_document_id ON document_versions(document_id);
CREATE INDEX idx_document_versions_created_at ON document_versions(document_id, created_at DESC);

-- 创建 document_keys 表用于存储每用户的 wrapped_document_key
-- 注意：字段以线上实际结构为准（2026-03-24 Task F 联调后确认）
CREATE TABLE IF NOT EXISTS document_keys (
  document_id UUID NOT NULL REFERENCES documents(id) ON DELETE CASCADE,
  user_id UUID NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE,
  wrapped_document_key TEXT NOT NULL,      -- 用用户公钥封装后的文档密钥（base64）
  key_version INT NOT NULL DEFAULT 1,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  PRIMARY KEY (document_id, user_id, key_version)
);

CREATE INDEX idx_document_keys_document_user ON document_keys(document_id, user_id);
CREATE INDEX idx_document_keys_user ON document_keys(user_id);

-- RLS 策略
ALTER TABLE document_versions ENABLE ROW LEVEL SECURITY;
ALTER TABLE document_keys ENABLE ROW LEVEL SECURITY;

-- document_versions: 仅文档成员可读
CREATE POLICY "Document members can view versions"
  ON document_versions FOR SELECT
  USING (
    EXISTS (
      SELECT 1 FROM documents
      WHERE documents.id = document_versions.document_id
      AND documents.owner_id = auth.uid()
    )
  );

-- document_versions: 仅 owner 可写入版本
CREATE POLICY "Document owner can insert versions"
  ON document_versions FOR INSERT
  WITH CHECK (
    EXISTS (
      SELECT 1 FROM documents
      WHERE documents.id = document_versions.document_id
      AND documents.owner_id = auth.uid()
    )
  );

-- document_keys: 仅 key 归属用户本人可读
CREATE POLICY "Users can view own document keys"
  ON document_keys FOR SELECT
  USING (auth.uid() = user_id);

-- document_keys: 仅 owner 可为用户写入 wrapped key
CREATE POLICY "Document owner can insert keys"
  ON document_keys FOR INSERT
  WITH CHECK (
    EXISTS (
      SELECT 1 FROM documents
      WHERE documents.id = document_keys.document_id
      AND documents.owner_id = auth.uid()
    )
  );

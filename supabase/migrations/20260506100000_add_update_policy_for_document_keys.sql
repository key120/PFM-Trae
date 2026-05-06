-- 添加 UPDATE 策略，允许文档所有者更新已分发的密钥记录
-- 修复：upsert 在冲突时需要 UPDATE 权限，缺少此策略导致共享文档时 403 错误
CREATE POLICY "Document owner can update distributed keys"
  ON document_keys FOR UPDATE
  USING (
    EXISTS (
      SELECT 1 FROM documents
      WHERE documents.id = document_keys.document_id
      AND documents.owner_id = auth.uid()
    )
  )
  WITH CHECK (
    EXISTS (
      SELECT 1 FROM documents
      WHERE documents.id = document_keys.document_id
      AND documents.owner_id = auth.uid()
    )
  );

-- 同时添加：允许用户读取别人共享给自己的密钥（共享文档解密需要）
CREATE POLICY "Users can read keys shared to them"
  ON document_keys FOR SELECT
  USING (user_id = auth.uid());

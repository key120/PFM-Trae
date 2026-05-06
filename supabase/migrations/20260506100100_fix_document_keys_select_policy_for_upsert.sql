-- 修复：文档所有者共享文档时 upsert 报 403 错误
-- 根因：PostgreSQL 的 INSERT ... ON CONFLICT 需要 SELECT 权限来检测冲突行
-- 现有 SELECT 策略只允许 user_id = auth.uid()，导致所有者无法"看到"目标用户的潜在冲突行
-- 解决：添加 SELECT 策略，允许文档所有者读取其文档的所有密钥记录

CREATE POLICY "Document owner can read all keys for own docs"
  ON document_keys FOR SELECT
  USING (
    EXISTS (
      SELECT 1 FROM documents
      WHERE documents.id = document_keys.document_id
      AND documents.owner_id = auth.uid()
    )
  );

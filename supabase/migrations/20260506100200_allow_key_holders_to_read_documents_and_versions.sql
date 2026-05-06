-- 允许持有 document_keys 的用户读取文档元数据
-- 共享流程通过 distributeDocumentKey 分发密钥，持有密钥即代表有访问权
-- 注意：不能直接在 documents 策略中 EXISTS 查询 document_keys，因为 document_keys
-- 的策略又会查询 documents，导致 infinite recursion（42P17）。
-- 解决方案：使用 SECURITY DEFINER 函数绕过 RLS 检查 document_keys。

CREATE OR REPLACE FUNCTION public.user_has_document_key(p_document_id uuid)
RETURNS boolean
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = public
AS $$
  SELECT EXISTS (
    SELECT 1 FROM document_keys
    WHERE document_id = p_document_id
    AND user_id = auth.uid()
  );
$$;

CREATE POLICY "Key holders can read document metadata"
  ON documents FOR SELECT
  USING (public.user_has_document_key(id));

CREATE POLICY "Key holders can read document versions"
  ON document_versions FOR SELECT
  USING (public.user_has_document_key(document_id));

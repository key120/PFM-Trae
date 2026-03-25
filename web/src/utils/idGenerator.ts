/**
 * ID 生成工具
 * 使用 crypto.randomUUID() 生成符合 UUID v4 标准的 ID
 */

export const generateDocumentId = (): string => {
  if (typeof crypto !== 'undefined' && crypto.randomUUID) {
    return crypto.randomUUID();
  }
  // 降级方案：使用时间戳 + 随机数
  return `${Date.now()}-${Math.random().toString(36).slice(2)}`;
};

export const generateVersionId = (): string => {
  if (typeof crypto !== 'undefined' && crypto.randomUUID) {
    return crypto.randomUUID();
  }
  return `${Date.now()}-${Math.random().toString(36).slice(2)}`;
};

# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## 项目概览

- 这是一个以 `web/` 为主的前端项目：Vite + React + TypeScript + Ant Design。
- 核心用户流程是：上传 DOCX → 解析标题结构 → 预览文档 → 勾选保留章节 → 导出新 DOCX。
- 认证依赖 Supabase Auth；前端状态主要由 Zustand 管理。
- 代码里已经有密钥管理、加密 Blob 格式、团队共享表结构，但当前主 UI 仍以“个人文档”流程为主，共享功能还没真正接通。

## 常用命令

所有前端命令都在 `web/` 目录下执行：

```bash
cd web
npm install
npm run dev
npm run build
npm run lint
npm run test
npm run preview
```

运行单个测试文件：

```bash
cd web
npx vitest run src/services/documentService.test.ts
```

运行单个测试用例：

```bash
cd web
npx vitest run src/services/documentService.test.ts -t "loads document from storage"
```

## 运行注意事项

- `npm run dev` 会先执行 `web/scripts/pre-start.js`，它会用 `lsof` 查找占用 `3000` 端口的进程，并直接执行 `kill -9`。如果本机有别的服务跑在 3000 端口，启动前先确认。
- `web/src/lib/supabase.ts` 在模块加载时就会读取环境变量；缺少下面两个变量时会直接抛错：

```bash
VITE_SUPABASE_URL=...
VITE_SUPABASE_ANON_KEY=...
```

## 高层架构

### 1. 路由、认证与应用外壳

- `web/src/main.tsx` 只负责挂载路由。
- `web/src/router/index.tsx` 目前只有 `/dashboard`、`/login`、`/register` 和兜底 `*` 路由；受保护区域统一包在 `AuthGuard` + `MainLayout` 里。
- `web/src/components/AuthGuard.tsx` 会在首次进入时触发 `useAuthStore.initialize()`；未登录时跳回 `/login`。
- `web/src/store/useAuthStore.ts` 是认证状态中心：
  - 从 `supabase.auth.getSession()` 初始化 session。
  - 订阅 `onAuthStateChange`。
  - 用户切换或登出时重置 `useDocStore`。
  - 登录后异步调用 `ensureUserKeyPair`，但这里的异常会被吞掉，不阻断登录。
- `web/src/layout/MainLayout.tsx` 提供顶部导航、用户菜单和右侧文档抽屉；“共享文档”标签页目前只是占位。

### 2. 文档主流程由 Dashboard 编排

- `web/src/pages/Dashboard.tsx` 是核心编排页：
  - 监听 `currentFile`，在文件变化后调用 `parseDocumentHeadings` 解析目录。
  - 初始化/恢复 `checkedKeys`。
  - 打开保存弹窗并调用 `savePersonalDocument`。
  - 调用 `exportDocument` 导出过滤后的文档。
  - 保存成功后会派发 `personalDocumentsChanged` 事件，驱动文档列表刷新。
- `web/src/store/useDocStore.ts` 保存当前文件、解析状态、标题树、勾选结果、当前文档 ID/版本，以及 `initialCheckedKeys`。
- `web/src/components/UploadZone.tsx` 只接受小于 50MB 的 DOCX，并把文件写入 `useDocStore`。

### 3. DOCX 解析、预览和导出是三条不同链路

#### 标题解析

- `web/src/utils/docParser.ts` 用 `mammoth` 先把 DOCX 转成 HTML，再从 `h1-h6` 和目录（TOC）样式里恢复标题树。
- 这里有不少启发式逻辑：会尝试把目录里的章节号映射回标题文本，因此修改解析逻辑时要同时考虑“正文标题”和“目录标题”两种来源。

#### 预览渲染

- `web/src/components/DocumentPreview.tsx` 先用 `docx-preview` 渲染，再做大量 DOM 级后处理。
- 这个组件不仅是“显示文档”，还负责：
  - 手动分页
  - 目录强制换页
  - 页眉/页脚重排
  - 页码重写
  - 重新填补分页空白和再次分页
- 如果预览页数、目录分页、页眉页脚位置出问题，优先看这个文件，而不是只看样式文件。

#### 导出 DOCX

- `web/src/utils/documentExporter.ts` 不是重新生成 DOCX，而是直接用 `JSZip` 改写原始 DOCX 包内的 XML：
  - 读取 `word/document.xml` 和 `word/styles.xml`
  - 按勾选章节删掉不需要的段落
  - 自动把父级标题补进导出集合
  - 用 `numbering.ts` 重新计算标题编号
  - 显式写入 `w:numId=0` 来关闭 Word 自动编号，再把新的编号直接写回标题文本
  - 更新 `word/settings.xml`，强制 Word 打开后刷新 TOC 字段
- 因为这里直接操作 WordprocessingML，任何“看起来只是文案/样式调整”的改动都可能影响导出结果。

### 4. 当前已接通的持久化路径：加密 + R2 + Supabase

`web/src/services/documentService.ts` 是当前 UI 真正在用的文档服务层，已完整接通加密和 R2 上传：

- `fetchPersonalDocuments(userId)`
  - 读取 `documents` 表
  - 只保留 `metadata.encryption.enabled === true` 的记录
  - 过滤掉 `path` 以 `r2://dummy` 开头的测试数据
  - 从 `metadata.latestVersion` / `metadata.latestRemark` / `metadata.versions` 组装列表项
- `savePersonalDocument(...)` — 完整加密上传流程（6 步）：
  1. 生成 `documentId`（新建）或复用已有 ID，同时生成 `versionId`
  2. 从 IndexedDB 读取用户 RSA 公钥
  3. 生成本次 AES-GCM-256 文档密钥 `documentKey`
  4. 用公钥封装 `documentKey` → `wrappedKey`，写入 `document_keys` 表
  5. 用 `encryptDocumentChunked` 分块加密原始 DOCX，获得 `encryptedBlob` + `contentHash`
  6. 调用 `r2-sign-upload` Edge Function 获取预签名 PUT URL，上传到 R2；同时写 `document_versions` 和 `documents` 表
- `loadPersonalDocument(...)`
  - 从 `document_versions` 表取最新版本的 `r2_key` 和 `encrypted_meta`
  - 调用 `r2-sign-download` Edge Function 获取预签名 GET URL，从 R2 下载加密 Blob
  - 用 `unwrapDocumentKey` + 私钥解封 `wrappedKey`，再用 `decryptDocumentChunked` 解密
  - 恢复成 `File` 并带回 `selectedKeys`

**Supabase 数据库表结构（完整）：**
- `documents`：文档主记录，`owner_id`、`encrypted_title`、`metadata`（含版本摘要）
- `document_versions`：每次保存的版本行，含 `r2_key`、`content_hash`、`encrypted_meta`、`size_bytes`
- `document_keys`：每用户的 `wrapped_document_key`（RSA 封装后），主键 `(document_id, user_id, key_version)`
- 团队相关表见第 6 节

**Edge Functions（`supabase/functions/`）：**
- `r2-sign-upload`：验证 JWT + 文档所有权，返回 R2 预签名 PUT URL（5 分钟有效），并写 `audit_logs`
- `r2-sign-download`：验证 JWT + 文档所有权，返回 R2 预签名 GET URL
- `key-backup` / `key-restore`：私钥备份/恢复（通过 master key 加密）
- R2 对象键格式：`pfm-trae/{env}/documents/{documentId}/{versionId}/{hash32}.bin`

### 5. 加密体系（已接通主路径）

- `web/src/services/cryptoKeyService.ts` 管理每用户 RSA-OAEP 密钥对：
  - 本地存到 IndexedDB：`pfm_trae_crypto / user_keys`
  - 登录后 `ensureUserKeyPair()` 会按”本地读取 → 远端恢复 → 重新生成”的顺序尝试拿到密钥
  - 公钥会写回 Supabase `profiles.public_key`
  - 私钥备份/恢复通过 Edge Functions：`key-backup` / `key-restore`
- `web/src/services/encryptionService.ts` 提供两套加密 Blob 格式：
  - v1：单次 AES-GCM 加密
  - v2：分块 AES-GCM 加密，默认 chunk size 为 1MB，带 header、meta hash 和完整性校验
  - `savePersonalDocument` 使用 v2（`encryptDocumentChunked`）
- `web/src/utils/idGenerator.ts`：用 `crypto.randomUUID()` 生成 `documentId` 和 `versionId`

### 6. “共享/团队”目前主要停留在 SQL 和占位 UI

- `supabase/migrations/20250321000001_team_tables.sql` 和 `20250321000002_shares_notifications.sql` 已经建立了团队共享相关表和 RLS：
  - `teams`
  - `team_groups`
  - `team_members`
  - `team_invitations`
  - `document_shares`
  - `notifications`
- 但前端还没真正接通：
  - `MainLayout.tsx` 的“共享文档”标签页只是提示“开发中”。
  - `PersonalDocumentList.tsx` 里的“共享 / 取消共享”只是在组件本地状态里切换，不会写数据库。

## 测试分布

- `web/src/services/*.test.ts`：服务层测试，覆盖文档存储、密钥恢复、加密格式等核心逻辑。
- `web/src/store/useAuthStore.test.ts`：认证初始化和密钥初始化副作用。
- `web/src/components/*.test.tsx`、`web/src/layout/*.test.tsx`：界面和交互行为测试。
- 测试环境入口在 `web/src/test/setup.ts`。

## 额外说明

- `web/README.md` 仍是默认 Vite 模板，项目特有信息主要以源码和本文件为准。
- 仓库根目录的 `开发计划.md`、`需求文档.md`、`部署指南.md` 更偏产品/计划信息；做实现时优先以当前代码路径是否真的接通为准。
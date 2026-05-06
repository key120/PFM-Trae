# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## 项目概览
- 项目名：项目文档管理器（PFM‑Trae）
- 前端入口：`web/`（Vite 7 + React 19 + TypeScript 5.9 + Ant Design 6）
- 主要流程：上传 DOCX → 解析标题 → 预览 → 勾选章节 → 保存加密版本 / 导出新 DOCX
- 认证：Supabase Auth；状态管理：Zustand 5；加密文档存储：Cloudflare R2
- 当前开发主线是“个人文档加密保存/加载 + 密钥备份恢复 + 团队基础设施”；团队管理已具备可用 UI，但文档共享主界面仍在开发中。
- 所有 UI 文本为中文。

## 常用命令
> 所有命令均在项目根目录的 `web/` 子目录执行。

```bash
cd web
npm install           # 安装依赖
npm run dev           # 启动开发服务器（预先会 kill 占用 3000 端口的进程）
npm run build         # 打包生产构建
npm run lint          # 代码检查
npm run test          # 运行全部单元/集成测试
npm run test:watch    # 监听模式运行测试
npm run preview       # 本地预览构建产物
```

### 运行单个测试文件/用例
```bash
cd web
# 运行单个测试文件
npx vitest run src/services/documentService.test.ts

# 按测试名筛选（-t 支持子串/正则）
npx vitest run src/store/useAuthStore.test.ts -t "initialize 时会调用 ensureUserKeyPair"
```

## 运行注意事项
- `npm run dev` 会先执行 `web/scripts/pre-start.js`，使用 `lsof` 检测并 **kill -9** 占用 `3000` 端口的进程。若本机有其他服务占用该端口，请先修改 Vite 端口或手动停止对应进程。
- `web/src/lib/supabase.ts` 会在模块加载时读取环境变量，缺少以下两个变量会直接抛错：
  ```bash
  VITE_SUPABASE_URL=...
  VITE_SUPABASE_ANON_KEY=...
  ```
- 前端环境变量文件位于 `web/.env`。
- Vite 开发服务器固定使用 `3000` 端口且启用 `strictPort`；测试运行在 `jsdom` 环境，入口为 `web/src/test/setup.ts`。
- Edge Function 部署需要的服务端环境变量（不在前端 `.env` 中）：`MASTER_KEY_BASE64`、`R2_ACCOUNT_ID`、`R2_BUCKET_NAME`、`R2_ACCESS_KEY_ID`、`R2_SECRET_ACCESS_KEY`、`R2_S3_ENDPOINT`。
- `web/vercel.json` 配置了 SPA 回退 `/(.*) -> /index.html`。

## 高层架构概览
### 1. 前端分层与数据流
- 页面编排层：`web/src/pages/`（如 `Dashboard.tsx`）负责串联上传、解析、预览、保存、导出等用户流程。
- 状态层：`web/src/store/`（Zustand）集中管理认证态、文档态、团队态；`useDocStore` 持有当前文件、目录树、勾选结果、当前文档 ID/版本，`useAuthStore` 在用户切换时驱动文档态重置。
- 服务层：`web/src/services/` 封装 Supabase/R2/加密等副作用，UI 不直接操作后端细节。
- 组件与工具层：`web/src/components/` 承载交互与展示，`web/src/utils/` 提供 DOCX 解析与导出等纯处理逻辑。

### 2. 应用启动、路由与应用壳
- `web/src/router/index.tsx` 当前只有一个受保护主流程页 `Dashboard`；公开路由为 `Login`、`Register` 与 `NotFound`。
- `web/src/main.tsx` 只负责挂载 `AppRouter`；真正的登录态初始化与未登录重定向发生在 `AuthGuard`，因此启动/跳转问题通常要联看 `main.tsx`、`router/index.tsx`、`AuthGuard.tsx` 与 `useAuthStore`。
- `MainLayout` 是登录后统一壳层：头部用户区、团队入口、通知抽屉、文档抽屉（个人/共享）都挂在这里。
- `MainLayout` 在壳层启动时拉取团队列表和邀请通知，并把当前团队按用户维度持久化到 `localStorage`。

### 3. 认证、团队上下文与通知
- `useAuthStore` 负责 Supabase 会话初始化与监听；在首次加载和 auth state change 时都会尝试 `ensureUserKeyPair`，并在用户切换时调用 `useDocStore.reset()`。
- `useTeamStore` 保存团队列表与 `currentTeamId`；`teamService` 提供创建团队、成员组、邀请成员、接受/拒绝邀请、通知读取等团队域能力。
- 团队通知流的入口在 `MainLayout`，因此团队邀请相关问题通常需要同时查看 `MainLayout`、`useTeamStore` 和 `teamService`。

### 4. 文档主链路（上传 → 解析 → 预览 → 保存/导出）
- 上传与目录解析：`UploadZone` + `docParser`。
- 预览与勾选：`DocumentPreview` + `TableOfContents`。
- 页面状态串联：`Dashboard` 结合 `useDocStore` 管理当前文件、目录树、勾选章节、当前文档 ID 与版本。
- 保存与读取：`documentService` 负责文档版本、密钥分发、R2 上传下载与解密回读。
- 个人文档抽屉中的 `PersonalDocumentList` 不是只做列表展示：它会调用 `loadPersonalDocument` 解密下载文档，再把 `File`、版本号和 `selectedKeys` 回填到 `useDocStore`，从而把历史文档重新装载回 `Dashboard` 的编辑态。
- 导出：`documentExporter` 按勾选章节重写 DOCX 内容。

### 5. 加密与存储闭环
- 前端密钥管理：`cryptoKeyService` 负责本地 RSA 密钥对、私钥备份/恢复、文档密钥包装。
- 后端签名与备份：`supabase/functions/` 中 `r2-sign-upload`、`r2-sign-download`、`key-backup`、`key-restore` 与前端服务协同完成加密存储闭环。
- 数据层：`documents` / `document_versions` / `document_keys` 与团队相关表共同支撑个人文档、版本与共享能力。

### 6. 团队与共享能力现状
- 团队域能力已落在 `teamService` + `useTeamStore` + `TeamInfoModal`（创建团队、成员组、邀请、成员信息维护）；邀请通知、接受/拒绝邀请通过 `MainLayout` 打通。
- 文档共享底层能力已在 `documentService` 与对应测试中实现；共享文档主界面仍在开发中。

## 测试概览
- 核心业务：`documentService.test.ts`（加密上传、版本管理、下载解密）
- 共享逻辑：`documentService.sharing.test.ts`
- 加密实现：`encryptionService.test.ts`、`cryptoKeyService.test.ts`
- 团队管理：`teamService.test.ts`
- 认证与密钥初始化：`useAuthStore.test.ts`
- UI 交互测试：`*.test.tsx`（个人文档列表、保存弹窗、团队弹窗、布局等）
- 测试入口：`web/src/test/setup.ts`

## 当前开发进度
- 已完成：个人文档加密保存/加载、版本元数据管理、R2 预签名上传下载、用户私钥备份恢复、登录后自动密钥初始化。
- 已完成：团队创建、成员查看、成员组管理、邀请成员、团队入口 UI。
- 进行中：共享文档主界面与个人文档列表中的真实共享操作；当前布局中“共享文档”页仍显示“功能开发中”，个人文档列表中的共享相关弹窗也还不是完整业务流。

## 测试账号与测试数据
- 测试账号邮箱：`key120@126.com`
- 测试账号密码：`37201120`
- 测试文档：项目根目录下的 `1.docx`

## 额外说明
- 项目根目录未包含 `.cursor/rules/`、`.cursorrules` 或 `.github/copilot-instructions.md`，因此暂无额外 Copilot/Cursor 规则。
- `.trae/rules/project_rules.md` 仅补充了浏览器测试账号和上传测试文档位置，已反映在“测试账号与测试数据”中。
- `web/README.md` 仍是默认 Vite 模板，项目特有信息以本文件为准。
- `web/scripts/pre-start.js` 会在启动开发服务前调用 `lsof` 并 `kill -9` 占用 3000 端口的进程；启动前注意确认该端口没有其他重要服务。

# Vercel Preview Deployments 使用指南

## 📖 快速开始

### 什么是 Preview Deployments？

Vercel 会为每个 Git 分支自动创建独立的预览部署，让你可以在合并代码前预览实际效果。

**你的项目部署结构：**

| 分支 | 部署类型 | URL 格式 |
|------|---------|---------|
| `main` | 生产部署 | `https://pfm-trae.vercel.app` |
| `3.12-FileList` | 预览部署 | `https://pfm-trae-git-3-12-filelist-[username].vercel.app` |
| 其他分支 | 预览部署 | `https://pfm-trae-git-分支名-[username].vercel.app` |

---

## 🚀 立即使用预览部署

### 方法 1：查看 `3.12-FileList` 分支的预览部署

你的代码已经推送到 `3.12-FileList` 分支，现在就可以查看预览部署！

#### 步骤：

1. **访问 Vercel Dashboard**
   ```
   https://vercel.com/dashboard
   ```

2. **找到你的项目**
   - 点击 `PFM-Trae` 项目卡片

3. **查看部署记录**
   - 点击顶部 **"Deployments"** 标签页
   - 找到 `3.12-FileList` 分支的部署（应该有 2 个：`main` 和 `3.12-FileList`）

4. **访问预览 URL**
   - 点击 `3.12-FileList` 部署行的 **"Preview"** 按钮
   - 或直接复制 URL，格式类似：
     ```
     https://pfm-trae-git-3-12-filelist-key120.vercel.app
     ```

---

### 方法 2：为新的功能分支创建预览部署

#### 创建新分支并推送：

```bash
# 1. 从 main 创建新分支
git checkout main
git pull
git checkout -b feature/my-new-feature

# 2. 做一些修改
# ... 编辑你的代码 ...
git add .
git commit -m "feat: 添加新功能"

# 3. 推送到远程分支
git push -u origin feature/my-new-feature
```

#### 等待自动部署：

- 推送后 2-5 分钟，Vercel 会自动创建预览部署
- 访问 Vercel Dashboard 查看部署状态
- 预览 URL 格式：
  ```
  https://pfm-trae-git-feature-my-new-feature-key120.vercel.app
  ```

---

## 📱 访问预览部署的 3 种方式

### 方式 1：Vercel Dashboard（推荐）

1. 访问 [vercel.com/dashboard](https://vercel.com/dashboard)
2. 点击项目名称 `PFM-Trae`
3. 点击 **"Deployments"** 标签页
4. 找到对应分支的部署
5. 点击 **"Preview"** 按钮

### 方式 2：通过 GitHub Pull Request

如果你为分支创建了 Pull Request：

1. 打开 GitHub 上的 PR 页面
2. 滚动到评论区
3. Vercel 会自动添加评论，包含预览链接
4. 点击 **"Preview"** 查看

### 方式 3：使用 Vercel CLI

```bash
# 安装 Vercel CLI（首次使用）
npm install -g vercel

# 登录
vercel login

# 查看当前项目的所有部署
vercel ls

# 查看特定分支的部署
vercel ls --branch 3.12-FileList
```

---

## ⚙️ 配置选项（可选）

### 环境变量配置

在 Vercel 项目设置中为不同环境配置变量：

1. 进入项目设置 → **"Environment Variables"**
2. 添加变量时选择作用域：
   - **Production**：仅生产部署可用
   - **Preview**：仅预览部署可用
   - **Development**：本地开发可用

**示例配置：**

```bash
# 生产环境
VITE_SUPABASE_URL=https://xxx.supabase.co
VITE_SUPABASE_ANON_KEY=xxx_production_key

# 预览环境（可以使用测试数据）
VITE_SUPABASE_URL=https://xxx.supabase.co
VITE_SUPABASE_ANON_KEY=xxx_test_key
```

### 忽略某些分支的部署

如果不想让某些分支触发部署：

1. 项目设置 → **"Git"**
2. **"Ignored Branches"** → 添加分支名
3. 例如：`develop`、`wip/*`

---

## 🔍 常见问题

### Q1: 为什么推送后没有自动部署？

**检查清单：**

1. ✅ 确认 Vercel 项目已连接 GitHub 仓库
2. ✅ 访问 [vercel.com/dashboard](https://vercel.com/dashboard) 查看项目
3. ✅ 检查 **"Deployments"** 页面是否有错误信息
4. ✅ 查看邮箱（部署失败时 Vercel 会发送邮件通知）

### Q2: 如何知道预览部署是否成功？

**查看部署状态：**

1. Vercel Dashboard → 项目 → **"Deployments"**
2. 状态标识：
   - 🟢 **Ready**：部署成功
   - 🟡 **Building**：正在构建
   - 🔴 **Error**：部署失败（点击查看错误日志）

### Q3: 预览部署会保留多久？

- 每个分支保留**最近 20 个**部署
- 旧的部署会自动删除
- 生产部署永久保留

### Q4: 如何删除预览部署？

**方法 1：通过 Dashboard**
1. Vercel Dashboard → 项目 → **"Deployments"**
2. 找到要删除的部署
3. 点击右侧 **"..."** → **"Delete"**

**方法 2：删除远程分支**
```bash
git push origin --delete 分支名
```
删除分支后，对应的预览部署会自动清理。

### Q5: 预览部署会收费吗？

**Vercel Hobby 计划（免费）包括：**
- ✅ 无限次生产部署
- ✅ 无限次预览部署
- ✅ 每月 100GB 带宽
- ✅ 自动 HTTPS 证书

对于个人项目完全够用！

---

## 🎯 你的下一步操作

### 现在就开始！

1. **访问 Vercel Dashboard**
   ```
   https://vercel.com/dashboard
   ```

2. **找到 `PFM-Trae` 项目**

3. **查看 `3.12-FileList` 分支的预览部署**
   - 点击 **"Deployments"** 标签页
   - 找到 `3.12-FileList` 分支
   - 点击 **"Preview"** 按钮

4. **分享预览链接给团队成员**
   - 复制预览 URL
   - 任何人都可以访问（无需登录 Vercel）

### 测试预览部署

访问预览 URL 后，你可以：

1. ✅ 测试最新代码（包含 TypeScript 修复）
2. ✅ 验证功能是否正常工作
3. ✅ 分享给其他人测试
4. ✅ 确认无误后合并到 `main` 分支

---

## 📚 更多资源

- [Vercel 官方文档 - Preview Deployments](https://vercel.com/docs/deployments/preview-deployments)
- [Vercel 官方文档 - Git 集成](https://vercel.com/docs/git)
- [Vercel Dashboard](https://vercel.com/dashboard)

---

**最后更新**: 2026-03-26  
**项目**: PFM-Trae  
**当前分支**: `main` (a5c7bfb)

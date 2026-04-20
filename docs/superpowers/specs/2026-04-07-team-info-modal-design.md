# 团队信息弹窗设计文档

**日期**：2026-04-07  
**涉及子任务**：子任务 4（邀请成员）、子任务 5（成员管理）

---

## 1. 整体结构

### 入口
`MainLayout.tsx` 中"团队信息"菜单项，有团队时启用（`hasTeams` 为 true），点击调用 `handleOpenTeamInfo()`，打开 `TeamInfoModal`，传入 `currentTeamId`。

### Modal 布局
- 宽度：800px，高度：560px，无底部按钮栏（内容区自带操作按钮）
- 左侧菜单区（200px）：Ant Design `Menu` 组件
  - 菜单项 1：`invite` — "通过邮箱邀请"（仅 admin 可见）
  - 菜单项 2：`members` — "成员管理"（SubMenu，可展开）
    - 子项：固定"未分组"
    - 子项：当前团队的每个 `team_groups` 记录
    - SubMenu 标题旁有 `+` 图标，点击打开新建成员组弹窗
- 右侧内容区（600px）：根据左侧选中项渲染 `InvitePanel` 或 `MemberPanel`

### 权限控制
- 当前用户角色从 `team_members` 中读取（`role` 字段）
- admin：可见"通过邮箱邀请"，成员管理操作列启用
- 非 admin：不显示"通过邮箱邀请"，操作列禁用

---

## 2. 子任务 4：邀请成员面板（InvitePanel）

### 数据加载
- 打开 Modal 时调用 `fetchTeamGroups(teamId)` 拉取成员组列表，用于"成员组"下拉选项

### 表单结构
每行字段：
| 字段 | 类型 | 必填 | 默认值 |
|------|------|------|--------|
| 邮箱 | Input | 是 | — |
| 姓名 | Input | 否 | — |
| 成员组 | Select | 否 | 无 |
| 角色 | Select | 否 | 只读 |

角色选项：只读（reader）/ 可编辑（editor）/ 管理员（admin）

- 初始显示 1 行，无删除按钮
- 后续行右侧显示 × 删除按钮
- "再加一个"链接追加新行（最多不限制）
- "确定"按钮：任一行邮箱为空则阻止提交并高亮错误

### 提交逻辑（`inviteMembers`）
1. 校验所有行邮箱非空且格式合法
2. 对每行邮箱查询 `profiles` 表，若存在则填入 `invitee_user_id`
3. 批量写入 `team_invitations`（status=pending）
4. 成功后 message.success 提示，重置表单为初始 1 行

### 错误处理
- 邮箱格式错误：行内红色提示
- 重复邀请（已在 team_members 中）：提示"该用户已是团队成员"
- 网络错误：message.error 提示

---

## 3. 子任务 5：成员管理面板（MemberPanel）

### 数据加载
- 打开 Modal 时调用 `fetchTeamMembers(teamId)` 拉取 status='active' 的成员
- join `profiles` 获取邮箱（通过 Supabase select 关联查询）
- 左侧切换成员组时，前端按 `group_id` 过滤（不重新请求）

### 表格
列：名字 / 邮箱 / 成员组 / 角色 / 操作

- 分页：前端分页，每页 10 条，Ant Design Table pagination
- 角色显示：只读 / 可编辑 / 管理员（对应 reader/editor/admin）
- 成员组显示：组名，无组显示"未分组"
- 操作列：编辑按钮 + 删除按钮；非 admin 时两个按钮均 disabled

### 编辑成员（小 Modal）
字段：姓名（Input）、成员组（Select）、角色（Select）  
确认后调用 `updateMember(memberId, { name, groupId, role })`，UPDATE `team_members`，刷新列表。

### 删除成员
Popconfirm 确认后调用 `removeMember(memberId)`，将 `status` 置为 `removed`，从列表移除。

### 成员组管理（左侧 SubMenu）
- 鼠标悬浮某成员组子菜单项时，显示 ✏ 和 🗑 图标
- ✏ 编辑：Input 小弹窗修改组名，调用 `updateGroup(groupId, name)`
- 🗑 删除：Popconfirm 确认后调用 `deleteGroup(groupId)`（DB 外键 ON DELETE SET NULL，组内成员 group_id 自动置 null）
- SubMenu 标题旁 `+` 图标：Input 小弹窗输入组名，调用 `createGroup(teamId, name)`

---

## 4. 新增/修改文件清单

### 新增
- `web/src/components/TeamInfoModal.tsx` — 主 Modal，含左侧菜单、InvitePanel、MemberPanel
- `web/src/components/TeamInfoModal.test.tsx` — 单元测试

### 修改
- `web/src/layout/MainLayout.tsx` — 启用"团队信息"菜单项，添加 TeamInfoModal
- `web/src/services/teamService.ts` — 新增函数：
  - `inviteMembers(teamId, rows[])` — 批量写 team_invitations
  - `fetchTeamMembers(teamId)` — 拉取成员列表（join profiles）
  - `updateMember(memberId, data)` — 更新成员
  - `removeMember(memberId)` — 软删除成员
  - `fetchTeamGroups(teamId)` — 拉取成员组
  - `createGroup(teamId, name)` — 新建成员组
  - `updateGroup(groupId, name)` — 更新成员组名
  - `deleteGroup(groupId)` — 删除成员组

---

## 5. 测试覆盖要求

### 子任务 4 验证
- 邮箱必填校验：空邮箱不能提交
- 多行邀请写入正确（mock teamService.inviteMembers）
- 非 admin 无法看到邀请入口

### 子任务 5 验证
- 成员列表正确展示
- admin 可编辑/删除，非 admin 操作列禁用
- 成员组增删改正常（左侧菜单联动）

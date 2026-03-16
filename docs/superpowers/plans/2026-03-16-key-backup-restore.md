# 密钥备份与恢复（平台托管）实施计划

> **For agentic workers:** REQUIRED: Use superpowers:subagent-driven-development (if subagents available) or superpowers:executing-plans to implement this plan. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 实现用户 RSA 私钥的平台托管备份与跨设备恢复，确保用户在新设备登录时能自动恢复密钥并访问加密文档。

**Architecture:** 后端 Edge Function 使用 Master Key（AES-256-GCM）加密用户私钥 JWK 后存入 `user_key_backups` 表；前端在 `ensureUserKeyPair` 中集成备份/恢复逻辑，本地无密钥时优先从备份恢复，恢复失败才生成新密钥对。同时修复现有 `profiles` 表名和字段引用错误。

**Tech Stack:** Supabase Edge Functions (Deno)、Web Crypto API、Supabase Postgres RLS、TypeScript/Vitest

---

## 文件结构

**新建：**
- `supabase/functions/_shared/masterKeyUtils.ts` — Master Key 加解密工具
- `supabase/functions/key-backup/index.ts` — 备份 Edge Function
- `supabase/functions/key-restore/index.ts` — 恢复 Edge Function

**修改：**
- `web/src/services/cryptoKeyService.ts` — 修复 profiles 表引用 + 新增备份/恢复函数 + 修改 ensureUserKeyPair
- `web/src/services/cryptoKeyService.test.ts` — 新增备份/恢复相关测试

**数据库迁移（通过 Supabase MCP）：**
- 新建 `user_key_backups` 表 + RLS
- 新建 `audit_logs` 表 + RLS（兼容 r2-sign-upload 现有字段）
- 修复 `profiles.public_key` 类型（text → jsonb）

---

## Chunk 1: 数据库迁移

### Task 1: 创建 audit_logs 表

**Files:**
- DB migration via Supabase MCP

- [ ] **Step 1: 执行迁移 — 创建 audit_logs 表**

```sql
CREATE TABLE IF NOT EXISTS audit_logs (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id UUID REFERENCES auth.users(id) ON DELETE SET NULL,
  action TEXT NOT NULL,
  document_id UUID REFERENCES documents(id) ON DELETE SET NULL,
  version_id UUID,
  r2_key TEXT,
  size_bytes BIGINT,
  ip TEXT,
  metadata JSONB,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX idx_audit_logs_user_id ON audit_logs(user_id);
CREATE INDEX idx_audit_logs_action ON audit_logs(action);
CREATE INDEX idx_audit_logs_created_at ON audit_logs(created_at DESC);

ALTER TABLE audit_logs ENABLE ROW LEVEL SECURITY;

CREATE POLICY "Users can view own audit logs"
  ON audit_logs FOR SELECT
  USING (auth.uid() = user_id);

-- Edge Functions 通过 service_role 写入，无需 INSERT 策略
-- r2-sign-upload 使用 anon key 写入，需要此策略
CREATE POLICY "Authenticated can insert audit logs"
  ON audit_logs FOR INSERT
  WITH CHECK (auth.uid() = user_id);
```

- [ ] **Step 2: 验证表已创建**

通过 Supabase MCP 查询确认表存在且字段正确。

---

### Task 2: 创建 user_key_backups 表

**Files:**
- DB migration via Supabase MCP

- [ ] **Step 1: 执行迁移 — 创建 user_key_backups 表**

```sql
CREATE TABLE IF NOT EXISTS user_key_backups (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id UUID NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE,
  encrypted_private_key TEXT NOT NULL,
  key_version INT NOT NULL DEFAULT 1,
  encryption_algorithm TEXT NOT NULL DEFAULT 'AES-256-GCM',
  nonce TEXT NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  UNIQUE(user_id, key_version)
);

CREATE INDEX idx_user_key_backups_user_id ON user_key_backups(user_id);

ALTER TABLE user_key_backups ENABLE ROW LEVEL SECURITY;

CREATE POLICY "Users can view own key backups"
  ON user_key_backups FOR SELECT
  USING (auth.uid() = user_id);

CREATE POLICY "No direct insert on key backups"
  ON user_key_backups FOR INSERT
  WITH CHECK (false);

CREATE POLICY "No direct update on key backups"
  ON user_key_backups FOR UPDATE
  USING (false);
```

- [ ] **Step 2: 验证表已创建**

通过 Supabase MCP 查询确认表存在、RLS 已启用、策略正确。

---

### Task 3: 修复 profiles.public_key 字段类型

**Files:**
- DB migration via Supabase MCP

- [ ] **Step 1: 执行迁移 — 修改字段类型**

```sql
ALTER TABLE profiles
  ALTER COLUMN public_key TYPE JSONB USING public_key::jsonb;
```

- [ ] **Step 2: 验证字段类型**

```sql
SELECT column_name, data_type FROM information_schema.columns
WHERE table_name = 'profiles' AND column_name = 'public_key';
```

期望结果：`data_type = 'jsonb'`

---

## Chunk 2: Edge Functions

### Task 4: 创建 _shared/masterKeyUtils.ts

**Files:**
- Create: `supabase/functions/_shared/masterKeyUtils.ts`

- [ ] **Step 1: 创建 masterKeyUtils.ts**

```typescript
// supabase/functions/_shared/masterKeyUtils.ts
declare const Deno: any;

const MASTER_KEY_ENV = "MASTER_KEY_BASE64";

const base64ToBytes = (value: string): Uint8Array => {
  const binary = atob(value);
  const result = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i++) {
    result[i] = binary.charCodeAt(i);
  }
  return result;
};

const bytesToBase64 = (bytes: Uint8Array): string => {
  let binary = "";
  for (let i = 0; i < bytes.length; i++) {
    binary += String.fromCharCode(bytes[i]);
  }
  return btoa(binary);
};

export const getMasterKey = async (): Promise<CryptoKey> => {
  const base64Key = Deno.env.get(MASTER_KEY_ENV);
  if (!base64Key) {
    throw new Error("Master key not configured");
  }
  const keyData = base64ToBytes(base64Key);
  return await crypto.subtle.importKey(
    "raw",
    keyData,
    { name: "AES-GCM" },
    false,
    ["encrypt", "decrypt"]
  );
};

export const encryptWithMasterKey = async (
  plaintext: string
): Promise<{ ciphertext: string; nonce: string }> => {
  const masterKey = await getMasterKey();
  const nonce = crypto.getRandomValues(new Uint8Array(12));
  const encoder = new TextEncoder();
  const data = encoder.encode(plaintext);

  const encrypted = await crypto.subtle.encrypt(
    { name: "AES-GCM", iv: nonce },
    masterKey,
    data
  );

  return {
    ciphertext: bytesToBase64(new Uint8Array(encrypted)),
    nonce: bytesToBase64(nonce),
  };
};

export const decryptWithMasterKey = async (
  ciphertext: string,
  nonce: string
): Promise<string> => {
  const masterKey = await getMasterKey();
  const cipherBytes = base64ToBytes(ciphertext);
  const nonceBytes = base64ToBytes(nonce);

  const decrypted = await crypto.subtle.decrypt(
    { name: "AES-GCM", iv: nonceBytes },
    masterKey,
    cipherBytes
  );

  const decoder = new TextDecoder();
  return decoder.decode(decrypted);
};
```

---

### Task 5: 创建 key-backup Edge Function

**Files:**
- Create: `supabase/functions/key-backup/index.ts`

- [ ] **Step 1: 创建 key-backup/index.ts**

```typescript
import "jsr:@supabase/functions-js/edge-runtime.d.ts";
// @ts-ignore Deno edge runtime import
import { createClient } from "jsr:@supabase/supabase-js@2";
import { encryptWithMasterKey } from "../_shared/masterKeyUtils.ts";

declare const Deno: any;

type KeyBackupRequest = {
  privateKeyJwk: JsonWebKey;
  keyVersion: number;
};

Deno.serve(async (req: Request) => {
  if (req.method !== "POST") {
    return new Response("Method Not Allowed", { status: 405 });
  }

  const authHeader = req.headers.get("Authorization") ?? "";
  if (!authHeader.startsWith("Bearer ")) {
    return new Response("Unauthorized", { status: 401 });
  }

  const supabaseUrl = Deno.env.get("SUPABASE_URL");
  const supabaseServiceKey = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY");
  const supabaseAnonKey = Deno.env.get("SUPABASE_ANON_KEY");

  if (!supabaseUrl || !supabaseAnonKey || !supabaseServiceKey) {
    return new Response("Supabase config missing", { status: 500 });
  }

  // 用 anon key + JWT 验证用户身份
  const userClient = createClient(supabaseUrl, supabaseAnonKey, {
    global: { headers: { Authorization: authHeader } },
  });

  const { data: userData, error: userError } = await userClient.auth.getUser();
  if (userError || !userData?.user) {
    return new Response("Unauthorized", { status: 401 });
  }
  const userId = userData.user.id;

  let body: KeyBackupRequest;
  try {
    body = await req.json();
  } catch {
    return new Response("Invalid JSON", { status: 400 });
  }

  if (!body.privateKeyJwk || typeof body.keyVersion !== "number") {
    return new Response("Missing fields", { status: 400 });
  }

  let ciphertext: string;
  let nonce: string;
  try {
    const result = await encryptWithMasterKey(JSON.stringify(body.privateKeyJwk));
    ciphertext = result.ciphertext;
    nonce = result.nonce;
  } catch {
    return new Response("Encryption failed", { status: 500 });
  }

  // 用 service role 写入（绕过 RLS 的 no-insert 策略）
  const adminClient = createClient(supabaseUrl, supabaseServiceKey);

  const now = new Date().toISOString();
  const { error: upsertError } = await adminClient
    .from("user_key_backups")
    .upsert(
      {
        user_id: userId,
        encrypted_private_key: ciphertext,
        key_version: body.keyVersion,
        encryption_algorithm: "AES-256-GCM",
        nonce,
        updated_at: now,
      },
      { onConflict: "user_id,key_version" }
    );

  if (upsertError) {
    return new Response("Failed to save backup", { status: 500 });
  }

  // 写审计日志
  try {
    const ip =
      req.headers.get("x-forwarded-for") ??
      req.headers.get("cf-connecting-ip") ??
      null;
    await adminClient.from("audit_logs").insert({
      user_id: userId,
      action: "key_backup_created",
      metadata: { key_version: body.keyVersion },
      ip,
    });
  } catch {
    // 审计失败不影响主流程
  }

  return new Response(
    JSON.stringify({ success: true, keyVersion: body.keyVersion, backedUpAt: now }),
    { status: 200, headers: { "Content-Type": "application/json" } }
  );
});
```

- [ ] **Step 2: 部署 key-backup**

通过 Supabase MCP deploy_edge_function 部署，`verify_jwt: true`。

---

### Task 6: 创建 key-restore Edge Function

**Files:**
- Create: `supabase/functions/key-restore/index.ts`

- [ ] **Step 1: 创建 key-restore/index.ts**

```typescript
import "jsr:@supabase/functions-js/edge-runtime.d.ts";
// @ts-ignore Deno edge runtime import
import { createClient } from "jsr:@supabase/supabase-js@2";
import { decryptWithMasterKey } from "../_shared/masterKeyUtils.ts";

declare const Deno: any;

type KeyRestoreRequest = {
  keyVersion?: number;
};

Deno.serve(async (req: Request) => {
  if (req.method !== "POST") {
    return new Response("Method Not Allowed", { status: 405 });
  }

  const authHeader = req.headers.get("Authorization") ?? "";
  if (!authHeader.startsWith("Bearer ")) {
    return new Response("Unauthorized", { status: 401 });
  }

  const supabaseUrl = Deno.env.get("SUPABASE_URL");
  const supabaseServiceKey = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY");
  const supabaseAnonKey = Deno.env.get("SUPABASE_ANON_KEY");

  if (!supabaseUrl || !supabaseAnonKey || !supabaseServiceKey) {
    return new Response("Supabase config missing", { status: 500 });
  }

  const userClient = createClient(supabaseUrl, supabaseAnonKey, {
    global: { headers: { Authorization: authHeader } },
  });

  const { data: userData, error: userError } = await userClient.auth.getUser();
  if (userError || !userData?.user) {
    return new Response("Unauthorized", { status: 401 });
  }
  const userId = userData.user.id;

  let body: KeyRestoreRequest = {};
  try {
    body = await req.json();
  } catch {
    // body 可为空
  }

  const adminClient = createClient(supabaseUrl, supabaseServiceKey);

  const baseQuery = adminClient
    .from("user_key_backups")
    .select("encrypted_private_key, nonce, key_version, created_at")
    .eq("user_id", userId);

  const { data: backupData, error: fetchError } = await (
    typeof body.keyVersion === "number"
      ? baseQuery.eq("key_version", body.keyVersion).limit(1).single()
      : baseQuery.order("key_version", { ascending: false }).limit(1).single()
  );

  const ip =
    req.headers.get("x-forwarded-for") ??
    req.headers.get("cf-connecting-ip") ??
    null;

  if (fetchError || !backupData) {
    try {
      await adminClient.from("audit_logs").insert({
        user_id: userId,
        action: "key_restore_failed",
        metadata: { reason: "backup_not_found" },
        ip,
      });
    } catch { /* ignore */ }
    return new Response("Backup not found", { status: 404 });
  }

  let privateKeyJwk: JsonWebKey;
  try {
    const plaintext = await decryptWithMasterKey(
      backupData.encrypted_private_key,
      backupData.nonce
    );
    privateKeyJwk = JSON.parse(plaintext);
  } catch {
    try {
      await adminClient.from("audit_logs").insert({
        user_id: userId,
        action: "key_restore_failed",
        metadata: { reason: "decryption_failed" },
        ip,
      });
    } catch { /* ignore */ }
    return new Response("Decryption failed", { status: 500 });
  }

  try {
    await adminClient.from("audit_logs").insert({
      user_id: userId,
      action: "key_restore_success",
      metadata: { key_version: backupData.key_version },
      ip,
    });
  } catch { /* ignore */ }

  return new Response(
    JSON.stringify({
      privateKeyJwk,
      keyVersion: backupData.key_version,
      backedUpAt: backupData.created_at,
    }),
    { status: 200, headers: { "Content-Type": "application/json" } }
  );
});
```

- [ ] **Step 2: 部署 key-restore**

通过 Supabase MCP deploy_edge_function 部署，`verify_jwt: true`。

---

## Chunk 3: 前端修改

### Task 7: 修复 profiles 表引用 + 新增备份/恢复函数

**Files:**
- Modify: `web/src/services/cryptoKeyService.ts`
- Modify: `web/src/services/cryptoKeyService.test.ts`

- [ ] **Step 1: 先写测试**

在 `cryptoKeyService.test.ts` 顶部添加 mock（必须在顶层），末尾新增测试用例：

```typescript
// 文件顶部（现有 import 之后）添加：
import { vi, beforeEach } from 'vitest';

vi.mock('../lib/supabase', () => ({
  supabase: {
    functions: {
      invoke: vi.fn(),
    },
    auth: { getSession: vi.fn() },
  },
}));

// 文件末尾新增：
import { supabase } from '../lib/supabase';

describe('backupUserPrivateKey', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('调用失败时静默返回不抛出异常', async () => {
    vi.mocked(supabase.functions.invoke).mockResolvedValue({
      data: null,
      error: new Error('network error'),
    } as any);

    const { backupUserPrivateKey } = await import('./cryptoKeyService');
    const fakeUser = { id: 'user-123' } as any;
    const fakeKey = {} as CryptoKey;

    await expect(backupUserPrivateKey(fakeUser, fakeKey)).resolves.toBeUndefined();
  });
});

describe('restoreUserPrivateKey', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('备份不存在时返回 null', async () => {
    vi.mocked(supabase.functions.invoke).mockResolvedValue({
      data: null,
      error: { status: 404, message: 'Backup not found' },
    } as any);

    const { restoreUserPrivateKey } = await import('./cryptoKeyService');
    const fakeUser = { id: 'user-123' } as any;

    const result = await restoreUserPrivateKey(fakeUser);
    expect(result).toBeNull();
  });

  it('网络错误时返回 null', async () => {
    vi.mocked(supabase.functions.invoke).mockRejectedValue(new Error('network error'));

    const { restoreUserPrivateKey } = await import('./cryptoKeyService');
    const fakeUser = { id: 'user-123' } as any;

    const result = await restoreUserPrivateKey(fakeUser);
    expect(result).toBeNull();
  });
});
```

- [ ] **Step 2: 运行测试确认失败**

```bash
cd web && npx vitest run src/services/cryptoKeyService.test.ts
```

期望：新增测试 FAIL（函数不存在）

- [ ] **Step 3: 修改 cryptoKeyService.ts — 修复 upsertUserPublicKey**

将现有 `upsertUserPublicKey` 函数替换为：

```typescript
const upsertUserPublicKey = async (user: User, publicJwk: JsonWebKey): Promise<void> => {
  const { error } = await supabase.from('profiles').upsert(
    { id: user.id, public_key: publicJwk },
    { onConflict: 'id' }
  );
  if (error) {
    throw error;
  }
};
```

- [ ] **Step 4: 修改 cryptoKeyService.ts — 新增 backupUserPrivateKey**

在 `ensureUserKeyPair` 之前新增：

```typescript
export const backupUserPrivateKey = async (user: User, privateKey: CryptoKey): Promise<void> => {
  if (!isWebCryptoAvailable()) return;
  try {
    const privateKeyJwk = await crypto.subtle.exportKey('jwk', privateKey);
    const { error } = await supabase.functions.invoke('key-backup', {
      body: { privateKeyJwk, keyVersion: 1 },
    });
    if (error) {
      // 静默失败，不阻断主流程
    }
  } catch {
    // 静默失败
  }
};
```

- [ ] **Step 5: 修改 cryptoKeyService.ts — 新增 restoreUserPrivateKey**

在 `backupUserPrivateKey` 之后新增：

```typescript
export const restoreUserPrivateKey = async (user: User): Promise<CryptoKey | null> => {
  if (!isWebCryptoAvailable()) return null;
  try {
    const { data, error } = await supabase.functions.invoke('key-restore', { body: {} });
    if (error || !data?.privateKeyJwk) return null;

    const jwk = data.privateKeyJwk as JsonWebKey;
    if (!jwk.kty || !jwk.alg) return null;

    const privateKey = await crypto.subtle.importKey(
      'jwk',
      jwk,
      { name: 'RSA-OAEP', hash: 'SHA-256' },
      false,
      ['decrypt'],
    );

    // 从私钥 JWK 派生公钥（去掉私钥专属字段）
    const publicJwk: JsonWebKey = { ...jwk };
    delete publicJwk.d;
    delete publicJwk.dp;
    delete publicJwk.dq;
    delete publicJwk.p;
    delete publicJwk.q;
    delete publicJwk.qi;

    const publicKey = await crypto.subtle.importKey(
      'jwk',
      publicJwk,
      { name: 'RSA-OAEP', hash: 'SHA-256' },
      true,
      ['encrypt'],
    );

    await saveKeyPair(user.id, { publicKey, privateKey } as CryptoKeyPair);
    return privateKey;
  } catch {
    return null;
  }
};
```

- [ ] **Step 6: 修改 cryptoKeyService.ts — 更新 ensureUserKeyPair**

将现有 `ensureUserKeyPair` 替换为：

```typescript
export const ensureUserKeyPair = async (user: User): Promise<void> => {
  if (!isWebCryptoAvailable()) return;

  try {
    let stored = await getStoredKeyPair(user.id);

    if (!stored) {
      // 优先从备份恢复
      await restoreUserPrivateKey(user);
      stored = await getStoredKeyPair(user.id);
    }

    if (!stored) {
      // 恢复失败，生成新密钥对
      const keyPair = (await crypto.subtle.generateKey(
        {
          name: 'RSA-OAEP',
          modulusLength: 2048,
          publicExponent: new Uint8Array([1, 0, 1]),
          hash: 'SHA-256',
        },
        true,
        ['encrypt', 'decrypt'],
      )) as CryptoKeyPair;

      await saveKeyPair(user.id, keyPair);
      stored = { publicKey: keyPair.publicKey, privateKey: keyPair.privateKey };

      // 自动备份新生成的私钥
      await backupUserPrivateKey(user, keyPair.privateKey);
    }

    const publicJwk = await crypto.subtle.exportKey('jwk', stored.publicKey);
    await upsertUserPublicKey(user, publicJwk);
  } catch {
    // 静默失败
  }
};
```

- [ ] **Step 7: 运行测试确认通过**

```bash
cd web && npx vitest run src/services/cryptoKeyService.test.ts
```

期望：所有测试 PASS

- [ ] **Step 8: 运行全量测试确认无回归**

```bash
cd web && npx vitest run
```

期望：所有测试 PASS

- [ ] **Step 9: Commit**

```bash
git add web/src/services/cryptoKeyService.ts web/src/services/cryptoKeyService.test.ts
git commit -m "feat: 新增密钥备份/恢复函数并修复 profiles 表引用"
```

---

### Task 8: 更新开发计划文档

**Files:**
- Modify: `开发计划.md` — 将子任务 5 标记为 [x]

- [ ] **Step 1: 更新开发计划**

将 `开发计划.md` 中子任务 5 的 `- [ ]` 改为 `- [x]`。

- [ ] **Step 2: Commit**

```bash
git add 开发计划.md docs/superpowers/plans/2026-03-16-key-backup-restore.md
git commit -m "docs: 更新子任务5完成状态并添加实施计划文档"
```

---

## 验收标准

1. `user_key_backups` 和 `audit_logs` 表已创建，RLS 策略正确
2. `profiles.public_key` 字段类型为 `jsonb`
3. `key-backup` 和 `key-restore` Edge Functions 已部署并处于 ACTIVE 状态
4. 新用户注册后 `user_key_backups` 表有对应记录
5. 清除浏览器 IndexedDB 后重新登录，密钥自动从备份恢复
6. 所有前端测试通过

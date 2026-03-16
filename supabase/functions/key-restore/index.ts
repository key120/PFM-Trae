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

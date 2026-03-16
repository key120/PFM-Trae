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

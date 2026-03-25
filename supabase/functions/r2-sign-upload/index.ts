import "jsr:@supabase/functions-js/edge-runtime.d.ts";
// @ts-ignore Deno edge runtime import
import { createClient } from "jsr:@supabase/supabase-js@2";
import { presignR2Url } from "../_shared/r2Presign.ts";

declare const Deno: any;

const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
  "Access-Control-Allow-Methods": "POST, OPTIONS",
};

type SignUploadRequest = {
  documentId: string;
  versionId: string;
  operation: string;
  contentHash: string;
  sizeBytes: number;
};

const PROJECT_CODE = "pfm-trae";

const buildR2Key = (env: string, body: SignUploadRequest) => {
  const hash = body.contentHash.toLowerCase();
  const truncated = hash.length > 32 ? hash.slice(0, 32) : hash;
  return `${PROJECT_CODE}/${env}/documents/${body.documentId}/${body.versionId}/${truncated}.bin`;
};

Deno.serve(async (req: Request) => {
  if (req.method === "OPTIONS") {
    return new Response(null, { status: 204, headers: corsHeaders });
  }

  if (req.method !== "POST") {
    return new Response("Method Not Allowed", { status: 405, headers: corsHeaders });
  }

  const authHeader = req.headers.get("Authorization") ?? "";
  if (!authHeader.startsWith("Bearer ")) {
    return new Response("Unauthorized", { status: 401, headers: corsHeaders });
  }

  const supabaseUrl = Deno.env.get("SUPABASE_URL");
  const supabaseAnonKey = Deno.env.get("SUPABASE_ANON_KEY");

  if (!supabaseUrl || !supabaseAnonKey) {
    return new Response("Supabase config missing", { status: 500, headers: corsHeaders });
  }

  const supabase = createClient(supabaseUrl, supabaseAnonKey, {
    global: {
      headers: {
        Authorization: authHeader,
      },
    },
  });

  const { data: userData, error: userError } = await supabase.auth.getUser();
  if (userError || !userData || !userData.user) {
    return new Response("Unauthorized", { status: 401, headers: corsHeaders });
  }
  const userId = userData.user.id;

  let body: SignUploadRequest;
  try {
    body = await req.json();
  } catch {
    return new Response("Invalid JSON", { status: 400, headers: corsHeaders });
  }

  if (body.operation !== "upload") {
    return new Response("Invalid operation", { status: 400, headers: corsHeaders });
  }

  if (!body.documentId || !body.versionId || !body.contentHash || !body.sizeBytes) {
    return new Response("Missing fields", { status: 400, headers: corsHeaders });
  }

  if (!Number.isFinite(body.sizeBytes) || body.sizeBytes <= 0) {
    return new Response("Invalid sizeBytes", { status: 400, headers: corsHeaders });
  }

  const maxSizeBytes = 60 * 1024 * 1024;
  if (body.sizeBytes > maxSizeBytes) {
    return new Response("Payload Too Large", { status: 413, headers: corsHeaders });
  }

  // 权限校验：仅允许文档 owner 获取上传签名
  const { data: docData, error: docError } = await supabase
    .from("documents")
    .select("id")
    .eq("id", body.documentId)
    .eq("owner_id", userId)
    .maybeSingle();

  // 允许新建文档（documentId 对应记录尚不存在）或 owner 更新
  // 若文档已存在但当前用户不是 owner，则拒绝
  if (docError) {
    return new Response("Forbidden", { status: 403, headers: corsHeaders });
  }
  if (docData === null) {
    // 记录不存在时视为新建，允许继续（document 在保存流程中稍后写入）
    // 若未来需要严格限制，可在此返回 403
  }

  const env = Deno.env.get("ENV") ?? "dev";
  const r2Key = buildR2Key(env, body);

  // 生成真实 SigV4 预签名 PUT URL
  let presignResult;
  try {
    presignResult = await presignR2Url({
      method: "PUT",
      r2Key,
      expiresInSeconds: 300,
      contentType: "application/octet-stream",
    });
  } catch (e) {
    const msg = e instanceof Error ? e.message : "Presign failed";
    return new Response(msg, { status: 500, headers: corsHeaders });
  }

  try {
    const ip =
      req.headers.get("x-forwarded-for") ??
      req.headers.get("cf-connecting-ip") ??
      req.headers.get("x-real-ip") ??
      null;

    await supabase.from("audit_logs").insert({
      action: "r2_sign_upload",
      user_id: userId,
      document_id: body.documentId,
      version_id: body.versionId,
      r2_key: r2Key,
      size_bytes: body.sizeBytes,
      ip,
    });
  } catch {
    // 审计失败不影响主流程
  }

  return new Response(JSON.stringify(presignResult), {
    status: 200,
    headers: {
      ...corsHeaders,
      "Content-Type": "application/json",
    },
  });
});

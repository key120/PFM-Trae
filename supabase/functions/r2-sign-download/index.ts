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

type SignDownloadRequest = {
  documentId?: string;
  versionId?: string;
  r2Key?: string;
};

const PROJECT_CODE = "pfm-trae";

const buildR2KeyPrefix = (env: string, documentId: string, versionId: string) => {
  return `${PROJECT_CODE}/${env}/documents/${documentId}/${versionId}/`;
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

  let body: SignDownloadRequest;
  try {
    body = await req.json();
  } catch {
    return new Response("Invalid JSON", { status: 400, headers: corsHeaders });
  }

  if (!body.documentId || !body.versionId) {
    return new Response("Missing documentId or versionId", { status: 400, headers: corsHeaders });
  }

  const { data: docData, error: docError } = await supabase
    .from("documents")
    .select("id, owner_id")
    .eq("id", body.documentId)
    .maybeSingle();

  if (docError) {
    return new Response("Forbidden", { status: 403, headers: corsHeaders });
  }
  if (!docData) {
    return new Response("Not Found", { status: 404, headers: corsHeaders });
  }

  const isOwner = (docData as { owner_id: string }).owner_id === userId;

  // 非所有者：检查是否有 document_keys（共享文档的访问凭证）
  if (!isOwner) {
    const { data: keyData, error: keyError } = await supabase
      .from("document_keys")
      .select("document_id")
      .eq("document_id", body.documentId)
      .eq("user_id", userId)
      .limit(1);

    if (keyError || !keyData || keyData.length === 0) {
      return new Response("Forbidden", { status: 403, headers: corsHeaders });
    }
  }

  // 从 document_versions 获取 r2_key（RLS 已限制仅 owner 可见）
  const { data, error } = await supabase
    .from("document_versions")
    .select("r2_key, document_id")
    .eq("id", body.versionId)
    .eq("document_id", body.documentId)
    .single();

  if (error) {
    return new Response("Forbidden", { status: 403, headers: corsHeaders });
  }

  if (!data || !data.r2_key) {
    return new Response("Not Found", { status: 404, headers: corsHeaders });
  }

  const env = Deno.env.get("ENV") ?? "dev";
  const r2Key = String((data as { r2_key: string }).r2_key);

  const expectedPrefix = buildR2KeyPrefix(env, body.documentId, body.versionId);
  if (!r2Key.startsWith(expectedPrefix)) {
    return new Response("Invalid r2Key", { status: 500, headers: corsHeaders });
  }

  // 生成真实 SigV4 预签名 GET URL
  let presignResult;
  try {
    presignResult = await presignR2Url({
      method: "GET",
      r2Key,
      expiresInSeconds: 300,
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
      action: "r2_sign_download",
      user_id: userId,
      document_id: body.documentId,
      version_id: body.versionId,
      r2_key: r2Key,
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

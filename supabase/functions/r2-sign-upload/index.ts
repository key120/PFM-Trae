import "jsr:@supabase/functions-js/edge-runtime.d.ts";
// @ts-ignore Deno edge runtime import
import { createClient } from "jsr:@supabase/supabase-js@2";

declare const Deno: any;

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
  if (req.method !== "POST") {
    return new Response("Method Not Allowed", { status: 405 });
  }

  const authHeader = req.headers.get("Authorization") ?? "";
  if (!authHeader.startsWith("Bearer ")) {
    return new Response("Unauthorized", { status: 401 });
  }

  const supabaseUrl = Deno.env.get("SUPABASE_URL");
  const supabaseAnonKey = Deno.env.get("SUPABASE_ANON_KEY");

  if (!supabaseUrl || !supabaseAnonKey) {
    return new Response("Supabase config missing", { status: 500 });
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
    return new Response("Unauthorized", { status: 401 });
  }
  const userId = userData.user.id;

  let body: SignUploadRequest;
  try {
    body = await req.json();
  } catch {
    return new Response("Invalid JSON", { status: 400 });
  }

  if (body.operation !== "upload") {
    return new Response("Invalid operation", { status: 400 });
  }

  if (!body.documentId || !body.versionId || !body.contentHash || !body.sizeBytes) {
    return new Response("Missing fields", { status: 400 });
  }

  if (!Number.isFinite(body.sizeBytes) || body.sizeBytes <= 0) {
    return new Response("Invalid sizeBytes", { status: 400 });
  }

  const maxSizeBytes = 60 * 1024 * 1024;
  if (body.sizeBytes > maxSizeBytes) {
    return new Response("Payload Too Large", { status: 413 });
  }

  const env = Deno.env.get("ENV") ?? "dev";
  const bucket = Deno.env.get("R2_BUCKET_NAME");
  const endpoint = Deno.env.get("R2_S3_ENDPOINT");

  if (!bucket || !endpoint) {
    return new Response("R2 config missing", { status: 500 });
  }

  const r2Key = buildR2Key(env, body);
  const url = `${endpoint.replace(/\/$/, "")}/${bucket}/${r2Key}`;

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

  const responsePayload = {
    url,
    method: "PUT" as const,
    headers: {
      "Content-Type": "application/octet-stream",
    },
    expiresAt: new Date(Date.now() + 5 * 60 * 1000).toISOString(),
    r2Key,
  };

  return new Response(JSON.stringify(responsePayload), {
    status: 200,
    headers: {
      "Content-Type": "application/json",
    },
  });
});

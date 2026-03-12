import "jsr:@supabase/functions-js/edge-runtime.d.ts";
// @ts-ignore Deno edge runtime import
import { createClient } from "jsr:@supabase/supabase-js@2";

declare const Deno: any;

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

  let body: SignDownloadRequest;
  try {
    body = await req.json();
  } catch {
    return new Response("Invalid JSON", { status: 400 });
  }

  if (!body.documentId || !body.versionId) {
    return new Response("Missing documentId or versionId", { status: 400 });
  }

  const env = Deno.env.get("ENV") ?? "dev";
  const bucket = Deno.env.get("R2_BUCKET_NAME");
  const endpoint = Deno.env.get("R2_S3_ENDPOINT");

  if (!bucket || !endpoint) {
    return new Response("R2 config missing", { status: 500 });
  }

  const { data, error } = await supabase
    .from("document_versions")
    .select("r2_key, document_id")
    .eq("id", body.versionId)
    .eq("document_id", body.documentId)
    .single();

  if (error) {
    return new Response("Forbidden", { status: 403 });
  }

  if (!data || !data.r2_key) {
    return new Response("Not Found", { status: 404 });
  }

  const r2Key = String((data as { r2_key: string }).r2_key);

  const expectedPrefix = buildR2KeyPrefix(env, body.documentId, body.versionId);
  if (!r2Key.startsWith(expectedPrefix)) {
    return new Response("Invalid r2Key", { status: 500 });
  }

  const url = `${endpoint.replace(/\/$/, "")}/${bucket}/${r2Key}`;

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

  const responsePayload = {
    url,
    method: "GET" as const,
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

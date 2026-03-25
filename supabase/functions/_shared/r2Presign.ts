import "jsr:@supabase/functions-js/edge-runtime.d.ts";

declare const Deno: any;

/**
 * AWS SigV4 预签名 URL 生成器（兼容 Cloudflare R2 的 S3 兼容接口）
 *
 * 生成的 URL 包含标准 X-Amz-* 查询参数，
 * 可直接用于客户端 PUT（上传）或 GET（下载），无需额外 Authorization 头。
 */

const SHA256_ALGORITHM = "SHA-256";
const HMAC_ALGORITHM = { name: "HMAC", hash: SHA256_ALGORITHM };

/** 将字符串转为 ArrayBuffer */
function str2ab(str: string): ArrayBuffer {
  return new TextEncoder().encode(str).buffer;
}

/** 将 ArrayBuffer 转为小写十六进制字符串 */
function buf2hex(buf: ArrayBuffer): string {
  return Array.from(new Uint8Array(buf))
    .map((b) => b.toString(16).padStart(2, "0"))
    .join("");
}

/** SHA-256 哈希 */
async function sha256(data: string): Promise<string> {
  const hash = await crypto.subtle.digest(SHA256_ALGORITHM, str2ab(data));
  return buf2hex(hash);
}

/** HMAC-SHA256 签名 */
async function hmacSha256(key: ArrayBuffer | string, data: string): Promise<ArrayBuffer> {
  const keyData = typeof key === "string" ? str2ab(key) : key;
  const cryptoKey = await crypto.subtle.importKey("raw", keyData, HMAC_ALGORITHM, false, ["sign"]);
  return crypto.subtle.sign("HMAC", cryptoKey, str2ab(data));
}

/** 推导 SigV4 签名密钥：HMAC(HMAC(HMAC(HMAC("AWS4" + secret, date), region), service), "aws4_request") */
async function deriveSigningKey(
  secretKey: string,
  dateStamp: string,
  region: string,
  service: string,
): Promise<ArrayBuffer> {
  const kDate = await hmacSha256("AWS4" + secretKey, dateStamp);
  const kRegion = await hmacSha256(kDate, region);
  const kService = await hmacSha256(kRegion, service);
  const kSigning = await hmacSha256(kService, "aws4_request");
  return kSigning;
}

export interface PresignOptions {
  /** HTTP 方法，仅支持 "PUT" 或 "GET" */
  method: "PUT" | "GET";
  /** R2 对象键，如 pfm-trae/dev/documents/... */
  r2Key: string;
  /** 预签名有效期（秒），默认 300 */
  expiresInSeconds?: number;
  /** PUT 时强制绑定的 Content-Type，默认 application/octet-stream */
  contentType?: string;
}

export interface PresignResult {
  url: string;
  method: "PUT" | "GET";
  /** PUT 时需要设置的请求头 */
  headers: Record<string, string>;
  expiresAt: string;
  r2Key: string;
}

/**
 * 生成 Cloudflare R2 SigV4 预签名 URL
 *
 * 依赖环境变量：
 *   R2_ACCOUNT_ID, R2_BUCKET_NAME, R2_ACCESS_KEY_ID, R2_SECRET_ACCESS_KEY, R2_S3_ENDPOINT
 */
export async function presignR2Url(opts: PresignOptions): Promise<PresignResult> {
  const accountId = Deno.env.get("R2_ACCOUNT_ID");
  const bucket = Deno.env.get("R2_BUCKET_NAME");
  const accessKeyId = Deno.env.get("R2_ACCESS_KEY_ID");
  const secretAccessKey = Deno.env.get("R2_SECRET_ACCESS_KEY");
  const s3Endpoint = Deno.env.get("R2_S3_ENDPOINT");

  if (!accountId || !bucket || !accessKeyId || !secretAccessKey || !s3Endpoint) {
    throw new Error("R2 environment variables not fully configured");
  }

  const {
    method,
    r2Key,
    expiresInSeconds = 300,
    contentType = "application/octet-stream",
  } = opts;

  // 时间戳
  const now = new Date();
  const amzDate = now.toISOString().replace(/[:\-]|\.\d{3}/g, "").slice(0, 15) + "Z";
  const dateStamp = amzDate.slice(0, 8); // YYYYMMDD

  // 地区（R2 固定使用 auto）
  const region = "auto";
  const service = "s3";

  // 规范化主机（路径风格：host 不含 bucket）
  const endpointBase = s3Endpoint.replace(/\/$/, "");
  const host = new URL(endpointBase).host;

  // 对象路径：路径风格签名必须包含 bucket 前缀 /<bucket>/<key>
  const encodedKey = r2Key
    .split("/")
    .map((seg) => encodeURIComponent(seg))
    .join("/");
  const canonicalUri = `/${bucket}/${encodedKey}`;

  // Credential scope
  const credentialScope = `${dateStamp}/${region}/${service}/aws4_request`;
  const credential = `${accessKeyId}/${credentialScope}`;

  // 要签名的查询参数（按字母序排列）
  const queryParams: Record<string, string> = {
    "X-Amz-Algorithm": "AWS4-HMAC-SHA256",
    "X-Amz-Credential": credential,
    "X-Amz-Date": amzDate,
    "X-Amz-Expires": String(expiresInSeconds),
    "X-Amz-SignedHeaders": "host",
  };

  // PUT 时额外包含 Content-Type 签名头（防止客户端更换类型）
  if (method === "PUT") {
    queryParams["X-Amz-SignedHeaders"] = "content-type;host";
  }

  // 按键名字母序拼接查询字符串
  const canonicalQueryString = Object.keys(queryParams)
    .sort()
    .map((k) => `${encodeURIComponent(k)}=${encodeURIComponent(queryParams[k])}`)
    .join("&");

  // 规范化请求头
  const signedHeadersList = method === "PUT" ? ["content-type", "host"] : ["host"];
  const canonicalHeaders =
    method === "PUT"
      ? `content-type:${contentType}\nhost:${host}\n`
      : `host:${host}\n`;
  const signedHeaders = signedHeadersList.join(";");

  // 预签名时 payload 哈希固定为 "UNSIGNED-PAYLOAD"
  const payloadHash = "UNSIGNED-PAYLOAD";

  // 规范请求
  const canonicalRequest = [
    method,
    canonicalUri,
    canonicalQueryString,
    canonicalHeaders,
    signedHeaders,
    payloadHash,
  ].join("\n");

  // 待签字符串
  const hashedCanonicalRequest = await sha256(canonicalRequest);
  const stringToSign = [
    "AWS4-HMAC-SHA256",
    amzDate,
    credentialScope,
    hashedCanonicalRequest,
  ].join("\n");

  // 签名
  const signingKey = await deriveSigningKey(secretAccessKey, dateStamp, region, service);
  const signatureRaw = await hmacSha256(signingKey, stringToSign);
  const signature = buf2hex(signatureRaw);

  // 最终 URL（路径风格：endpoint/bucket/key?...）
  const finalQuery = `${canonicalQueryString}&X-Amz-Signature=${encodeURIComponent(signature)}`;
  const url = `${endpointBase}/${bucket}/${encodedKey}?${finalQuery}`;

  const expiresAt = new Date(now.getTime() + expiresInSeconds * 1000).toISOString();

  // PUT 时需要客户端设置 Content-Type
  const headers: Record<string, string> = method === "PUT" ? { "Content-Type": contentType } : {};

  return { url, method, headers, expiresAt, r2Key };
}

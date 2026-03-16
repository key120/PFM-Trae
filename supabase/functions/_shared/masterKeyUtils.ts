import "jsr:@supabase/functions-js/edge-runtime.d.ts";

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

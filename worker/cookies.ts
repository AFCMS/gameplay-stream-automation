// Authenticated encryption keeps browser-held session data confidential and untampered.
// Purpose and origin binding prevent replaying a login cookie as a session or on another host.
const encoder = new TextEncoder();

function encode(bytes: Uint8Array): string {
  return btoa(String.fromCharCode(...bytes))
    .replaceAll("+", "-")
    .replaceAll("/", "_")
    .replace(/=+$/, "");
}

function decode(value: string): Uint8Array<ArrayBuffer> {
  return Uint8Array.from(atob(value.replaceAll("-", "+").replaceAll("_", "/")), (character) =>
    character.charCodeAt(0),
  );
}

async function encryptionKey(secret: string): Promise<CryptoKey> {
  const bytes = decode(secret);
  if (bytes.length !== 32) {
    throw new Error("COOKIE_ENCRYPTION_KEY must encode 32 random bytes.");
  }
  return crypto.subtle.importKey("raw", bytes, "AES-GCM", false, ["encrypt", "decrypt"]);
}

export function randomValue(): string {
  return encode(crypto.getRandomValues(new Uint8Array(32)));
}

export async function pkceChallenge(verifier: string): Promise<string> {
  return encode(new Uint8Array(await crypto.subtle.digest("SHA-256", encoder.encode(verifier))));
}

export async function seal(value: unknown, secret: string, purpose: string): Promise<string> {
  const iv = crypto.getRandomValues(new Uint8Array(12));
  const ciphertext = await crypto.subtle.encrypt(
    { name: "AES-GCM", iv, additionalData: encoder.encode(purpose) },
    await encryptionKey(secret),
    encoder.encode(JSON.stringify(value)),
  );
  return `v1.${encode(iv)}.${encode(new Uint8Array(ciphertext))}`;
}

export async function unseal(value: string, secret: string, purpose: string): Promise<unknown> {
  const [version, iv, ciphertext, extra] = value.split(".");
  if (version !== "v1" || !iv || !ciphertext || extra !== undefined || value.length > 3800) {
    return null;
  }
  // Configuration failures are separate from invalid browser-supplied cookies.
  const key = await encryptionKey(secret);
  try {
    const plaintext = await crypto.subtle.decrypt(
      { name: "AES-GCM", iv: decode(iv), additionalData: encoder.encode(purpose) },
      key,
      decode(ciphertext),
    );
    return JSON.parse(new TextDecoder().decode(plaintext)) as unknown;
  } catch {
    return null;
  }
}

export function cookieName(origin: string, purpose: "session" | "login"): string {
  return `${origin.startsWith("https:") ? "__Host-" : ""}gsa_${purpose}`;
}

export function readCookie(request: Request, name: string): string | null {
  const entries = (request.headers.get("Cookie") ?? "").split(";");
  const entry = entries.map((part) => part.trim()).find((part) => part.startsWith(`${name}=`));
  return entry?.slice(name.length + 1) ?? null;
}

export function cookieHeader(
  origin: string,
  purpose: "session" | "login",
  value: string,
  maxAge: number,
): string {
  const cookie = `${cookieName(origin, purpose)}=${value}; Path=/; HttpOnly; SameSite=Lax; Max-Age=${maxAge}${origin.startsWith("https:") ? "; Secure" : ""}`;
  if (value.length > 3800 || cookie.length > 4096) {
    throw new Error("Session cookie exceeds the browser size limit.");
  }
  return cookie;
}

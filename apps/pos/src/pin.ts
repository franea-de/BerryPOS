/**
 * PIN hashing shared by the server and the browser demo (WebCrypto exists in
 * both). SHA-256 of a 4-digit PIN is shift discipline, not real security —
 * good enough for who-sold-what attribution on a trusted store machine.
 */
export async function hashPin(pin: string): Promise<string> {
  const digest = await crypto.subtle.digest(
    "SHA-256",
    new TextEncoder().encode(pin),
  );
  return [...new Uint8Array(digest)]
    .map((b) => b.toString(16).padStart(2, "0"))
    .join("");
}

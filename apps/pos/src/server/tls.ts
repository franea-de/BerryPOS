import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import selfsigned from "selfsigned";

/**
 * Self-signed TLS cert for the LAN mobile page: phone cameras only work in
 * a secure context, so the register serves HTTPS alongside HTTP. The phone
 * accepts the certificate warning once (store-trusted network).
 */
export async function ensureTlsCert(
  dir: string,
): Promise<{ key: string; cert: string }> {
  const keyPath = join(dir, "tls-key.pem");
  const certPath = join(dir, "tls-cert.pem");
  if (existsSync(keyPath) && existsSync(certPath)) {
    return {
      key: readFileSync(keyPath, "utf8"),
      cert: readFileSync(certPath, "utf8"),
    };
  }
  mkdirSync(dir, { recursive: true });
  const pems = await selfsigned.generate(
    [{ name: "commonName", value: "berrypos.local" }],
    { days: 3650, keySize: 2048 },
  );
  writeFileSync(keyPath, pems.private);
  writeFileSync(certPath, pems.cert);
  return { key: pems.private, cert: pems.cert };
}

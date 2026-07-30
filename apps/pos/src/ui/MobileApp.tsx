import { useEffect, useRef, useState } from "react";
import type { ScanResult } from "../db/catalog.js";
import {
  HttpBackend,
  type BootstrapData,
  type UserSummary,
} from "./backend.js";
import { money, qty } from "./format.js";

/**
 * Mobile companion (/movil): served by the register over HTTPS on the store
 * LAN. The owner walks the aisles scanning with the phone camera — known
 * products get stock added; unknown barcodes get registered on the spot.
 */

const backend = new HttpBackend();

type Hit =
  | { kind: "found"; product: ScanFound["product"]; code: string }
  | { kind: "unknown"; code: string };
type ScanFound = Extract<ScanResult, { kind: "product" }>;

export default function MobileApp() {
  const [boot, setBoot] = useState<BootstrapData | null>(null);
  const [user, setUser] = useState<UserSummary | null>(null);
  const [pin, setPin] = useState("");
  const [selected, setSelected] = useState<UserSummary | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [hit, setHit] = useState<Hit | null>(null);
  const [message, setMessage] = useState<string | null>(null);
  const [mode, setMode] = useState<"sale" | "inventory">("sale");

  useEffect(() => {
    backend
      .bootstrap()
      .then(setBoot)
      .catch(() => setError("No se pudo conectar con la caja"));
  }, []);

  function flash(text: string) {
    setMessage(text);
    window.setTimeout(() => setMessage(null), 2500);
  }

  async function refresh() {
    setBoot(await backend.bootstrap());
  }

  async function onCode(code: string) {
    try {
      if (mode === "sale") {
        await backend.sendRemoteScan(code);
        if (navigator.vibrate) navigator.vibrate(80);
        const localProd = boot.products.find(
          (p) => p.barcodes.includes(code) || p.scaleItemCode === code,
        );
        flash(`Enviado a caja: ${localProd ? localProd.name : code}`);
        return;
      }

      const result = await backend.scan(code);
      if (result.kind === "not_found") {
        setHit({ kind: "unknown", code });
      } else {
        setHit({ kind: "found", product: result.product, code });
      }
      if (navigator.vibrate) navigator.vibrate(80);
    } catch (e) {
      flash(e instanceof Error ? e.message : "Error al buscar");
    }
  }

  if (!boot) {
    return <div className="m-center">{error ?? "Conectando con la caja…"}</div>;
  }

  if (!user) {
    return (
      <div className="m-login">
        <h1>🍓 BerryPOS móvil</h1>
        <p className="m-muted">¿Quién eres?</p>
        <div className="m-users">
          {boot.users.map((u) => (
            <button
              key={u.id}
              className={selected?.id === u.id ? "active" : ""}
              onClick={() => setSelected(u)}
            >
              {u.name}
            </button>
          ))}
        </div>
        {selected && (
          <div className="m-pin">
            <input
              autoFocus
              type="password"
              inputMode="numeric"
              placeholder="PIN"
              value={pin}
              onChange={(e) => setPin(e.target.value)}
            />
            <button
              onClick={async () => {
                try {
                  setUser(await backend.login(selected.id, pin));
                  setError(null);
                } catch (e) {
                  setError(e instanceof Error ? e.message : "Error");
                  setPin("");
                }
              }}
            >
              Entrar
            </button>
          </div>
        )}
        {error && <p className="m-error">{error}</p>}
      </div>
    );
  }

  return (
    <div className="m-app">
      <header className="m-header">
        <span>🍓 {user.name}</span>
        <button onClick={() => setUser(null)}>Salir</button>
      </header>

      <div className="m-modes">
        <button
          className={mode === "sale" ? "active" : ""}
          onClick={() => {
            setMode("sale");
            setHit(null);
          }}
        >
          🛒 Modo Venta
        </button>
        <button
          className={mode === "inventory" ? "active" : ""}
          onClick={() => {
            setMode("inventory");
            setHit(null);
          }}
        >
          📦 Modo Inventario
        </button>
      </div>

      <Scanner onCode={onCode} paused={hit !== null} />

      <ManualEntry onCode={onCode} />

      {message && <div className="m-flash">{message}</div>}

      {hit?.kind === "found" && (
        <FoundCard
          product={hit.product}
          stock={
            boot.products.find((p) => p.id === hit.product.id)?.stockMilli ?? 0
          }
          onClose={() => setHit(null)}
          onReceived={async (qtyMilli) => {
            const r = await backend.receiveStock({
              movementId: crypto.randomUUID(),
              productId: hit.product.id,
              qtyMilli,
            });
            await refresh();
            setHit(null);
            flash(
              `${hit.product.name}: stock ahora ${qty(r.stockMilli, hit.product.isWeighable)}`,
            );
          }}
        />
      )}

      {hit?.kind === "unknown" && (
        <RegisterCard
          code={hit.code}
          onClose={() => setHit(null)}
          onSaved={async (name) => {
            await refresh();
            setHit(null);
            flash(`Registrado: ${name}`);
          }}
        />
      )}
    </div>
  );
}

/** Continuous camera scanning via the native BarcodeDetector (Android). */
function Scanner({
  onCode,
  paused,
}: {
  onCode: (code: string) => void;
  paused: boolean;
}) {
  const videoRef = useRef<HTMLVideoElement>(null);
  const [status, setStatus] = useState<"starting" | "ok" | "unsupported" | "denied">(
    "starting",
  );
  const lastRef = useRef<{ code: string; at: number }>({ code: "", at: 0 });
  const pausedRef = useRef(paused);
  pausedRef.current = paused;

  useEffect(() => {
    let stream: MediaStream | null = null;
    let timer: number | undefined;
    let cancelled = false;

    (async () => {
      if (typeof BarcodeDetector === "undefined") {
        setStatus("unsupported");
        return;
      }
      try {
        stream = await navigator.mediaDevices.getUserMedia({
          video: { facingMode: "environment" },
        });
      } catch {
        setStatus("denied");
        return;
      }
      if (cancelled || !videoRef.current) return;
      videoRef.current.srcObject = stream;
      await videoRef.current.play();
      setStatus("ok");

      const detector = new BarcodeDetector({
        formats: ["ean_13", "ean_8", "upc_a", "code_128", "qr_code"],
      });
      timer = window.setInterval(async () => {
        if (pausedRef.current || !videoRef.current) return;
        try {
          const codes = await detector.detect(videoRef.current);
          const raw = codes[0]?.rawValue;
          if (!raw) return;
          const now = Date.now();
          // Debounce: ignore the same code for 2.5s.
          if (raw === lastRef.current.code && now - lastRef.current.at < 2500) return;
          lastRef.current = { code: raw, at: now };
          onCode(raw);
        } catch {
          /* transient detector errors: keep scanning */
        }
      }, 250);
    })();

    return () => {
      cancelled = true;
      if (timer) clearInterval(timer);
      stream?.getTracks().forEach((t) => t.stop());
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  if (status === "unsupported") {
    return (
      <p className="m-note">
        Este navegador no tiene lector de cámara integrado (usa Chrome en
        Android). Puedes digitar el código abajo.
      </p>
    );
  }
  if (status === "denied") {
    return (
      <p className="m-note">
        Sin permiso de cámara — actívalo en el navegador o digita el código.
      </p>
    );
  }
  return (
    <div className="m-camera">
      <video ref={videoRef} muted playsInline />
      <div className="m-camera-line" />
    </div>
  );
}

function ManualEntry({ onCode }: { onCode: (code: string) => void }) {
  const [code, setCode] = useState("");
  return (
    <div className="m-manual">
      <input
        inputMode="numeric"
        placeholder="O digita el código de barras…"
        value={code}
        onChange={(e) => setCode(e.target.value)}
        onKeyDown={(e) => {
          if (e.key === "Enter" && code.trim()) {
            onCode(code.trim());
            setCode("");
          }
        }}
      />
      <button
        onClick={() => {
          if (code.trim()) {
            onCode(code.trim());
            setCode("");
          }
        }}
      >
        Buscar
      </button>
    </div>
  );
}

function FoundCard({
  product,
  stock,
  onReceived,
  onClose,
}: {
  product: ScanFound["product"];
  stock: number;
  onReceived: (qtyMilli: number) => Promise<void>;
  onClose: () => void;
}) {
  const [qtyText, setQtyText] = useState("1");
  const [error, setError] = useState<string | null>(null);

  async function receive() {
    const value = Number(qtyText.replace(",", "."));
    const qtyMilli = product.isWeighable
      ? Math.round(value * 1000)
      : Math.round(value) * 1000;
    if (!Number.isFinite(qtyMilli) || qtyMilli <= 0) {
      setError("Cantidad inválida");
      return;
    }
    try {
      await onReceived(qtyMilli);
    } catch (e) {
      setError(e instanceof Error ? e.message : "No se pudo guardar");
    }
  }

  return (
    <div className="m-card">
      <h2>{product.name}</h2>
      <p className="m-muted">
        {money(product.unitPriceCents)}
        {product.isWeighable ? " /kg" : ""} · stock:{" "}
        {qty(stock, product.isWeighable)}
      </p>
      <label>
        Cantidad que llegó {product.isWeighable ? "(kg)" : "(unidades)"}
        <input
          autoFocus
          inputMode="decimal"
          value={qtyText}
          onChange={(e) => setQtyText(e.target.value)}
          onKeyDown={(e) => e.key === "Enter" && void receive()}
        />
      </label>
      {error && <p className="m-error">{error}</p>}
      <div className="m-actions">
        <button className="ghost" onClick={onClose}>
          Cancelar
        </button>
        <button className="primary" onClick={() => void receive()}>
          ➕ Sumar stock
        </button>
      </div>
    </div>
  );
}

function RegisterCard({
  code,
  onSaved,
  onClose,
}: {
  code: string;
  onSaved: (name: string) => Promise<void>;
  onClose: () => void;
}) {
  const [name, setName] = useState("");
  const [priceText, setPriceText] = useState("");
  const [qtyText, setQtyText] = useState("1");
  const [weighable, setWeighable] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function save() {
    const priceCents = Math.round(Number(priceText.replace(",", ".")) * 100);
    const value = Number(qtyText.replace(",", "."));
    const qtyMilli = weighable
      ? Math.round(value * 1000)
      : Math.round(value) * 1000;
    if (!name.trim() || !Number.isInteger(priceCents) || priceCents <= 0) {
      setError("Completa nombre y precio");
      return;
    }
    try {
      const created = await backend.createProduct({
        name: name.trim(),
        barcode: code,
        unitPriceCents: priceCents,
        isWeighable: weighable,
      });
      if (created.kind !== "not_found" && qtyMilli > 0) {
        await backend.receiveStock({
          movementId: crypto.randomUUID(),
          productId: created.product.id,
          qtyMilli,
          note: "stock inicial (registro móvil)",
        });
      }
      await onSaved(name.trim());
    } catch (e) {
      setError(e instanceof Error ? e.message : "No se pudo registrar");
    }
  }

  return (
    <div className="m-card">
      <h2>Producto nuevo</h2>
      <p className="m-muted">Código: {code}</p>
      <label>
        Nombre
        <input
          autoFocus
          value={name}
          placeholder="Ej: Galletas surtidas 250g"
          onChange={(e) => setName(e.target.value)}
        />
      </label>
      <label>
        Precio de venta {weighable ? "(por kg)" : ""} S/
        <input
          inputMode="decimal"
          value={priceText}
          placeholder="Ej: 4.50"
          onChange={(e) => setPriceText(e.target.value)}
        />
      </label>
      <label className="m-check">
        <input
          type="checkbox"
          checked={weighable}
          onChange={(e) => setWeighable(e.target.checked)}
        />
        Se vende por peso (balanza)
      </label>
      <label>
        Cantidad disponible {weighable ? "(kg)" : "(unidades)"}
        <input
          inputMode="decimal"
          value={qtyText}
          onChange={(e) => setQtyText(e.target.value)}
        />
      </label>
      {error && <p className="m-error">{error}</p>}
      <div className="m-actions">
        <button className="ghost" onClick={onClose}>
          Cancelar
        </button>
        <button className="primary" onClick={() => void save()}>
          Guardar producto
        </button>
      </div>
    </div>
  );
}

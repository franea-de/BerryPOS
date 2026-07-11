import { useRef, useState } from "react";
import type {
  BootstrapData,
  NewProductDraft,
  PosBackend,
  ProductSummary,
} from "./backend.js";
import RegisterProduct from "./RegisterProduct.js";
import { money, qty } from "./format.js";

interface Props {
  backend: PosBackend;
  boot: BootstrapData;
  refresh: () => Promise<void>;
}

interface PendingReception {
  product: Pick<ProductSummary, "id" | "name" | "isWeighable">;
  qtyText: string;
}

interface ReceivedLine {
  key: string;
  name: string;
  qtyMilli: number;
  isWeighable: boolean;
  stockMilli: number;
}

/**
 * Merchandise reception: scan (or pick) product after product; unknown codes
 * jump into the same quick-registration form and then ask for the quantity.
 */
export default function ReceptionView({ backend, boot, refresh }: Props) {
  const [code, setCode] = useState("");
  const [message, setMessage] = useState<string | null>(null);
  const [pending, setPending] = useState<PendingReception | null>(null);
  const [registering, setRegistering] = useState<string | null>(null);
  const [received, setReceived] = useState<ReceivedLine[]>([]);
  const scanRef = useRef<HTMLInputElement>(null);
  const qtyRef = useRef<HTMLInputElement>(null);

  function flash(text: string) {
    setMessage(text);
    window.setTimeout(() => setMessage(null), 2500);
  }

  function askQuantity(
    product: PendingReception["product"],
    initialQty = "1",
  ) {
    setPending({ product, qtyText: initialQty });
    window.setTimeout(() => qtyRef.current?.select(), 0);
  }

  async function handleScan() {
    const trimmed = code.trim();
    setCode("");
    if (!trimmed) return;
    try {
      const result = await backend.scan(trimmed);
      if (result.kind === "not_found") {
        setRegistering(trimmed);
        return;
      }
      // A scale sticker pre-fills the weighed quantity.
      askQuantity(
        result.product,
        result.kind === "weighed" ? String(result.qtyMilli / 1000) : "1",
      );
    } catch (e) {
      flash(e instanceof Error ? e.message : "Error de escaneo");
    }
  }

  async function registerThenAsk(draft: NewProductDraft) {
    const result = await backend.createProduct(draft);
    setRegistering(null);
    await refresh();
    if (result.kind !== "not_found") askQuantity(result.product);
  }

  async function receive() {
    if (!pending) return;
    const value = Number(pending.qtyText.replace(",", "."));
    const qtyMilli = pending.product.isWeighable
      ? Math.round(value * 1000)
      : Math.round(value) * 1000;
    if (!Number.isFinite(qtyMilli) || qtyMilli <= 0) {
      flash("Cantidad inválida");
      return;
    }
    try {
      const r = await backend.receiveStock({
        movementId: crypto.randomUUID(),
        productId: pending.product.id,
        qtyMilli,
      });
      setReceived((list) => [
        {
          key: crypto.randomUUID(),
          name: pending.product.name,
          qtyMilli,
          isWeighable: pending.product.isWeighable,
          stockMilli: r.stockMilli,
        },
        ...list,
      ]);
      setPending(null);
      await refresh();
      scanRef.current?.focus();
    } catch (e) {
      flash(e instanceof Error ? e.message : "No se pudo recibir");
    }
  }

  return (
    <main className="pos-main">
      <section className="pos-left">
        <div className="scan-row">
          <input
            ref={scanRef}
            autoFocus
            value={code}
            placeholder="Escanea el producto que llegó…"
            onChange={(e) => setCode(e.target.value)}
            onKeyDown={(e) => e.key === "Enter" && void handleScan()}
          />
          <button onClick={() => void handleScan()}>Buscar</button>
          <button className="new-product-btn" onClick={() => setRegistering("")}>
            ➕ Nuevo producto
          </button>
        </div>

        <div className="quick-grid">
          {boot.products.map((p) => (
            <button key={p.id} className="quick-btn" onClick={() => askQuantity(p)}>
              <span className="quick-name">{p.name}</span>
              <span className="quick-price">
                {money(p.unitPriceCents)}
                {p.isWeighable ? " /kg" : ""}
              </span>
              <span className="quick-stock">
                stock: {qty(p.stockMilli, p.isWeighable)}
              </span>
            </button>
          ))}
        </div>

        {message && <div className="flash">{message}</div>}
      </section>

      <section className="pos-right">
        <div className="cart">
          {received.length === 0 && (
            <p className="cart-empty">
              Recepción de mercadería — escanea lo que llegó y confirma la
              cantidad
            </p>
          )}
          {received.map((line) => (
            <div key={line.key} className="cart-line">
              <div className="cart-line-info">
                <span className="cart-line-name">{line.name}</span>
                <span className="cart-line-detail">
                  recibido: {qty(line.qtyMilli, line.isWeighable)}
                </span>
              </div>
              <div className="cart-line-total">
                stock: {qty(line.stockMilli, line.isWeighable)}
              </div>
            </div>
          ))}
        </div>
      </section>

      {pending && (
        <div className="modal-backdrop" onClick={() => setPending(null)}>
          <div className="modal" onClick={(e) => e.stopPropagation()}>
            <h2>{pending.product.name}</h2>
            <p className="modal-hint">
              ¿Cuánto llegó? {pending.product.isWeighable ? "(en kg)" : "(unidades)"}
            </p>
            <label>
              Cantidad recibida
              <input
                ref={qtyRef}
                autoFocus
                inputMode="decimal"
                value={pending.qtyText}
                onChange={(e) =>
                  setPending({ ...pending, qtyText: e.target.value })
                }
                onKeyDown={(e) => e.key === "Enter" && void receive()}
              />
            </label>
            <div className="modal-actions">
              <button className="modal-cancel" onClick={() => setPending(null)}>
                Cancelar
              </button>
              <button className="modal-save" onClick={() => void receive()}>
                Recibir
              </button>
            </div>
          </div>
        </div>
      )}

      {registering !== null && (
        <RegisterProduct
          initialCode={registering}
          onSave={registerThenAsk}
          onCancel={() => {
            setRegistering(null);
            scanRef.current?.focus();
          }}
        />
      )}
    </main>
  );
}

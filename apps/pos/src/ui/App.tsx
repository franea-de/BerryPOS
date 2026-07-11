import { useEffect, useMemo, useRef, useState } from "react";
import { ean13CheckDigit, type PaymentInput } from "@berrypos/domain";
import {
  addScan,
  EMPTY_CART,
  quoteCart,
  removeLine,
  updateLine,
  type Cart,
} from "../cart.js";
import {
  HttpBackend,
  MemoryBackend,
  type BootstrapData,
  type CheckoutResult,
  type NewProductDraft,
  type PosBackend,
} from "./backend.js";
import RegisterProduct from "./RegisterProduct.js";

function money(cents: number): string {
  return `$${(cents / 100).toLocaleString("es-CL", {
    minimumFractionDigits: 2,
    maximumFractionDigits: 2,
  })}`;
}

function qty(qtyMilli: number, weighable: boolean): string {
  return weighable
    ? `${(qtyMilli / 1000).toLocaleString("es-CL", { maximumFractionDigits: 3 })} kg`
    : `${Math.round(qtyMilli / 1000)}`;
}

export default function App() {
  const [backend, setBackend] = useState<PosBackend | null>(null);
  const [boot, setBoot] = useState<BootstrapData | null>(null);
  const [cart, setCart] = useState<Cart>(EMPTY_CART);
  const [code, setCode] = useState("");
  const [message, setMessage] = useState<string | null>(null);
  const [paying, setPaying] = useState(false);
  const [cashText, setCashText] = useState("");
  const [receipt, setReceipt] = useState<CheckoutResult | null>(null);
  const [registering, setRegistering] = useState<string | null>(null);
  const scanRef = useRef<HTMLInputElement>(null);

  useEffect(() => {
    let cancelled = false;
    (async () => {
      // Prefer the local register server (real SQLite); fall back to demo.
      const http = new HttpBackend();
      try {
        const data = await http.bootstrap();
        if (!cancelled) {
          setBackend(http);
          setBoot(data);
        }
      } catch {
        const demo = new MemoryBackend();
        const data = await demo.bootstrap();
        if (!cancelled) {
          setBackend(demo);
          setBoot(data);
        }
      }
    })();
    return () => {
      cancelled = true;
    };
  }, []);

  const quote = useMemo(
    () =>
      boot && cart.lines.length > 0
        ? quoteCart(cart, boot.promotions, boot.taxCatalog)
        : null,
    [cart, boot],
  );

  if (!backend || !boot) {
    return <div className="pos-loading">Conectando con la caja…</div>;
  }

  function flash(text: string) {
    setMessage(text);
    window.setTimeout(() => setMessage(null), 2500);
  }

  async function handleScan() {
    const trimmed = code.trim();
    setCode("");
    scanRef.current?.focus();
    if (!trimmed || !backend) return;
    try {
      const result = await backend.scan(trimmed);
      if (result.kind === "not_found") {
        // Unknown code: offer to register the product on the spot.
        setRegistering(trimmed);
        return;
      }
      setReceipt(null);
      setCart((c) => addScan(c, result));
    } catch (e) {
      flash(e instanceof Error ? e.message : "Error de escaneo");
    }
  }

  async function quickAdd(barcodeOrScale: string) {
    if (!backend) return;
    setCode("");
    try {
      const result = await backend.scan(barcodeOrScale);
      if (result.kind !== "not_found") {
        setReceipt(null);
        setCart((c) => addScan(c, result));
      }
    } catch (e) {
      flash(e instanceof Error ? e.message : "Error de escaneo");
    }
  }

  async function registerAndAdd(draft: NewProductDraft) {
    if (!backend) return;
    const result = await backend.createProduct(draft);
    setRegistering(null);
    setReceipt(null);
    setCart((c) => addScan(c, result));
    setBoot(await backend.bootstrap()); // refresh the quick-pick grid
    flash(`Producto registrado: ${draft.name}`);
    scanRef.current?.focus();
  }

  async function pay(payments: PaymentInput[]) {
    if (!backend) return;
    try {
      const result = await backend.checkout(cart, payments);
      setReceipt(result);
      setCart(EMPTY_CART);
      setPaying(false);
      setCashText("");
      scanRef.current?.focus();
    } catch (e) {
      flash(e instanceof Error ? e.message : "Error al cobrar");
    }
  }

  const total = quote?.totals.totalCents ?? 0;
  const cashCents = Math.round(Number(cashText.replace(",", ".")) * 100) || 0;

  return (
    <div className="pos">
      <header className="pos-header">
        <h1>🍓 BerryPOS</h1>
        <span className="pos-mode">
          {backend.mode === "server"
            ? "Caja 1 — base de datos local conectada"
            : "Caja 1 — MODO DEMO (el servidor local no responde; nada se guarda)"}
        </span>
      </header>

      <main className="pos-main">
        <section className="pos-left">
          <div className="scan-row">
            <input
              ref={scanRef}
              autoFocus
              value={code}
              placeholder="Escanear o digitar código de barras…"
              onChange={(e) => setCode(e.target.value)}
              onKeyDown={(e) => e.key === "Enter" && void handleScan()}
            />
            <button onClick={() => void handleScan()}>Agregar</button>
            <button className="new-product-btn" onClick={() => setRegistering("")}>
              ➕ Nuevo producto
            </button>
          </div>

          <div className="quick-grid">
            {boot.products.map((p) => (
              <button
                key={p.id}
                className="quick-btn"
                onClick={() =>
                  void quickAdd(
                    p.barcodes[0] ??
                      // Weighables: simulate a 1.000 kg scale sticker.
                      demoScaleCode(p.scaleItemCode ?? "00000", 1000),
                  )
                }
              >
                <span className="quick-name">{p.name}</span>
                <span className="quick-price">
                  {money(p.unitPriceCents)}
                  {p.isWeighable ? " /kg" : ""}
                </span>
              </button>
            ))}
          </div>

          {message && <div className="flash">{message}</div>}

          {receipt && (
            <div className="receipt">
              <h3>✅ Venta registrada</h3>
              <p>
                Total {money(receipt.quote.totals.totalCents)} — vuelto{" "}
                <strong>{money(receipt.settlement.changeCents)}</strong>
              </p>
              {receipt.quote.promotions.length > 0 && (
                <p className="receipt-promos">
                  Promociones:{" "}
                  {receipt.quote.promotions
                    .map((a) => `${a.promotionName} (−${money(a.discountCents)})`)
                    .join(", ")}
                </p>
              )}
            </div>
          )}
        </section>

        <section className="pos-right">
          <div className="cart">
            {cart.lines.length === 0 && (
              <p className="cart-empty">Carrito vacío — escanea un producto</p>
            )}
            {cart.lines.map((line, i) => {
              const lineTotals = quote?.totals.lines[i];
              const discount =
                (lineTotals?.lineDiscountCents ?? 0) +
                (lineTotals?.orderDiscountCents ?? 0);
              return (
                <div key={line.lineId} className="cart-line">
                  <div className="cart-line-info">
                    <span className="cart-line-name">{line.name}</span>
                    <span className="cart-line-detail">
                      {qty(line.qtyMilli, line.fromScale)} ×{" "}
                      {money(line.unitPriceCents)}
                      {discount > 0 && (
                        <em className="cart-line-promo"> −{money(discount)}</em>
                      )}
                    </span>
                  </div>
                  <div className="cart-line-actions">
                    {!line.fromScale && (
                      <>
                        <button
                          onClick={() =>
                            line.qtyMilli > 1000
                              ? setCart(
                                  updateLine(cart, line.lineId, {
                                    qtyMilli: line.qtyMilli - 1000,
                                  }),
                                )
                              : setCart(removeLine(cart, line.lineId))
                          }
                        >
                          −
                        </button>
                        <button
                          onClick={() =>
                            setCart(
                              updateLine(cart, line.lineId, {
                                qtyMilli: line.qtyMilli + 1000,
                              }),
                            )
                          }
                        >
                          +
                        </button>
                      </>
                    )}
                    <button
                      className="danger"
                      onClick={() => setCart(removeLine(cart, line.lineId))}
                    >
                      ✕
                    </button>
                  </div>
                  <div className="cart-line-total">
                    {money(lineTotals?.totalCents ?? 0)}
                  </div>
                </div>
              );
            })}
          </div>

          <div className="totals">
            {quote && (
              <>
                <div className="totals-row">
                  <span>Subtotal</span>
                  <span>{money(quote.totals.grossCents)}</span>
                </div>
                {quote.totals.discountCents > 0 && (
                  <div className="totals-row promo">
                    <span>Descuentos</span>
                    <span>−{money(quote.totals.discountCents)}</span>
                  </div>
                )}
                {quote.totals.taxBreakdown.map((t) => (
                  <div key={t.code} className="totals-row tax">
                    <span>{t.code} incluido</span>
                    <span>{money(t.taxCents)}</span>
                  </div>
                ))}
              </>
            )}
            <div className="totals-row grand">
              <span>TOTAL</span>
              <span>{money(total)}</span>
            </div>

            {!paying ? (
              <button
                className="pay-btn"
                disabled={cart.lines.length === 0}
                onClick={() => setPaying(true)}
              >
                Cobrar {total > 0 ? money(total) : ""}
              </button>
            ) : (
              <div className="pay-panel">
                <button
                  className="pay-option"
                  onClick={() => void pay([{ method: "card", amountCents: total }])}
                >
                  💳 Tarjeta ({money(total)})
                </button>
                <button
                  className="pay-option"
                  onClick={() => void pay([{ method: "cash", amountCents: total }])}
                >
                  💵 Efectivo exacto
                </button>
                <div className="pay-cash">
                  <input
                    inputMode="decimal"
                    placeholder="Efectivo recibido"
                    value={cashText}
                    onChange={(e) => setCashText(e.target.value)}
                    onKeyDown={(e) =>
                      e.key === "Enter" &&
                      cashCents >= total &&
                      void pay([{ method: "cash", amountCents: cashCents }])
                    }
                  />
                  <button
                    disabled={cashCents < total}
                    onClick={() =>
                      void pay([{ method: "cash", amountCents: cashCents }])
                    }
                  >
                    Cobrar
                    {cashCents > total ? ` (vuelto ${money(cashCents - total)})` : ""}
                  </button>
                </div>
                <button className="pay-cancel" onClick={() => setPaying(false)}>
                  Cancelar
                </button>
              </div>
            )}
          </div>
        </section>
      </main>

      {registering !== null && (
        <RegisterProduct
          initialCode={registering}
          onSave={registerAndAdd}
          onCancel={() => {
            setRegistering(null);
            scanRef.current?.focus();
          }}
        />
      )}
    </div>
  );
}

/** Build a valid weight-embedded EAN-13 for the demo quick buttons. */
function demoScaleCode(itemCode: string, grams: number): string {
  const body = `20${itemCode}${String(grams).padStart(5, "0")}`;
  return body + ean13CheckDigit(body);
}

import { useMemo, useRef, useState } from "react";
import { cents, roundToUnit, type PaymentInput } from "@berrypos/domain";
import {
  addScan,
  EMPTY_CART,
  quoteCart,
  removeLine,
  updateLine,
  type Cart,
} from "../cart.js";
import type { ScanResult } from "../db/catalog.js";
import type {
  BootstrapData,
  CheckoutResult,
  NewProductDraft,
  PosBackend,
  UserSummary,
} from "./backend.js";
import RegisterProduct from "./RegisterProduct.js";
import { demoScaleCode, money, qty } from "./format.js";

interface Props {
  backend: PosBackend;
  boot: BootstrapData;
  user: UserSummary;
  refresh: () => Promise<void>;
}

export default function SaleView({ backend, boot, user, refresh }: Props) {
  const [cart, setCart] = useState<Cart>(EMPTY_CART);
  const [code, setCode] = useState("");
  const [message, setMessage] = useState<string | null>(null);
  const [paying, setPaying] = useState(false);
  const [cashText, setCashText] = useState("");
  const [receipt, setReceipt] = useState<CheckoutResult | null>(null);
  const [registering, setRegistering] = useState<string | null>(null);
  const scanRef = useRef<HTMLInputElement>(null);

  const quote = useMemo(
    () =>
      cart.lines.length > 0
        ? quoteCart(cart, boot.promotions, boot.taxCatalog)
        : null,
    [cart, boot],
  );

  function flash(text: string) {
    setMessage(text);
    window.setTimeout(() => setMessage(null), 2500);
  }

  /** Add a scan, BLOCKING when it would oversell the registered stock. */
  function addToCart(
    result: Exclude<ScanResult, { kind: "not_found" }>,
    stockOverride?: number,
  ) {
    const next = addScan(cart, result);
    const product = boot.products.find((p) => p.id === result.product.id);
    const available = stockOverride ?? product?.stockMilli ?? 0;
    const inCart = next.lines
      .filter((l) => l.productId === result.product.id)
      .reduce((a, l) => a + l.qtyMilli, 0);
    if (inCart > available) {
      flash(
        `⛔ Sin stock suficiente de ${result.product.name} (disponible: ${qty(Math.max(available, 0), result.product.isWeighable)}). Registra la recepción primero.`,
      );
      return;
    }
    setReceipt(null);
    setCart(next);
  }

  async function handleScan() {
    const trimmed = code.trim();
    setCode("");
    scanRef.current?.focus();
    if (!trimmed) return;
    try {
      const result = await backend.scan(trimmed);
      if (result.kind === "not_found") {
        // Unknown code: offer to register the product on the spot.
        setRegistering(trimmed);
        return;
      }
      addToCart(result);
    } catch (e) {
      flash(e instanceof Error ? e.message : "Error de escaneo");
    }
  }

  async function quickAdd(barcodeOrScale: string) {
    setCode("");
    try {
      const result = await backend.scan(barcodeOrScale);
      if (result.kind !== "not_found") addToCart(result);
    } catch (e) {
      flash(e instanceof Error ? e.message : "Error de escaneo");
    }
  }

  async function voidReceipt() {
    if (!receipt) return;
    try {
      await backend.voidSale({ saleId: receipt.saleId, voidedBy: user.id });
      setReceipt(null);
      await refresh();
      flash("Venta anulada: el stock volvió y el efectivo sale de caja");
    } catch (e) {
      flash(e instanceof Error ? e.message : "No se pudo anular");
    }
  }

  async function registerAndAdd(draft: NewProductDraft, initialStockMilli?: number) {
    const result = await backend.createProduct(draft);
    setRegistering(null);
    if (result.kind !== "not_found" && initialStockMilli && initialStockMilli > 0) {
      await backend.receiveStock({
        movementId: crypto.randomUUID(),
        productId: result.product.id,
        qtyMilli: initialStockMilli,
        note: "stock inicial (alta en caja)",
      });
    }
    await refresh();
    if (result.kind !== "not_found") {
      addToCart(result, initialStockMilli ?? 0);
    }
    flash(`Producto registrado: ${draft.name}`);
    scanRef.current?.focus();
  }

  async function pay(payments: PaymentInput[]) {
    try {
      const result = await backend.checkout(cart, payments);
      setReceipt(result);
      setCart(EMPTY_CART);
      setPaying(false);
      setCashText("");
      await refresh();
      scanRef.current?.focus();
    } catch (e) {
      flash(e instanceof Error ? e.message : "Error al cobrar");
    }
  }

  const total = quote?.totals.totalCents ?? 0;
  const cashDue = roundToUnit(
    cents(total),
    boot.cashRounding.unitCents,
    boot.cashRounding.mode,
  );
  const cashCents = Math.round(Number(cashText.replace(",", ".")) * 100) || 0;

  return (
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
                    demoScaleCode(p.scaleItemCode ?? "00000", 1000),
                )
              }
            >
              <span className="quick-name">{p.name}</span>
              <span className="quick-price">
                {money(p.unitPriceCents)}
                {p.isWeighable ? " /kg" : ""}
              </span>
              <span className={`quick-stock ${p.stockMilli <= 0 ? "out" : ""}`}>
                stock: {qty(p.stockMilli, p.isWeighable)}
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
            <button className="void-btn" onClick={() => void voidReceipt()}>
              Anular esta venta
            </button>
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
                        onClick={() => {
                          const product = boot.products.find(
                            (p) => p.id === line.productId,
                          );
                          const inCart = cart.lines
                            .filter((l) => l.productId === line.productId)
                            .reduce((a, l) => a + l.qtyMilli, 0);
                          if (product && inCart + 1000 > product.stockMilli) {
                            flash(`⛔ Sin stock suficiente de ${product.name}`);
                            return;
                          }
                          setCart(
                            updateLine(cart, line.lineId, {
                              qtyMilli: line.qtyMilli + 1000,
                            }),
                          );
                        }}
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

          {!boot.session && (
            <p className="no-shift-hint">
              Abre un turno en la pestaña Caja para poder cobrar
            </p>
          )}
          {!paying ? (
            <button
              className="pay-btn"
              disabled={cart.lines.length === 0 || !boot.session}
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
                onClick={() => void pay([{ method: "wallet", amountCents: total }])}
              >
                📱 Yape / Plin ({money(total)}) — verifica la notificación
              </button>
              <button
                className="pay-option"
                onClick={() => void pay([{ method: "cash", amountCents: cashDue }])}
              >
                💵 Efectivo exacto ({money(cashDue)})
              </button>
              <div className="pay-cash">
                <input
                  inputMode="decimal"
                  placeholder="Efectivo recibido"
                  value={cashText}
                  onChange={(e) => setCashText(e.target.value)}
                  onKeyDown={(e) =>
                    e.key === "Enter" &&
                    cashCents >= cashDue &&
                    void pay([{ method: "cash", amountCents: cashCents }])
                  }
                />
                <button
                  disabled={cashCents < cashDue}
                  onClick={() =>
                    void pay([{ method: "cash", amountCents: cashCents }])
                  }
                >
                  Cobrar
                  {cashCents > cashDue ? ` (vuelto ${money(cashCents - cashDue)})` : ""}
                </button>
              </div>
              <button className="pay-cancel" onClick={() => setPaying(false)}>
                Cancelar
              </button>
            </div>
          )}
        </div>
      </section>

      {registering !== null && (
        <RegisterProduct
          initialCode={registering}
          withInitialStock
          onSave={registerAndAdd}
          onCancel={() => {
            setRegistering(null);
            scanRef.current?.focus();
          }}
        />
      )}
    </main>
  );
}

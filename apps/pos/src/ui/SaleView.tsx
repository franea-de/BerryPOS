import { useEffect, useMemo, useRef, useState } from "react";
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
  PrintResult,
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
  const [ticket, setTicket] = useState<PrintResult | null>(null);
  const [lastCart, setLastCart] = useState<Cart | null>(null);
  const [secondsLeft, setSecondsLeft] = useState(30);
  const scanRef = useRef<HTMLInputElement>(null);

  // Billing Document states
  const [docType, setDocType] = useState<"boleta" | "factura">("boleta");
  const [customerRuc, setCustomerRuc] = useState("");
  const [customerName, setCustomerName] = useState("");

  // Wallet Confirmation states
  const [confirmingWallet, setConfirmingWallet] = useState<{ amountCents: number } | null>(null);
  const [walletOpCode, setWalletOpCode] = useState("");

  // Weighing Modal states
  const [weighingProduct, setWeighingProduct] = useState<{
    product: any;
    lineId?: string;
    initialQtyMilli?: number;
  } | null>(null);
  const [weightText, setWeightText] = useState("");
  const [valueText, setValueText] = useState("");

  // Sync weight text -> value text
  function handleWeightChange(text: string) {
    setWeightText(text);
    const kg = Number(text.replace(",", "."));
    if (isNaN(kg) || kg <= 0 || !weighingProduct) {
      setValueText("");
      return;
    }
    const price = weighingProduct.product.unitPriceCents / 100;
    setValueText((kg * price).toFixed(2));
  }

  // Sync value text -> weight text
  function handleValueChange(text: string) {
    setValueText(text);
    const val = Number(text.replace(",", "."));
    if (isNaN(val) || val <= 0 || !weighingProduct) {
      setWeightText("");
      return;
    }
    const price = weighingProduct.product.unitPriceCents / 100;
    setWeightText((val / price).toFixed(3));
  }

  // Save the result of the weighing modal
  function saveWeighing() {
    if (!weighingProduct) return;
    const kg = Number(weightText.replace(",", "."));
    if (isNaN(kg) || kg <= 0) {
      flash("Ingresa un peso válido mayor a cero");
      return;
    }
    const finalQtyMilli = Math.round(kg * 1000);
    
    if (weighingProduct.lineId) {
      // Editing an existing line in the cart
      setCart((prev) => updateLine(prev, weighingProduct.lineId!, { qtyMilli: finalQtyMilli }));
      flash(`Peso actualizado: ${kg.toFixed(3)} kg`);
    } else {
      // Adding a new product to the cart
      const result = {
        kind: "weighed" as const,
        product: weighingProduct.product,
        qtyMilli: finalQtyMilli,
      };
      addToCart(result);
    }
    setWeighingProduct(null);
  }

  // Initialize values when the modal opens
  useEffect(() => {
    if (!weighingProduct) {
      setWeightText("");
      setValueText("");
      return;
    }
    const qtyKg = (weighingProduct.initialQtyMilli ?? 1000) / 1000;
    setWeightText(qtyKg.toFixed(3));
    const price = weighingProduct.product.unitPriceCents / 100;
    setValueText((qtyKg * price).toFixed(2));
  }, [weighingProduct]);

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
    setCart((prevCart) => {
      const next = addScan(prevCart, result);
      const product = boot.products.find((p) => p.id === result.product.id);
      const available = stockOverride ?? product?.stockMilli ?? 0;
      const inCart = next.lines
        .filter((l) => l.productId === result.product.id)
        .reduce((a, l) => a + l.qtyMilli, 0);
      if (inCart > available) {
        flash(
          `⛔ Sin stock suficiente de ${result.product.name} (disponible: ${qty(Math.max(available, 0), result.product.isWeighable)}). Registra la recepción primero.`,
        );
        return prevCart;
      }
      setReceipt(null);
      return next;
    });
  }

  async function processBarcode(barcode: string) {
    const trimmed = barcode.trim();
    if (!trimmed) return;
    try {
      const result = await backend.scan(trimmed);
      if (result.kind === "not_found") {
        setRegistering(trimmed);
        return;
      }
      addToCart(result);
    } catch (e) {
      flash(e instanceof Error ? e.message : "Error de escaneo");
    }
  }

  async function handleScan() {
    const currentCode = code;
    setCode("");
    scanRef.current?.focus();
    await processBarcode(currentCode);
  }

  async function quickAdd(barcodeOrScale: string) {
    setCode("");
    await processBarcode(barcodeOrScale);
  }

  // Poll remote scans from cell phone
  useEffect(() => {
    let active = true;
    let timer: number | undefined;

    async function poll() {
      if (!active) return;
      try {
        const { codes } = await backend.getRemoteScans();
        if (codes && codes.length > 0) {
          for (const c of codes) {
            await processBarcode(c);
          }
        }
      } catch (err) {
        console.error("Error polling remote scans:", err);
      }
      if (active) {
        timer = window.setTimeout(poll, 1000);
      }
    }

    poll();

    return () => {
      active = false;
      if (timer) window.clearTimeout(timer);
    };
  }, [backend]);

  // Keep focus on the barcode input for hardware scanner guns
  useEffect(() => {
    function handleGlobalKeyDown(e: KeyboardEvent) {
      const target = e.target as HTMLElement | null;
      if (
        target &&
        (target.tagName === "INPUT" ||
          target.tagName === "TEXTAREA" ||
          target.isContentEditable)
      ) {
        return;
      }
      if (e.ctrlKey || e.altKey || e.metaKey) return;
      if (e.key.length > 1 && e.key !== "Enter") return;

      if (scanRef.current) {
        scanRef.current.focus();
      }
    }

    window.addEventListener("keydown", handleGlobalKeyDown);
    return () => {
      window.removeEventListener("keydown", handleGlobalKeyDown);
    };
  }, []);

  // Auto-hide receipt confirmation after 30 seconds with visual countdown
  useEffect(() => {
    if (!receipt) return;
    setSecondsLeft(30);
    const interval = window.setInterval(() => {
      setSecondsLeft((prev) => {
        if (prev <= 1) {
          setReceipt(null);
          setLastCart(null);
          return 0;
        }
        return prev - 1;
      });
    }, 1000);
    return () => {
      window.clearInterval(interval);
    };
  }, [receipt]);

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

  async function pay(payments: PaymentInput[], paymentReference?: string) {
    if (docType === "factura") {
      if (customerRuc.length !== 11 || isNaN(Number(customerRuc))) {
        flash("El RUC debe tener 11 dígitos numéricos");
        return;
      }
      if (!customerName.trim()) {
        flash("La Razón Social es obligatoria para Factura");
        return;
      }
    }

    try {
      const result = await backend.checkout(cart, payments, {
        documentType: docType,
        customerRuc: docType === "factura" ? customerRuc : undefined,
        customerName: docType === "factura" ? customerName : undefined,
        paymentReference,
      });
      setLastCart(cart);
      setReceipt(result);
      setCart(EMPTY_CART);
      setPaying(false);
      setCashText("");
      setDocType("boleta");
      setCustomerRuc("");
      setCustomerName("");
      await refresh();
      scanRef.current?.focus();
    } catch (e) {
      flash(e instanceof Error ? e.message : "Error al cobrar");
    }
  }

  async function editReceipt() {
    if (!receipt || !lastCart) return;
    try {
      await backend.voidSale({ saleId: receipt.saleId, voidedBy: user.id });
      setCart(lastCart);
      setReceipt(null);
      setLastCart(null);
      await refresh();
      flash("Venta anulada. Los productos han vuelto al carrito para editar.");
      scanRef.current?.focus();
    } catch (e) {
      flash(e instanceof Error ? e.message : "No se pudo editar la venta");
    }
  }

  function printTicket() {
    if (!ticket) return;
    const iframe = document.createElement("iframe");
    iframe.style.position = "absolute";
    iframe.style.width = "0";
    iframe.style.height = "0";
    iframe.style.border = "none";
    document.body.appendChild(iframe);

    const doc = iframe.contentWindow?.document;
    if (doc) {
      const lines = ticket.preview.split("\n");
      const qrLines = lines.filter((line) => line.includes("|"));
      const cleanText = lines.filter((line) => !line.includes("|")).join("\n");
      const qrData = qrLines.map((line) => line.trim()).join("");
      
      const qrHtml = qrData
        ? `<div style="text-align: center; margin-top: 15px;">
             <img src="https://api.qrserver.com/v1/create-qr-code/?size=150x150&data=${encodeURIComponent(qrData)}" style="width: 130px; height: 130px; background: white;" />
             <div style="font-size: 8px; font-family: sans-serif; color: #555; margin-top: 5px;">Representación Impresa de CPE</div>
           </div>`
        : "";

      doc.open();
      doc.write(`
        <html>
          <head>
            <title>Imprimir Ticket</title>
            <style>
              @page {
                size: auto;
                margin: 0;
              }
              body {
                width: 270px;
                margin: 0;
                padding: 10px;
                font-family: 'Courier New', Courier, monospace;
                font-size: 11px;
                line-height: 1.2;
                color: #000;
                background: #fff;
              }
              pre {
                margin: 0;
                white-space: pre;
                font-family: inherit;
              }
            </style>
          </head>
          <body>
            <pre>${cleanText}</pre>
            ${qrHtml}
          </body>
        </html>
      `);
      doc.close();

      setTimeout(() => {
        iframe.contentWindow?.focus();
        iframe.contentWindow?.print();
        document.body.removeChild(iframe);
      }, 500);
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
              onClick={() => {
                if (p.isWeighable) {
                  setWeighingProduct({ product: p });
                } else {
                  void quickAdd(p.barcodes[0] ?? "");
                }
              }}
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
            <div className="receipt-actions">
              <button
                className="print-btn"
                onClick={async () => {
                  try {
                    setTicket(await backend.printReceipt(receipt.saleId));
                  } catch (e) {
                    flash(e instanceof Error ? e.message : "No se pudo imprimir");
                  }
                }}
              >
                🖨 Ticket
              </button>
              <button className="void-btn" onClick={() => void voidReceipt()}>
                Anular esta venta ({secondsLeft}s)
              </button>
              <button className="edit-btn" onClick={() => void editReceipt()}>
                ✏️ Editar venta ({secondsLeft}s)
              </button>
            </div>
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
            const product = boot.products.find((p) => p.id === line.productId);
            return (
              <div key={line.lineId} className="cart-line">
                <div
                  className={`cart-line-info ${product?.isWeighable ? "weighable-clickable" : ""}`}
                  title={product?.isWeighable ? "Haz clic para cambiar peso o valor" : undefined}
                  onClick={() => {
                    if (product && product.isWeighable) {
                      setWeighingProduct({
                        product,
                        lineId: line.lineId,
                        initialQtyMilli: line.qtyMilli,
                      });
                    }
                  }}
                >
                  <span className="cart-line-name">
                    {line.name} {product?.isWeighable && "⚖️"}
                  </span>
                  <span className="cart-line-detail">
                    {qty(line.qtyMilli, line.fromScale || (product?.isWeighable ?? false))} ×{" "}
                    {money(line.unitPriceCents)}
                    {discount > 0 && (
                      <em className="cart-line-promo"> −{money(discount)}</em>
                    )}
                  </span>
                </div>
                <div className="cart-line-actions">
                  {product?.isWeighable ? (
                    <button
                      className="edit-weight-btn"
                      title="Modificar peso o valor"
                      onClick={() => {
                        setWeighingProduct({
                          product,
                          lineId: line.lineId,
                          initialQtyMilli: line.qtyMilli,
                        });
                      }}
                    >
                      ⚖️
                    </button>
                  ) : (
                    !line.fromScale && (
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
                    )
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
                <>
                  <div className="totals-row promo">
                    <span>Descuentos</span>
                    <span>−{money(quote.totals.discountCents)}</span>
                  </div>
                  {quote.promotions.map((p, idx) => (
                    <div key={idx} className="totals-row promo-detail" style={{ fontSize: "13px", paddingLeft: "12px", color: "var(--accent-2)" }}>
                      <span>🏷️ {p.promotionName}</span>
                      <span>−{money(p.discountCents)}</span>
                    </div>
                  ))}
                </>
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
              {/* Tipo de Documento Selector */}
              <div style={{ display: "flex", flexDirection: "column", gap: "8px", padding: "10px 0", borderBottom: "1px solid #3a4157", marginBottom: "12px", textAlign: "left" }}>
                <div style={{ display: "flex", gap: "8px" }}>
                  <button
                    type="button"
                    onClick={() => setDocType("boleta")}
                    style={{ flex: 1, padding: "8px", borderRadius: "6px", border: "1px solid #3a4157", background: docType === "boleta" ? "var(--accent-2)" : "var(--panel-2)", color: docType === "boleta" ? "#08150e" : "var(--muted)", fontWeight: "bold", cursor: "pointer" }}
                  >
                    Boleta
                  </button>
                  <button
                    type="button"
                    onClick={() => setDocType("factura")}
                    style={{ flex: 1, padding: "8px", borderRadius: "6px", border: "1px solid #3a4157", background: docType === "factura" ? "var(--accent-2)" : "var(--panel-2)", color: docType === "factura" ? "#08150e" : "var(--muted)", fontWeight: "bold", cursor: "pointer" }}
                  >
                    Factura
                  </button>
                </div>
                {docType === "factura" && (
                  <div style={{ display: "flex", flexDirection: "column", gap: "8px", marginTop: "8px" }}>
                    <input
                      type="text"
                      maxLength={11}
                      placeholder="RUC del Cliente (11 dígitos)"
                      value={customerRuc}
                      onChange={(e) => setCustomerRuc(e.target.value.replace(/\D/g, ""))}
                      style={{ padding: "8px 10px", borderRadius: "6px", background: "var(--panel-2)", color: "var(--text)", border: "1px solid #3a4157", fontSize: "13px" }}
                    />
                    <input
                      type="text"
                      placeholder="Razón Social / Nombre"
                      value={customerName}
                      onChange={(e) => setCustomerName(e.target.value)}
                      style={{ padding: "8px 10px", borderRadius: "6px", background: "var(--panel-2)", color: "var(--text)", border: "1px solid #3a4157", fontSize: "13px" }}
                    />
                  </div>
                )}
              </div>
              <button
                className="pay-option"
                onClick={() => void pay([{ method: "card", amountCents: total }])}
              >
                💳 Tarjeta ({money(total)})
              </button>
              <button
                className="pay-option"
                onClick={() => {
                  setWalletOpCode("");
                  setConfirmingWallet({ amountCents: total });
                }}
              >
                📱 Yape / Plin ({money(total)})
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

      {weighingProduct && (
        <div className="modal-backdrop">
          <div className="modal" style={{ width: "420px" }}>
            <h2>⚖️ Venta por Peso / Valor</h2>
            <p style={{ color: "var(--muted)", fontSize: "14px", marginBottom: "16px" }}>
              <strong>{weighingProduct.product.name}</strong> — {money(weighingProduct.product.unitPriceCents)} por kg
            </p>
            
            <div className="weigh-inputs-row" style={{ display: "flex", gap: "12px", alignItems: "center", marginBottom: "16px" }}>
              <label style={{ flex: 1, display: "flex", flexDirection: "column", gap: "4px", fontSize: "13px", color: "var(--muted)", textAlign: "left" }}>
                Peso (kilogramos)
                <input
                  type="text"
                  inputMode="decimal"
                  placeholder="Ej: 0.350"
                  value={weightText}
                  onChange={(e) => handleWeightChange(e.target.value)}
                  style={{ width: "100%", padding: "10px", borderRadius: "8px", background: "var(--panel-2)", color: "var(--text)", border: "1px solid #3a4157" }}
                />
              </label>
              <div style={{ alignSelf: "center", marginTop: "20px", color: "var(--muted)", fontWeight: "bold" }}>=</div>
              <label style={{ flex: 1, display: "flex", flexDirection: "column", gap: "4px", fontSize: "13px", color: "var(--muted)", textAlign: "left" }}>
                Valor en Soles (S/)
                <input
                  type="text"
                  inputMode="decimal"
                  placeholder="Ej: 5.00"
                  value={valueText}
                  onChange={(e) => handleValueChange(e.target.value)}
                  style={{ width: "100%", padding: "10px", borderRadius: "8px", background: "var(--panel-2)", color: "var(--text)", border: "1px solid #3a4157" }}
                />
              </label>
            </div>

            <div className="weigh-presets" style={{ display: "flex", flexDirection: "column", gap: "10px", marginBottom: "20px" }}>
              <div style={{ display: "flex", gap: "6px" }}>
                <button
                  type="button"
                  onClick={() => handleWeightChange("0.100")}
                  style={{ flex: 1, padding: "8px", borderRadius: "6px", background: "#2a2f42", color: "var(--text)", border: "none", cursor: "pointer", fontSize: "13px" }}
                >
                  100g
                </button>
                <button
                  type="button"
                  onClick={() => handleWeightChange("0.250")}
                  style={{ flex: 1, padding: "8px", borderRadius: "6px", background: "#2a2f42", color: "var(--text)", border: "none", cursor: "pointer", fontSize: "13px" }}
                >
                  250g
                </button>
                <button
                  type="button"
                  onClick={() => handleWeightChange("0.500")}
                  style={{ flex: 1, padding: "8px", borderRadius: "6px", background: "#2a2f42", color: "var(--text)", border: "none", cursor: "pointer", fontSize: "13px" }}
                >
                  500g
                </button>
                <button
                  type="button"
                  onClick={() => handleWeightChange("1.000")}
                  style={{ flex: 1, padding: "8px", borderRadius: "6px", background: "#2a2f42", color: "var(--text)", border: "none", cursor: "pointer", fontSize: "13px" }}
                >
                  1kg
                </button>
              </div>
              <div style={{ display: "flex", gap: "6px" }}>
                <button
                  type="button"
                  onClick={() => handleValueChange("1.00")}
                  style={{ flex: 1, padding: "8px", borderRadius: "6px", background: "#1c3c2b", color: "#35c47c", border: "none", cursor: "pointer", fontSize: "13px", fontWeight: "bold" }}
                >
                  S/ 1
                </button>
                <button
                  type="button"
                  onClick={() => handleValueChange("2.00")}
                  style={{ flex: 1, padding: "8px", borderRadius: "6px", background: "#1c3c2b", color: "#35c47c", border: "none", cursor: "pointer", fontSize: "13px", fontWeight: "bold" }}
                >
                  S/ 2
                </button>
                <button
                  type="button"
                  onClick={() => handleValueChange("5.00")}
                  style={{ flex: 1, padding: "8px", borderRadius: "6px", background: "#1c3c2b", color: "#35c47c", border: "none", cursor: "pointer", fontSize: "13px", fontWeight: "bold" }}
                >
                  S/ 5
                </button>
                <button
                  type="button"
                  onClick={() => handleValueChange("10.00")}
                  style={{ flex: 1, padding: "8px", borderRadius: "6px", background: "#1c3c2b", color: "#35c47c", border: "none", cursor: "pointer", fontSize: "13px", fontWeight: "bold" }}
                >
                  S/ 10
                </button>
              </div>
            </div>

            <div className="modal-actions" style={{ display: "flex", gap: "10px", justifyContent: "flex-end" }}>
              <button
                className="modal-cancel"
                onClick={() => setWeighingProduct(null)}
                style={{ padding: "10px 18px", border: "none", borderRadius: "8px", background: "transparent", color: "var(--muted)", cursor: "pointer", fontWeight: "bold" }}
              >
                Cancelar
              </button>
              <button
                className="modal-save"
                disabled={!weightText || Number(weightText.replace(",", ".")) <= 0}
                onClick={saveWeighing}
                style={{ padding: "10px 20px", border: "none", borderRadius: "8px", background: "var(--accent-2)", color: "#08150e", cursor: "pointer", fontWeight: "bold" }}
              >
                {weighingProduct.lineId ? "Actualizar" : "Agregar"}
              </button>
            </div>
          </div>
        </div>
      )}

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

      {confirmingWallet && (
        <div className="modal-backdrop">
          <div className="modal" style={{ width: "420px", background: "var(--panel)" }}>
            <h2 style={{ display: "flex", alignItems: "center", gap: "8px", color: "var(--text)" }}>
              📱 Confirmar Pago Yape / Plin
            </h2>
            <div style={{ padding: "12px", background: "var(--panel-2)", borderRadius: "8px", border: "1px solid #3a4157", marginTop: "4px" }}>
              <p style={{ fontSize: "14px", fontWeight: "bold", color: "var(--accent-2)", marginBottom: "8px" }}>
                Monto a Recibir: {money(confirmingWallet.amountCents)}
              </p>
              <ul style={{ paddingLeft: "16px", margin: "8px 0", fontSize: "13px", color: "var(--muted)", lineHeight: "1.5" }}>
                <li>Pídele al cliente que escanee el QR de Yape/Plin o envíe al celular de la tienda.</li>
                <li>Verifica en su celular que el nombre de destinatario sea correcto.</li>
                <li>Confirma que el estado de la transacción sea exitoso.</li>
              </ul>
            </div>
            
            <div style={{ display: "flex", flexDirection: "column", gap: "6px", textAlign: "left", marginTop: "8px" }}>
              <label style={{ fontSize: "13px", color: "var(--muted)" }}>Código de Operación (Opcional):</label>
              <input
                type="text"
                placeholder="Ej: 123456 (6 dígitos)"
                value={walletOpCode}
                onChange={(e) => setWalletOpCode(e.target.value.replace(/\D/g, ""))}
                style={{ padding: "12px", borderRadius: "8px", background: "var(--panel-2)", color: "var(--text)", border: "1px solid #3a4157", fontSize: "15px" }}
              />
            </div>

            <div className="modal-actions" style={{ display: "flex", gap: "10px", marginTop: "12px" }}>
              <button
                className="modal-cancel"
                onClick={() => setConfirmingWallet(null)}
                style={{ padding: "10px 18px", border: "none", borderRadius: "8px", background: "transparent", color: "var(--muted)", cursor: "pointer", fontWeight: "bold" }}
              >
                Cancelar
              </button>
              <button
                className="modal-save"
                onClick={async () => {
                  const amt = confirmingWallet.amountCents;
                  setConfirmingWallet(null);
                  await pay([{ method: "wallet", amountCents: amt }], walletOpCode);
                }}
                style={{ padding: "10px 20px", border: "none", borderRadius: "8px", background: "var(--accent-2)", color: "#08150e", cursor: "pointer", fontWeight: "bold" }}
              >
                ✓ Confirmar Pago
              </button>
            </div>
          </div>
        </div>
      )}

      {ticket && (() => {
        const lines = ticket.preview.split("\n");
        const qrLines = lines.filter((line) => line.includes("|"));
        const cleanText = lines.filter((line) => !line.includes("|")).join("\n");
        const qrData = qrLines.map((line) => line.trim()).join("");
        const qrUrl = qrData
          ? `https://api.qrserver.com/v1/create-qr-code/?size=150x150&data=${encodeURIComponent(qrData)}`
          : null;

        return (
          <div className="modal-backdrop" onClick={() => setTicket(null)}>
            <div className="modal ticket-preview-modal" onClick={(e) => e.stopPropagation()} style={{ width: "380px", background: "#11141e" }}>
              <h2>Ticket de Venta</h2>
              
              <div className="ticket-paper-roll" style={{ background: "white", padding: "16px 20px", borderRadius: "4px", color: "black", textAlign: "left", boxShadow: "0 4px 10px rgba(0,0,0,0.5)", maxHeight: "60vh", overflowY: "auto", margin: "12px auto", width: "320px", boxSizing: "border-box" }}>
                <pre style={{ fontStyle: "normal", fontFamily: "'Courier New', Courier, monospace", fontSize: "11px", whiteSpace: "pre", margin: 0, overflowX: "hidden" }}>{cleanText}</pre>
                {qrUrl && (
                  <div style={{ display: "flex", flexDirection: "column", alignItems: "center", marginTop: "12px", borderTop: "1px dashed #ccc", paddingTop: "12px" }}>
                    <img src={qrUrl} alt="QR SUNAT" style={{ width: "120px", height: "120px", background: "white", padding: "6px", border: "1px solid #ddd", borderRadius: "4px" }} />
                    <span style={{ fontSize: "10px", color: "#666", marginTop: "4px", fontWeight: "bold" }}>CPE de prueba tributaria</span>
                  </div>
                )}
              </div>

              <div className="modal-actions" style={{ display: "flex", gap: "10px", marginTop: "16px" }}>
                <button
                  className="modal-cancel"
                  onClick={() => setTicket(null)}
                  style={{ flex: 1, padding: "10px 18px", border: "none", borderRadius: "8px", background: "transparent", color: "var(--muted)", cursor: "pointer", fontWeight: "bold" }}
                >
                  Cerrar
                </button>
                <button
                  className="modal-save"
                  onClick={printTicket}
                  style={{ flex: 1, padding: "10px 20px", border: "none", borderRadius: "8px", background: "var(--accent-2)", color: "#08150e", cursor: "pointer", fontWeight: "bold" }}
                >
                  🖨 Imprimir
                </button>
              </div>
            </div>
          </div>
        );
      })()}
    </main>
  );
}

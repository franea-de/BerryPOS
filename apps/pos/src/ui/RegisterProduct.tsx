import { useState } from "react";
import { generateInternalEan13 } from "@berrypos/domain";
import type { NewProductDraft } from "./backend.js";

interface Props {
  /** The unknown code that was scanned, or empty for a brand-new product. */
  initialCode: string;
  /** Sale-screen flow: ask how many units arrived so the sale isn't blocked. */
  withInitialStock?: boolean;
  onSave: (draft: NewProductDraft, initialStockMilli?: number) => Promise<void>;
  onCancel: () => void;
}

/** Alta rápida: register a product without leaving the sale. */
export default function RegisterProduct({
  initialCode,
  withInitialStock = false,
  onSave,
  onCancel,
}: Props) {
  const [barcode, setBarcode] = useState(initialCode);
  const [name, setName] = useState("");
  const [priceText, setPriceText] = useState("");
  const [stockText, setStockText] = useState("1");
  const [weighable, setWeighable] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const priceCents = Math.round(Number(priceText.replace(",", ".")) * 100);
  const stockValue = Number(stockText.replace(",", "."));
  const stockMilli = weighable
    ? Math.round(stockValue * 1000)
    : Math.round(stockValue) * 1000;
  const valid =
    barcode.trim().length > 0 &&
    name.trim().length > 0 &&
    Number.isInteger(priceCents) &&
    priceCents > 0 &&
    (!withInitialStock || (Number.isFinite(stockMilli) && stockMilli > 0));

  async function save() {
    if (!valid) return;
    try {
      await onSave(
        {
          name: name.trim(),
          barcode: barcode.trim(),
          unitPriceCents: priceCents,
          isWeighable: weighable,
        },
        withInitialStock ? stockMilli : undefined,
      );
    } catch (e) {
      setError(e instanceof Error ? e.message : "No se pudo registrar");
    }
  }

  return (
    <div className="modal-backdrop" onClick={onCancel}>
      <div className="modal" onClick={(e) => e.stopPropagation()}>
        <h2>Registrar producto</h2>
        <p className="modal-hint">
          {initialCode
            ? "Este código no está en el catálogo. Complétalo y queda listo para vender."
            : "Producto sin código de fábrica: genera uno interno e imprímelo."}
        </p>

        <label>
          Código de barras
          <div className="modal-code-row">
            <input
              value={barcode}
              onChange={(e) => setBarcode(e.target.value)}
              placeholder="Escanea o digita el código"
            />
            <button
              type="button"
              onClick={() => setBarcode(generateInternalEan13())}
            >
              Generar interno
            </button>
          </div>
        </label>

        <label>
          Nombre
          <input
            autoFocus
            value={name}
            onChange={(e) => setName(e.target.value)}
            placeholder="Ej: Galletas surtidas 250g"
            onKeyDown={(e) => e.key === "Enter" && void save()}
          />
        </label>

        <label>
          Precio de venta {weighable ? "(por kg)" : ""}
          <input
            inputMode="decimal"
            value={priceText}
            onChange={(e) => setPriceText(e.target.value)}
            placeholder="Ej: 14.90"
            onKeyDown={(e) => e.key === "Enter" && void save()}
          />
        </label>

        <label className="modal-check">
          <input
            type="checkbox"
            checked={weighable}
            onChange={(e) => setWeighable(e.target.checked)}
          />
          Se vende por peso (balanza)
        </label>

        {withInitialStock && (
          <label>
            Cantidad disponible {weighable ? "(kg)" : "(unidades)"}
            <input
              inputMode="decimal"
              value={stockText}
              onChange={(e) => setStockText(e.target.value)}
              onKeyDown={(e) => e.key === "Enter" && void save()}
            />
          </label>
        )}

        {error && <div className="flash">{error}</div>}

        <div className="modal-actions">
          <button className="modal-cancel" onClick={onCancel}>
            Cancelar
          </button>
          <button className="modal-save" disabled={!valid} onClick={() => void save()}>
            Guardar y agregar a la venta
          </button>
        </div>
      </div>
    </div>
  );
}

import { useState } from "react";
import { generateInternalEan13 } from "@berrypos/domain";
import type { NewProductDraft } from "./backend.js";

interface Props {
  /** The unknown code that was scanned, or empty for a brand-new product. */
  initialCode: string;
  onSave: (draft: NewProductDraft) => void;
  onCancel: () => void;
}

/** Alta rápida: register a product without leaving the sale. */
export default function RegisterProduct({ initialCode, onSave, onCancel }: Props) {
  const [barcode, setBarcode] = useState(initialCode);
  const [name, setName] = useState("");
  const [priceText, setPriceText] = useState("");
  const [weighable, setWeighable] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const priceCents = Math.round(Number(priceText.replace(",", ".")) * 100);
  const valid =
    barcode.trim().length > 0 &&
    name.trim().length > 0 &&
    Number.isInteger(priceCents) &&
    priceCents > 0;

  function save() {
    if (!valid) return;
    try {
      onSave({
        name: name.trim(),
        barcode: barcode.trim(),
        unitPriceCents: priceCents,
        isWeighable: weighable,
      });
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
            onKeyDown={(e) => e.key === "Enter" && save()}
          />
        </label>

        <label>
          Precio de venta {weighable ? "(por kg)" : ""}
          <input
            inputMode="decimal"
            value={priceText}
            onChange={(e) => setPriceText(e.target.value)}
            placeholder="Ej: 14.90"
            onKeyDown={(e) => e.key === "Enter" && save()}
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

        {error && <div className="flash">{error}</div>}

        <div className="modal-actions">
          <button className="modal-cancel" onClick={onCancel}>
            Cancelar
          </button>
          <button className="modal-save" disabled={!valid} onClick={save}>
            Guardar y agregar a la venta
          </button>
        </div>
      </div>
    </div>
  );
}

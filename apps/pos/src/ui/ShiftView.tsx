import { useState } from "react";
import type {
  BootstrapData,
  PosBackend,
  ShiftCloseResult,
  UserSummary,
} from "./backend.js";
import { money } from "./format.js";

interface Props {
  backend: PosBackend;
  boot: BootstrapData;
  user: UserSummary;
  refresh: () => Promise<void>;
}

const METHOD_LABEL: Record<string, string> = {
  cash: "Efectivo",
  card: "Tarjeta",
  transfer: "Transferencia",
  credit: "Fiado",
};

const KIND_LABEL: Record<string, string> = {
  opening_float: "Fondo inicial",
  cash_sale: "Ventas en efectivo",
  refund: "Devoluciones",
  pay_in: "Ingresos",
  pay_out: "Retiros",
};

/** Shift management: open with a float, move cash, close with a blind count. */
export default function ShiftView({ backend, boot, user, refresh }: Props) {
  const [floatText, setFloatText] = useState("");
  const [moveKind, setMoveKind] = useState<"pay_in" | "pay_out">("pay_out");
  const [moveText, setMoveText] = useState("");
  const [moveNote, setMoveNote] = useState("");
  const [countedText, setCountedText] = useState("");
  const [closing, setClosing] = useState(false);
  const [result, setResult] = useState<ShiftCloseResult | null>(null);
  const [message, setMessage] = useState<string | null>(null);

  function flash(text: string) {
    setMessage(text);
    window.setTimeout(() => setMessage(null), 2500);
  }

  const toCents = (t: string) => Math.round(Number(t.replace(",", ".")) * 100);

  async function openShift() {
    const openingFloatCents = toCents(floatText) || 0;
    try {
      await backend.openShift({
        sessionId: crypto.randomUUID(),
        cashierId: user.id,
        openingFloatCents,
      });
      setFloatText("");
      setResult(null);
      await refresh();
    } catch (e) {
      flash(e instanceof Error ? e.message : "No se pudo abrir el turno");
    }
  }

  async function move() {
    const amountCents = toCents(moveText);
    if (!Number.isInteger(amountCents) || amountCents <= 0) {
      flash("Monto inválido");
      return;
    }
    try {
      await backend.cashMovement({
        movementId: crypto.randomUUID(),
        kind: moveKind,
        amountCents,
        ...(moveNote.trim() ? { note: moveNote.trim() } : {}),
      });
      setMoveText("");
      setMoveNote("");
      flash(moveKind === "pay_out" ? "Retiro registrado" : "Ingreso registrado");
    } catch (e) {
      flash(e instanceof Error ? e.message : "No se pudo registrar");
    }
  }

  async function closeShift() {
    const countedCents = toCents(countedText);
    if (!Number.isInteger(countedCents) || countedCents < 0) {
      flash("Monto contado inválido");
      return;
    }
    try {
      const r = await backend.closeShift({ countedCents });
      setResult(r);
      setClosing(false);
      setCountedText("");
      await refresh();
    } catch (e) {
      flash(e instanceof Error ? e.message : "No se pudo cerrar");
    }
  }

  return (
    <main className="shift">
      {result && (
        <div className="z-report">
          <h2>Reporte Z — turno cerrado</h2>
          <div className="z-grid">
            <div className="z-row">
              <span>Efectivo esperado</span>
              <span>{money(result.z.expectedCents)}</span>
            </div>
            <div className="z-row">
              <span>Efectivo contado</span>
              <span>{money(result.z.countedCents)}</span>
            </div>
            <div className={`z-row grand ${result.z.overShortCents === 0 ? "ok" : "bad"}`}>
              <span>Descuadre</span>
              <span>
                {result.z.overShortCents > 0 ? "+" : ""}
                {money(result.z.overShortCents)}
              </span>
            </div>
          </div>
          <div className="z-grid">
            {Object.entries(result.z.byKind)
              .filter(([, v]) => v !== 0)
              .map(([kind, v]) => (
                <div key={kind} className="z-row">
                  <span>{KIND_LABEL[kind] ?? kind}</span>
                  <span>{money(v)}</span>
                </div>
              ))}
          </div>
          <div className="z-grid">
            <div className="z-row">
              <span>Ventas del turno</span>
              <span>
                {result.sales.salesCount} — {money(result.sales.totalCents)}
              </span>
            </div>
            {result.sales.byMethod.map((m) => (
              <div key={m.method} className="z-row">
                <span>{METHOD_LABEL[m.method] ?? m.method}</span>
                <span>{money(m.amountCents)}</span>
              </div>
            ))}
          </div>
        </div>
      )}

      {!boot.session ? (
        <div className="shift-panel">
          <h2>Abrir turno</h2>
          <p className="modal-hint">
            Cajero: <strong>{user.name}</strong>
          </p>
          <label>
            Fondo inicial en caja (S/)
            <input
              inputMode="decimal"
              placeholder="Ej: 100.00"
              value={floatText}
              onChange={(e) => setFloatText(e.target.value)}
              onKeyDown={(e) => e.key === "Enter" && void openShift()}
            />
          </label>
          <button className="pay-btn" onClick={() => void openShift()}>
            Abrir turno
          </button>
        </div>
      ) : (
        <>
          <div className="shift-panel">
            <h2>Turno abierto</h2>
            <p className="modal-hint">
              Cajero: <strong>{boot.session.cashierName}</strong> · desde{" "}
              {new Date(boot.session.openedAt).toLocaleTimeString("es-PE")}
            </p>

            <div className="shift-move">
              <div className="shift-move-kind">
                <button
                  className={moveKind === "pay_out" ? "active" : ""}
                  onClick={() => setMoveKind("pay_out")}
                >
                  Retiro
                </button>
                <button
                  className={moveKind === "pay_in" ? "active" : ""}
                  onClick={() => setMoveKind("pay_in")}
                >
                  Ingreso
                </button>
              </div>
              <input
                inputMode="decimal"
                placeholder="Monto S/"
                value={moveText}
                onChange={(e) => setMoveText(e.target.value)}
              />
              <input
                placeholder="Motivo (opcional)"
                value={moveNote}
                onChange={(e) => setMoveNote(e.target.value)}
              />
              <button onClick={() => void move()}>Registrar</button>
            </div>
          </div>

          <div className="shift-panel">
            <h2>Cerrar turno (arqueo ciego)</h2>
            <p className="modal-hint">
              Cuenta TODO el efectivo del cajón y digítalo. El sistema recién
              entonces te mostrará el esperado y el descuadre.
            </p>
            {!closing ? (
              <button className="pay-btn danger-btn" onClick={() => setClosing(true)}>
                Iniciar cierre
              </button>
            ) : (
              <div className="pay-cash">
                <input
                  autoFocus
                  inputMode="decimal"
                  placeholder="Efectivo contado S/"
                  value={countedText}
                  onChange={(e) => setCountedText(e.target.value)}
                  onKeyDown={(e) => e.key === "Enter" && void closeShift()}
                />
                <button onClick={() => void closeShift()}>Cerrar turno</button>
                <button className="pay-cancel" onClick={() => setClosing(false)}>
                  Cancelar
                </button>
              </div>
            )}
          </div>
        </>
      )}

      {message && <div className="flash">{message}</div>}
    </main>
  );
}

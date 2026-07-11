import { useEffect, useState } from "react";
import type {
  BootstrapData,
  CashierDaySummary,
  PosBackend,
} from "./backend.js";
import { money } from "./format.js";

interface Props {
  backend: PosBackend;
  boot: BootstrapData;
}

/** Admin view: who sold how much today, and how their shifts squared. */
export default function SummaryView({ backend, boot }: Props) {
  const [rows, setRows] = useState<CashierDaySummary[] | null>(null);
  const [error, setError] = useState<string | null>(null);

  const nameOf = (cashierId: string) =>
    boot.users.find((u) => u.id === cashierId)?.name ?? cashierId;

  async function load() {
    try {
      const r = await backend.dailySummary();
      setRows(r.cashiers);
      setError(null);
    } catch (e) {
      setError(e instanceof Error ? e.message : "No se pudo cargar");
    }
  }

  useEffect(() => {
    void load();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const total = (rows ?? []).reduce((a, r) => a + r.totalCents, 0);
  const count = (rows ?? []).reduce((a, r) => a + r.salesCount, 0);

  return (
    <main className="summary">
      <div className="shift-panel">
        <div className="summary-head">
          <h2>Resumen de hoy</h2>
          <button onClick={() => void load()}>Actualizar</button>
        </div>

        {error && <div className="flash">{error}</div>}
        {rows && rows.length === 0 && (
          <p className="cart-empty">Sin actividad hoy todavía</p>
        )}

        {rows && rows.length > 0 && (
          <table className="summary-table">
            <thead>
              <tr>
                <th>Trabajador</th>
                <th>Ventas</th>
                <th>Total vendido</th>
                <th>Descuadre</th>
                <th>Turnos</th>
              </tr>
            </thead>
            <tbody>
              {rows.map((r) => (
                <tr key={r.cashierId}>
                  <td>{nameOf(r.cashierId)}</td>
                  <td>{r.salesCount}</td>
                  <td>{money(r.totalCents)}</td>
                  <td className={r.overShortCents === 0 ? "" : "bad"}>
                    {r.overShortCents > 0 ? "+" : ""}
                    {money(r.overShortCents)}
                  </td>
                  <td>
                    {r.sessionsCount}
                    {r.openSessions > 0 ? " (1 abierto)" : ""}
                  </td>
                </tr>
              ))}
            </tbody>
            <tfoot>
              <tr>
                <td>Total del día</td>
                <td>{count}</td>
                <td>{money(total)}</td>
                <td colSpan={2}></td>
              </tr>
            </tfoot>
          </table>
        )}
      </div>
    </main>
  );
}

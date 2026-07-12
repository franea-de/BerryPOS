import { useEffect, useState } from "react";

const API_URL = import.meta.env.VITE_API_URL ?? "http://127.0.0.1:4000";

interface Summary {
  dayStartIso: string;
  totalCents: number;
  salesCount: number;
  stores: Array<{ storeId: string; salesCount: number; totalCents: number }>;
}
interface DailyRow {
  day: string;
  salesCount: number;
  totalCents: number;
}
interface RecentSale {
  saleId: string;
  storeId: string;
  deviceId: string;
  totalCents: number;
  occurredAt: string;
  paymentMethods: string[];
  voided: boolean;
}

const METHOD_LABEL: Record<string, string> = {
  cash: "Efectivo",
  card: "Tarjeta",
  wallet: "Yape/Plin",
  transfer: "Transferencia",
  credit: "Fiado",
};

function money(cents: number): string {
  return `S/ ${(cents / 100).toLocaleString("es-PE", {
    minimumFractionDigits: 2,
    maximumFractionDigits: 2,
  })}`;
}

export default function App() {
  const [token, setToken] = useState(
    () => localStorage.getItem("berrypos-admin-token") ?? "",
  );
  const [connected, setConnected] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [summary, setSummary] = useState<Summary | null>(null);
  const [daily, setDaily] = useState<DailyRow[]>([]);
  const [recent, setRecent] = useState<RecentSale[]>([]);

  async function call<T>(path: string): Promise<T> {
    const res = await fetch(`${API_URL}${path}`, {
      headers: { "x-admin-token": token },
    });
    const json = (await res.json()) as T & { message?: string };
    if (!res.ok) throw new Error(json.message ?? `HTTP ${res.status}`);
    return json;
  }

  async function load() {
    try {
      const [s, d, r] = await Promise.all([
        call<Summary>("/reports/summary"),
        call<DailyRow[]>("/reports/daily?days=14"),
        call<RecentSale[]>("/reports/recent"),
      ]);
      setSummary(s);
      setDaily(d);
      setRecent(r);
      setConnected(true);
      setError(null);
      localStorage.setItem("berrypos-admin-token", token);
    } catch (e) {
      setConnected(false);
      setError(e instanceof Error ? e.message : "No se pudo conectar");
    }
  }

  useEffect(() => {
    if (token) void load();
    const timer = setInterval(() => {
      if (token) void load();
    }, 30_000);
    return () => clearInterval(timer);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  if (!connected) {
    return (
      <div className="gate">
        <h1>🍓 BerryPOS — Panel</h1>
        <p>Ingresa el token de administrador del negocio</p>
        <div className="gate-row">
          <input
            type="password"
            value={token}
            placeholder="Token de acceso"
            onChange={(e) => setToken(e.target.value)}
            onKeyDown={(e) => e.key === "Enter" && void load()}
          />
          <button onClick={() => void load()}>Entrar</button>
        </div>
        {error && <p className="error">{error}</p>}
      </div>
    );
  }

  return (
    <div className="panel">
      <header>
        <h1>🍓 BerryPOS — Panel del negocio</h1>
        <button onClick={() => void load()}>Actualizar</button>
      </header>

      {summary && (
        <section className="cards">
          <div className="card big">
            <span className="card-label">Ventas de hoy</span>
            <span className="card-value">{money(summary.totalCents)}</span>
            <span className="card-sub">{summary.salesCount} ventas</span>
          </div>
          {summary.stores.map((s) => (
            <div key={s.storeId} className="card">
              <span className="card-label">{s.storeId}</span>
              <span className="card-value">{money(s.totalCents)}</span>
              <span className="card-sub">{s.salesCount} ventas</span>
            </div>
          ))}
        </section>
      )}

      <section className="grid2">
        <div className="box">
          <h2>Últimos 14 días</h2>
          <table>
            <thead>
              <tr>
                <th>Día</th>
                <th>Ventas</th>
                <th>Total</th>
              </tr>
            </thead>
            <tbody>
              {daily.map((d) => (
                <tr key={d.day}>
                  <td>{d.day}</td>
                  <td>{d.salesCount}</td>
                  <td>{money(d.totalCents)}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>

        <div className="box">
          <h2>Actividad reciente</h2>
          <table>
            <thead>
              <tr>
                <th>Hora</th>
                <th>Caja</th>
                <th>Pago</th>
                <th>Total</th>
              </tr>
            </thead>
            <tbody>
              {recent.map((r) => (
                <tr key={r.saleId} className={r.voided ? "voided" : ""}>
                  <td>
                    {new Date(r.occurredAt).toLocaleString("es-PE", {
                      day: "2-digit",
                      month: "2-digit",
                      hour: "2-digit",
                      minute: "2-digit",
                      hour12: false,
                    })}
                  </td>
                  <td>{r.deviceId}</td>
                  <td>
                    {r.paymentMethods.map((m) => METHOD_LABEL[m] ?? m).join(" + ")}
                    {r.voided ? " · ANULADA" : ""}
                  </td>
                  <td>{money(r.totalCents)}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </section>
    </div>
  );
}

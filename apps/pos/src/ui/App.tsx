import { useEffect, useState } from "react";
import {
  HttpBackend,
  MemoryBackend,
  type BootstrapData,
  type PosBackend,
  type UserSummary,
} from "./backend.js";
import LoginView from "./LoginView.js";
import ReceptionView from "./ReceptionView.js";
import SaleView from "./SaleView.js";
import ShiftView from "./ShiftView.js";
import SummaryView from "./SummaryView.js";

type Mode = "sale" | "reception" | "shift" | "summary";

export default function App() {
  const [backend, setBackend] = useState<PosBackend | null>(null);
  const [boot, setBoot] = useState<BootstrapData | null>(null);
  const [user, setUser] = useState<UserSummary | null>(null);
  const [mode, setMode] = useState<Mode>("sale");

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

  if (!backend || !boot) {
    return <div className="pos-loading">Conectando con la caja…</div>;
  }

  if (!user) {
    return (
      <LoginView
        users={boot.users}
        demoMode={backend.mode === "demo"}
        onLogin={async (userId, pin) => {
          setUser(await backend.login(userId, pin));
        }}
      />
    );
  }

  const refresh = async () => {
    setBoot(await backend.bootstrap());
  };

  const canSeeSummary = user.role === "admin" || user.role === "supervisor";

  return (
    <div className="pos">
      <header className="pos-header">
        <h1>🍓 BerryPOS</h1>
        <nav className="pos-tabs">
          <button className={mode === "sale" ? "active" : ""} onClick={() => setMode("sale")}>
            Venta
          </button>
          <button
            className={mode === "reception" ? "active" : ""}
            onClick={() => setMode("reception")}
          >
            Recepción
          </button>
          <button className={mode === "shift" ? "active" : ""} onClick={() => setMode("shift")}>
            Caja
          </button>
          {canSeeSummary && (
            <button
              className={mode === "summary" ? "active" : ""}
              onClick={() => setMode("summary")}
            >
              Resumen
            </button>
          )}
        </nav>
        <span className="pos-mode">
          {user.name}
          {boot.session ? ` · turno de ${boot.session.cashierName}` : " · sin turno"}
          {backend.mode === "demo" ? " · MODO DEMO" : ""}
        </span>
        <button className="logout-btn" onClick={() => setUser(null)}>
          Cambiar
        </button>
      </header>

      {/* Views stay mounted so switching tabs never loses in-progress work. */}
      <div className="view" hidden={mode !== "sale"}>
        <SaleView backend={backend} boot={boot} user={user} refresh={refresh} />
      </div>
      <div className="view" hidden={mode !== "reception"}>
        <ReceptionView backend={backend} boot={boot} refresh={refresh} />
      </div>
      <div className="view" hidden={mode !== "shift"}>
        <ShiftView backend={backend} boot={boot} user={user} refresh={refresh} />
      </div>
      {canSeeSummary && (
        <div className="view" hidden={mode !== "summary"}>
          <SummaryView backend={backend} boot={boot} />
        </div>
      )}
    </div>
  );
}

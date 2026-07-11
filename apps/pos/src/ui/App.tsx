import { useEffect, useState } from "react";
import {
  HttpBackend,
  MemoryBackend,
  type BootstrapData,
  type PosBackend,
} from "./backend.js";
import ReceptionView from "./ReceptionView.js";
import SaleView from "./SaleView.js";

type Mode = "sale" | "reception";

export default function App() {
  const [backend, setBackend] = useState<PosBackend | null>(null);
  const [boot, setBoot] = useState<BootstrapData | null>(null);
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

  const refresh = async () => {
    setBoot(await backend.bootstrap());
  };

  return (
    <div className="pos">
      <header className="pos-header">
        <h1>🍓 BerryPOS</h1>
        <nav className="pos-tabs">
          <button
            className={mode === "sale" ? "active" : ""}
            onClick={() => setMode("sale")}
          >
            Venta
          </button>
          <button
            className={mode === "reception" ? "active" : ""}
            onClick={() => setMode("reception")}
          >
            Recepción
          </button>
        </nav>
        <span className="pos-mode">
          {backend.mode === "server"
            ? "Caja 1 — base de datos local conectada"
            : "Caja 1 — MODO DEMO (el servidor local no responde; nada se guarda)"}
        </span>
      </header>

      {/* Both views stay mounted so switching tabs never loses the cart. */}
      <div className="view" hidden={mode !== "sale"}>
        <SaleView backend={backend} boot={boot} refresh={refresh} />
      </div>
      <div className="view" hidden={mode !== "reception"}>
        <ReceptionView backend={backend} boot={boot} refresh={refresh} />
      </div>
    </div>
  );
}

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
  const [showMobileModal, setShowMobileModal] = useState(false);
  const [lanIps, setLanIps] = useState<string[]>([]);

  const openMobileScanner = async () => {
    if (backend) {
      try {
        const res = await backend.getLanIps();
        setLanIps(res.ips);
        setShowMobileModal(true);
      } catch (e) {
        alert(e instanceof Error ? e.message : "Error al obtener IPs de red");
      }
    }
  };

  useEffect(() => {
    let cancelled = false;
    (async () => {
      // Prefer the local register server (real SQLite). The desktop shell
      // spawns it in parallel with the window, so retry before giving up
      // and falling back to the in-memory demo.
      const http = new HttpBackend();
      for (let attempt = 0; attempt < 10 && !cancelled; attempt++) {
        try {
          const data = await http.bootstrap();
          if (!cancelled) {
            setBackend(http);
            setBoot(data);
          }
          return;
        } catch {
          await new Promise((r) => setTimeout(r, 500));
        }
      }
      if (cancelled) return;
      const demo = new MemoryBackend();
      const data = await demo.bootstrap();
      if (!cancelled) {
        setBackend(demo);
        setBoot(data);
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
        <h1 style={{ display: "flex", alignItems: "center" }}>
          <img
            src="/logo.png"
            alt=""
            onError={(e) => (e.currentTarget.style.display = "none")}
            style={{ height: "24px", marginRight: "8px", display: "inline-block" }}
          />
          🍓 BerryPOS
        </h1>
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
        <button
          className="mobile-scan-btn"
          style={{
            marginLeft: "12px",
            backgroundColor: "#2c3e50",
            color: "white",
            border: "none",
            borderRadius: "4px",
            padding: "6px 12px",
            fontSize: "13px",
            cursor: "pointer",
            display: "flex",
            alignItems: "center",
            gap: "6px"
          }}
          onClick={openMobileScanner}
        >
          📱 Escáner Móvil
        </button>
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

      {showMobileModal && (
        <div
          style={{
            position: "fixed",
            top: 0,
            left: 0,
            right: 0,
            bottom: 0,
            backgroundColor: "rgba(0, 0, 0, 0.7)",
            display: "flex",
            alignItems: "center",
            justifyContent: "center",
            zIndex: 10000,
            padding: "20px",
          }}
        >
          <div
            style={{
              backgroundColor: "#1e272e",
              color: "white",
              borderRadius: "8px",
              padding: "24px",
              maxWidth: "500px",
              width: "100%",
              boxShadow: "0 4px 20px rgba(0,0,0,0.5)",
              position: "relative",
            }}
          >
            <h2 style={{ marginTop: 0, fontSize: "20px", display: "flex", alignItems: "center", gap: "8px" }}>
              📱 Vincular Escáner Móvil
            </h2>
            <p style={{ color: "#bdc581", fontSize: "14px", lineHeight: "1.4" }}>
              Asegúrate de que tu celular esté conectado a la **misma red Wi-Fi** que esta computadora. Escanea el código QR o ingresa a la dirección desde tu navegador móvil:
            </p>
            
            <div style={{ display: "flex", flexDirection: "column", alignItems: "center", gap: "16px", margin: "20px 0" }}>
              {lanIps.length > 0 ? (
                lanIps.map((ipUrl, idx) => (
                  <div key={idx} style={{ display: "flex", flexDirection: "column", alignItems: "center", gap: "8px", width: "100%" }}>
                    <div style={{ backgroundColor: "white", padding: "8px", borderRadius: "4px" }}>
                      <img
                        src={`https://api.qrserver.com/v1/create-qr-code/?size=160x160&data=${encodeURIComponent(ipUrl)}`}
                        alt="QR Scanner Link"
                        style={{ width: "160px", height: "160px", display: "block" }}
                      />
                    </div>
                    <a
                      href={ipUrl}
                      target="_blank"
                      rel="noopener noreferrer"
                      style={{ color: "#3498db", fontSize: "12px", wordBreak: "break-all", textAlign: "center", textDecoration: "none" }}
                    >
                      {ipUrl}
                    </a>
                  </div>
                ))
              ) : (
                <p style={{ color: "#e74c3c" }}>No se detectaron interfaces de red activas.</p>
              )}
            </div>

            <div style={{ borderTop: "1px solid #3d4e5d", paddingTop: "16px", display: "flex", justifyContent: "flex-end" }}>
              <button
                style={{
                  backgroundColor: "#e74c3c",
                  color: "white",
                  border: "none",
                  borderRadius: "4px",
                  padding: "8px 16px",
                  fontSize: "14px",
                  cursor: "pointer",
                }}
                onClick={() => setShowMobileModal(false)}
              >
                Cerrar
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}

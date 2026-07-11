import { useState } from "react";
import type { UserSummary } from "./backend.js";

interface Props {
  users: UserSummary[];
  demoMode: boolean;
  onLogin: (userId: string, pin: string) => Promise<void>;
}

const ROLE_LABEL: Record<string, string> = {
  admin: "Administrador",
  supervisor: "Supervisor",
  cashier: "Cajero",
};

/** Shift sign-in: pick who you are, type your PIN. */
export default function LoginView({ users, demoMode, onLogin }: Props) {
  const [selected, setSelected] = useState<UserSummary | null>(null);
  const [pin, setPin] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  async function submit() {
    if (!selected || pin.length === 0 || busy) return;
    setBusy(true);
    setError(null);
    try {
      await onLogin(selected.id, pin);
    } catch (e) {
      setError(e instanceof Error ? e.message : "No se pudo ingresar");
      setPin("");
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="login">
      <h1>🍓 BerryPOS</h1>
      {demoMode && (
        <p className="login-demo">MODO DEMO — el servidor local no responde</p>
      )}
      <p className="login-hint">¿Quién atiende este turno?</p>

      <div className="login-users">
        {users.map((u) => (
          <button
            key={u.id}
            className={`login-user ${selected?.id === u.id ? "active" : ""}`}
            onClick={() => {
              setSelected(u);
              setPin("");
              setError(null);
            }}
          >
            <span className="login-user-name">{u.name}</span>
            <span className="login-user-role">{ROLE_LABEL[u.role] ?? u.role}</span>
          </button>
        ))}
      </div>

      {selected && (
        <div className="login-pin">
          <input
            autoFocus
            type="password"
            inputMode="numeric"
            placeholder={`PIN de ${selected.name}`}
            value={pin}
            onChange={(e) => setPin(e.target.value)}
            onKeyDown={(e) => e.key === "Enter" && void submit()}
          />
          <button disabled={pin.length === 0 || busy} onClick={() => void submit()}>
            Ingresar
          </button>
        </div>
      )}

      {error && <div className="flash">{error}</div>}
    </div>
  );
}

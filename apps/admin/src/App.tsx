import { useEffect, useState } from "react";

const API_URL = import.meta.env.VITE_API_URL ?? "http://127.0.0.1:4001";

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
  
  // Tab control
  const [activeTab, setActiveTab] = useState<"reports" | "products" | "categories" | "users" | "ai">("reports");

  // AI chat states
  const [chatInput, setChatInput] = useState("");
  const [chatHistory, setChatHistory] = useState<Array<{ sender: "user" | "bot"; text: string }>>([
    {
      sender: "bot",
      text: "👋 ¡Hola! Soy tu Copiloto BerryPOS. Puedo darte reportes de ventas (ej: **¿Cuánto vendí hoy?**) o resolver tus dudas de soporte (ej: **¿Cómo edito una venta?**). ¿En qué te ayudo?",
    },
  ]);
  const [chatLoading, setChatLoading] = useState(false);

  // Data states
  const [summary, setSummary] = useState<Summary | null>(null);
  const [daily, setDaily] = useState<DailyRow[]>([]);
  const [recent, setRecent] = useState<RecentSale[]>([]);
  
  const [products, setProducts] = useState<any[]>([]);
  const [categories, setCategories] = useState<any[]>([]);
  const [users, setUsers] = useState<any[]>([]);
  const [taxes, setTaxes] = useState<any[]>([]);

  // Modals / forms
  const [editingProduct, setEditingProduct] = useState<any | null>(null);
  const [editingCategory, setEditingCategory] = useState<any | null>(null);
  const [editingUser, setEditingUser] = useState<any | null>(null);

  // Notifications
  const [message, setMessage] = useState<string | null>(null);

  function flash(msg: string) {
    setMessage(msg);
    setTimeout(() => setMessage(null), 4000);
  }

  async function call<T>(path: string): Promise<T> {
    const res = await fetch(`${API_URL}${path}`, {
      headers: { "x-admin-token": token },
    });
    const json = (await res.json()) as T & { message?: string };
    if (!res.ok) throw new Error(json.message ?? `HTTP ${res.status}`);
    return json;
  }

  async function loadReports() {
    try {
      const [s, d, r] = await Promise.all([
        call<Summary>("/reports/summary"),
        call<DailyRow[]>("/reports/daily?days=14"),
        call<RecentSale[]>("/reports/recent"),
      ]);
      setSummary(s);
      setDaily(d);
      setRecent(r);
    } catch (e) {
      throw e;
    }
  }

  async function loadProducts() {
    try {
      const prods = await call<any[]>("/catalog/products");
      setProducts(prods);
      const txs = await call<any[]>("/catalog/taxes");
      setTaxes(txs);
      // Automatically load categories in background for product dropdown
      const cats = await call<any[]>("/catalog/categories");
      setCategories(cats);
    } catch (e) {
      flash(e instanceof Error ? e.message : "Error al cargar productos");
    }
  }

  async function loadCategories() {
    try {
      const cats = await call<any[]>("/catalog/categories");
      setCategories(cats);
    } catch (e) {
      flash(e instanceof Error ? e.message : "Error al cargar categorías");
    }
  }

  async function loadUsers() {
    try {
      const usrs = await call<any[]>("/catalog/users");
      setUsers(usrs);
    } catch (e) {
      flash(e instanceof Error ? e.message : "Error al cargar usuarios");
    }
  }

  async function load() {
    try {
      await loadReports();
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
      if (token && activeTab === "reports") void loadReports().catch(() => {});
    }, 30_000);
    return () => clearInterval(timer);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // Fetch when tab changes
  useEffect(() => {
    if (!connected) return;
    if (activeTab === "products") void loadProducts();
    if (activeTab === "categories") void loadCategories();
    if (activeTab === "users") void loadUsers();
  }, [activeTab, connected]);

  async function saveProduct(draft: any) {
    try {
      const cleanDraft = {
        ...draft,
        barcodes: draft.barcodes.map((b: string) => b.trim()).filter(Boolean),
      };
      const res = await fetch(`${API_URL}/catalog/products`, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "x-admin-token": token,
        },
        body: JSON.stringify(cleanDraft),
      });
      if (!res.ok) {
        const err = await res.json();
        throw new Error(err.message ?? "Error al guardar");
      }
      flash("Producto guardado. ¡Cambio propagado!");
      setEditingProduct(null);
      void loadProducts();
    } catch (e) {
      alert(e instanceof Error ? e.message : "Error al guardar");
    }
  }

  async function saveCategory(draft: any) {
    try {
      const res = await fetch(`${API_URL}/catalog/categories`, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "x-admin-token": token,
        },
        body: JSON.stringify(draft),
      });
      if (!res.ok) {
        const err = await res.json();
        throw new Error(err.message ?? "Error al guardar");
      }
      flash("Categoría guardada con éxito.");
      setEditingCategory(null);
      void loadCategories();
    } catch (e) {
      alert(e instanceof Error ? e.message : "Error al guardar");
    }
  }

  async function saveUser(draft: any) {
    try {
      const res = await fetch(`${API_URL}/catalog/users`, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "x-admin-token": token,
        },
        body: JSON.stringify(draft),
      });
      if (!res.ok) {
        const err = await res.json();
        throw new Error(err.message ?? "Error al guardar");
      }
      flash("Usuario de caja actualizado.");
      setEditingUser(null);
      void loadUsers();
    } catch (e) {
      alert(e instanceof Error ? e.message : "Error al guardar");
    }
  }

  async function sendChatMessage(msgText: string) {
    const text = msgText.trim();
    if (!text) return;

    setChatHistory((prev) => [...prev, { sender: "user", text }]);
    setChatInput("");
    setChatLoading(true);

    try {
      const res = await fetch(`${API_URL}/ai/chat`, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "x-admin-token": token,
        },
        body: JSON.stringify({ message: text }),
      });
      if (!res.ok) {
        const err = await res.json();
        throw new Error(err.message ?? "Error en el chat");
      }
      const data = await res.json();
      setChatHistory((prev) => [...prev, { sender: "bot", text: data.reply }]);
    } catch (e) {
      setChatHistory((prev) => [
        ...prev,
        {
          sender: "bot",
          text: `❌ **Error de conexión:** ${e instanceof Error ? e.message : "No se pudo comunicar con el copiloto."}`,
        },
      ]);
    } finally {
      setChatLoading(false);
    }
  }

  if (!connected) {
    return (
      <div className="gate">
        <h1 style={{ display: "flex", alignItems: "center", justifyContent: "center" }}>
          <img
            src="/logoadmin.png"
            alt=""
            onError={(e) => (e.currentTarget.style.display = "none")}
            style={{ height: "32px", marginRight: "10px" }}
          />
           BerryPOS — Panel
        </h1>
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
        <div className="header-left">
          <h1 style={{ display: "flex", alignItems: "center" }}>
            <img
              src="/logoadmin.png"
              alt=""
              onError={(e) => (e.currentTarget.style.display = "none")}
              style={{ height: "24px", marginRight: "8px" }}
            />
             BerryPOS — Panel
          </h1>
          <nav className="nav-tabs">
            <button
              className={activeTab === "reports" ? "active" : ""}
              onClick={() => setActiveTab("reports")}
            >
              📊 Reportes
            </button>
            <button
              className={activeTab === "products" ? "active" : ""}
              onClick={() => setActiveTab("products")}
            >
              📦 Productos
            </button>
            <button
              className={activeTab === "categories" ? "active" : ""}
              onClick={() => setActiveTab("categories")}
            >
              🏷️ Categorías
            </button>
            <button
              className={activeTab === "users" ? "active" : ""}
              onClick={() => setActiveTab("users")}
            >
              👥 Cajeros
            </button>
            <button
              className={activeTab === "ai" ? "active" : ""}
              onClick={() => setActiveTab("ai")}
            >
              💬 Copiloto IA
            </button>
          </nav>
        </div>
        <div className="header-right">
          {message && <span className="toast">{message}</span>}
          <button onClick={() => {
            if (activeTab === "reports") void load();
            if (activeTab === "products") void loadProducts();
            if (activeTab === "categories") void loadCategories();
            if (activeTab === "users") void loadUsers();
          }}>Actualizar</button>
        </div>
      </header>

      {activeTab === "reports" && (
        <>
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
        </>
      )}

      {activeTab === "products" && (
        <section className="box tab-content">
          <div className="box-header">
            <h2>Catálogo de Productos en la Nube</h2>
            <button
              className="action-btn"
              onClick={() =>
                setEditingProduct({
                  id: crypto.randomUUID(),
                  name: "",
                  categoryId: "",
                  scaleItemCode: "",
                  isWeighable: false,
                  unitPriceCents: 0,
                  taxCodes: ["IGV18"],
                  active: true,
                  barcodes: [""],
                })
              }
            >
              ➕ Nuevo Producto
            </button>
          </div>
          <div className="table-wrapper">
            <table className="summary-table">
              <thead>
                <tr>
                  <th>Nombre</th>
                  <th>Precio</th>
                  <th>Código de Barras</th>
                  <th>Pesable</th>
                  <th>Impuestos</th>
                  <th>Estado</th>
                  <th>Acciones</th>
                </tr>
              </thead>
              <tbody>
                {products.map((p) => (
                  <tr key={p.id} className={!p.active ? "voided-row" : ""}>
                    <td>
                      <strong>{p.name}</strong>
                      {p.scaleItemCode && <span className="scale-badge">Balanza: {p.scaleItemCode}</span>}
                    </td>
                    <td>{money(p.unitPriceCents)}</td>
                    <td>{p.barcodes.join(", ") || "(Ninguno)"}</td>
                    <td>{p.isWeighable ? "Sí" : "No"}</td>
                    <td>{p.taxCodes.join(", ")}</td>
                    <td>{p.active ? "Activo" : "Inactivo"}</td>
                    <td>
                      <button
                        className="edit-row-btn"
                        onClick={() =>
                          setEditingProduct({
                            ...p,
                            barcodes: p.barcodes.length > 0 ? p.barcodes : [""],
                          })
                        }
                      >
                        ✏️ Editar
                      </button>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </section>
      )}

      {activeTab === "categories" && (
        <section className="box tab-content">
          <div className="box-header">
            <h2>Categorías de Productos</h2>
            <button
              className="action-btn"
              onClick={() => setEditingCategory({ id: "", name: "" })}
            >
              ➕ Nueva Categoría
            </button>
          </div>
          <table className="summary-table">
            <thead>
              <tr>
                <th>ID</th>
                <th>Nombre</th>
                <th>Acciones</th>
              </tr>
            </thead>
            <tbody>
              {categories.map((c) => (
                <tr key={c.id}>
                  <td><code>{c.id}</code></td>
                  <td><strong>{c.name}</strong></td>
                  <td>
                    <button
                      className="edit-row-btn"
                      onClick={() => setEditingCategory(c)}
                    >
                      ✏️ Editar
                    </button>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </section>
      )}

      {activeTab === "users" && (
        <section className="box tab-content">
          <div className="box-header">
            <h2>Personal de Caja Registradora</h2>
            <button
              className="action-btn"
              onClick={() =>
                setEditingUser({
                  id: "",
                  name: "",
                  role: "cashier",
                  active: true,
                  pin: "",
                })
              }
            >
              ➕ Nuevo Cajero
            </button>
          </div>
          <table className="summary-table">
            <thead>
              <tr>
                <th>ID</th>
                <th>Nombre</th>
                <th>Rol</th>
                <th>Estado</th>
                <th>Acciones</th>
              </tr>
            </thead>
            <tbody>
              {users.map((u) => (
                <tr key={u.id} className={!u.active ? "voided-row" : ""}>
                  <td><code>{u.id}</code></td>
                  <td><strong>{u.name}</strong></td>
                  <td>{u.role === "admin" ? "Administrador" : u.role === "supervisor" ? "Supervisor" : "Cajero"}</td>
                  <td>{u.active ? "Activo" : "Inactivo"}</td>
                  <td>
                    <button
                      className="edit-row-btn"
                      onClick={() => setEditingUser({ ...u, pin: "" })}
                    >
                      ✏️ Editar
                    </button>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </section>
      )}

      {activeTab === "ai" && (
        <section className="box tab-content ai-chat-container">
          <div className="box-header">
            <h2>Copiloto IA de Soporte y Reportes</h2>
          </div>
          
          <div className="ai-chat-body">
            <div className="ai-suggestions">
              <button
                className="suggestion-card"
                onClick={() => void sendChatMessage("¿Cuánto se ha vendido hoy en total?")}
              >
                📊 <strong>Ventas de Hoy</strong>
                <span>Consulta el monto total recaudado hoy</span>
              </button>
              <button
                className="suggestion-card"
                onClick={() => void sendChatMessage("¿Cómo conecto el celular para escanear?")}
              >
                📲 <strong>Escanear con Celular</strong>
                <span>Pasos para usar el móvil como lector</span>
              </button>
              <button
                className="suggestion-card"
                onClick={() => void sendChatMessage("¿Cómo edito o anulo una venta?")}
              >
                ✏️ <strong>Editar / Anular Venta</strong>
                <span>Instrucciones del flujo de corrección</span>
              </button>
            </div>

            <div className="ai-chat-history">
              {chatHistory.map((chat, idx) => (
                <div key={idx} className={`chat-bubble-wrapper ${chat.sender}`}>
                  <div className="chat-bubble-avatar">
                    {chat.sender === "user" ? "👤" : "🍓"}
                  </div>
                  <div className="chat-bubble">
                    {chat.text.split("\n").map((line, lIdx) => {
                      const regex = /\*\*(.*?)\*\*/g;
                      let match;
                      const parts = [];
                      let lastIdx = 0;
                      while ((match = regex.exec(line)) !== null) {
                        parts.push(line.substring(lastIdx, match.index));
                        parts.push(<strong key={match.index}>{match[1]}</strong>);
                        lastIdx = regex.lastIndex;
                      }
                      parts.push(line.substring(lastIdx));
                      
                      return (
                        <p key={lIdx} style={{ margin: "4px 0" }}>
                          {parts.length > 1 ? parts : line}
                        </p>
                      );
                    })}
                  </div>
                </div>
              ))}
              
              {chatLoading && (
                <div className="chat-bubble-wrapper bot loading">
                  <div className="chat-bubble-avatar">🍓</div>
                  <div className="chat-bubble">
                    <span>Copiloto pensando...</span>
                  </div>
                </div>
              )}
            </div>

            <div className="ai-chat-footer">
              <input
                type="text"
                placeholder="Pregúntale al copiloto... (ej: ¿Cuánto vendí hoy?)"
                value={chatInput}
                onChange={(e) => setChatInput(e.target.value)}
                onKeyDown={(e) => e.key === "Enter" && void sendChatMessage(chatInput)}
                disabled={chatLoading}
              />
              <button
                onClick={() => void sendChatMessage(chatInput)}
                disabled={chatLoading || !chatInput.trim()}
              >
                Enviar
              </button>
            </div>
          </div>
        </section>
      )}

      {/* MODAL EDIT PRODUCT */}
      {editingProduct && (
        <div className="modal-backdrop">
          <div className="modal">
            <h2>{editingProduct.categoryId ? "Editar Producto" : "Nuevo Producto"}</h2>
            
            <label className="form-label">
              Nombre del Producto
              <input
                type="text"
                value={editingProduct.name}
                onChange={(e) => setEditingProduct({ ...editingProduct, name: e.target.value })}
              />
            </label>

            <div className="form-grid">
              <label className="form-label">
                Precio (Soles)
                <input
                  type="number"
                  step="0.01"
                  value={editingProduct.unitPriceCents / 100}
                  onChange={(e) =>
                    setEditingProduct({
                      ...editingProduct,
                      unitPriceCents: Math.round(Number(e.target.value) * 100) || 0,
                    })
                  }
                />
              </label>

              <label className="form-label">
                Categoría
                <select
                  value={editingProduct.categoryId || ""}
                  onChange={(e) => setEditingProduct({ ...editingProduct, categoryId: e.target.value || null })}
                >
                  <option value="">(Ninguna)</option>
                  {categories.map((c) => (
                    <option key={c.id} value={c.id}>{c.name}</option>
                  ))}
                </select>
              </label>
            </div>

            <div className="checkbox-row">
              <label className="checkbox-label">
                <input
                  type="checkbox"
                  checked={editingProduct.isWeighable}
                  onChange={(e) => setEditingProduct({ ...editingProduct, isWeighable: e.target.checked })}
                />
                ¿Se vende por peso (pesable)?
              </label>
              
              <label className="checkbox-label">
                <input
                  type="checkbox"
                  checked={editingProduct.active}
                  onChange={(e) => setEditingProduct({ ...editingProduct, active: e.target.checked })}
                />
                Producto activo
              </label>
            </div>

            {editingProduct.isWeighable ? (
              <label className="form-label">
                Código de Balanza (5 dígitos)
                <input
                  type="text"
                  maxLength={5}
                  placeholder="Ej: 20001"
                  value={editingProduct.scaleItemCode || ""}
                  onChange={(e) => setEditingProduct({ ...editingProduct, scaleItemCode: e.target.value.replace(/\D/g, "") })}
                />
              </label>
            ) : (
              <label className="form-label">
                Códigos de barra (uno por línea)
                <textarea
                  rows={3}
                  placeholder="Escribe o escanea un código..."
                  value={editingProduct.barcodes.join("\n")}
                  onChange={(e) =>
                    setEditingProduct({
                      ...editingProduct,
                      barcodes: e.target.value.split("\n"),
                    })
                  }
                />
              </label>
            )}

            <div className="modal-actions">
              <button className="modal-cancel" onClick={() => setEditingProduct(null)}>
                Cancelar
              </button>
              <button
                className="modal-save"
                onClick={() => saveProduct(editingProduct)}
                disabled={!editingProduct.name || editingProduct.unitPriceCents < 0}
              >
                Guardar
              </button>
            </div>
          </div>
        </div>
      )}

      {/* MODAL EDIT CATEGORY */}
      {editingCategory && (
        <div className="modal-backdrop">
          <div className="modal">
            <h2>{editingCategory.name ? "Editar Categoría" : "Nueva Categoría"}</h2>
            
            <label className="form-label">
              ID de Categoría (ej: `bebidas`)
              <input
                type="text"
                disabled={!!editingCategory.name}
                value={editingCategory.id}
                onChange={(e) => setEditingCategory({ ...editingCategory, id: e.target.value.toLowerCase().replace(/[^a-z0-9-_]/g, "") })}
              />
            </label>

            <label className="form-label">
              Nombre
              <input
                type="text"
                value={editingCategory.name}
                onChange={(e) => setEditingCategory({ ...editingCategory, name: e.target.value })}
              />
            </label>

            <div className="modal-actions">
              <button className="modal-cancel" onClick={() => setEditingCategory(null)}>
                Cancelar
              </button>
              <button
                className="modal-save"
                onClick={() => saveCategory(editingCategory)}
                disabled={!editingCategory.id || !editingCategory.name}
              >
                Guardar
              </button>
            </div>
          </div>
        </div>
      )}

      {/* MODAL EDIT USER */}
      {editingUser && (
        <div className="modal-backdrop">
          <div className="modal">
            <h2>{editingUser.name ? "Editar Cajero" : "Nuevo Cajero"}</h2>
            
            <label className="form-label">
              ID Cajero (ej: `cajero-2`)
              <input
                type="text"
                disabled={!!editingUser.name}
                value={editingUser.id}
                onChange={(e) => setEditingUser({ ...editingUser, id: e.target.value.toLowerCase().replace(/[^a-z0-9-_]/g, "") })}
              />
            </label>

            <label className="form-label">
              Nombre
              <input
                type="text"
                value={editingUser.name}
                onChange={(e) => setEditingUser({ ...editingUser, name: e.target.value })}
              />
            </label>

            <div className="form-grid">
              <label className="form-label">
                Rol
                <select
                  value={editingUser.role}
                  onChange={(e) => setEditingUser({ ...editingUser, role: e.target.value })}
                >
                  <option value="cashier">Cajero</option>
                  <option value="supervisor">Supervisor</option>
                  <option value="admin">Administrador</option>
                </select>
              </label>

              <label className="checkbox-label" style={{ alignSelf: "center", marginTop: "24px" }}>
                <input
                  type="checkbox"
                  checked={editingUser.active}
                  onChange={(e) => setEditingUser({ ...editingUser, active: e.target.checked })}
                />
                Usuario activo
              </label>
            </div>

            <label className="form-label">
              Modificar PIN (4 dígitos numéricos)
              <input
                type="password"
                maxLength={4}
                placeholder={editingUser.name ? "Dejar en blanco para no cambiar" : "Escribe PIN..."}
                value={editingUser.pin || ""}
                onChange={(e) => setEditingUser({ ...editingUser, pin: e.target.value.replace(/\D/g, "") })}
              />
            </label>

            <div className="modal-actions">
              <button className="modal-cancel" onClick={() => setEditingUser(null)}>
                Cancelar
              </button>
              <button
                className="modal-save"
                onClick={() => saveUser(editingUser)}
                disabled={!editingUser.id || !editingUser.name || (!editingUser.pin && !editingUser.name)}
              >
                Guardar
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}

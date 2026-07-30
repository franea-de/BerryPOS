import {
  BadRequestException,
  Body,
  Controller,
  Headers,
  Inject,
  Post,
  UnauthorizedException,
} from "@nestjs/common";
import { eq, sql } from "drizzle-orm";
import { DB } from "../sync/sync.controller.js";
import type { ApiDb } from "../db/client.js";
import { tenants, cloudSales } from "../db/schema.js";

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

@Controller("ai")
export class AiController {
  constructor(@Inject(DB) private readonly db: ApiDb) {}

  @Post("chat")
  async chat(
    @Headers("x-admin-token") token: string | undefined,
    @Body() body: any,
  ) {
    const tenantId = await this.authorize(token);
    const message = body.message;
    if (typeof message !== "string" || !message.trim()) {
      throw new BadRequestException("message es requerido");
    }

    // 1. Query today's sales data for context
    const todayStr = new Date().toISOString().split("T")[0]; // YYYY-MM-DD
    const todaySales = await this.db
      .select()
      .from(cloudSales)
      .where(
        sql`tenant_id = ${tenantId} and voided = false and occurred_at >= ${todayStr}`
      );

    let todayCents = 0;
    let salesCount = 0;
    const storeTotals: Record<string, number> = {};
    const methodCounts: Record<string, number> = {};

    for (const s of todaySales) {
      todayCents += s.totalCents;
      salesCount++;
      storeTotals[s.storeId] = (storeTotals[s.storeId] ?? 0) + s.totalCents;
      for (const m of s.paymentMethods) {
        methodCounts[m] = (methodCounts[m] ?? 0) + 1;
      }
    }

    // Query last 7 days sales
    const weekAgo = new Date();
    weekAgo.setDate(weekAgo.getDate() - 7);
    const weekAgoStr = weekAgo.toISOString().split("T")[0];
    const weekSales = await this.db
      .select()
      .from(cloudSales)
      .where(
        sql`tenant_id = ${tenantId} and voided = false and occurred_at >= ${weekAgoStr}`
      );

    let weekTotalCents = 0;
    for (const s of weekSales) {
      weekTotalCents += s.totalCents;
    }

    const storesSummary = Object.entries(storeTotals)
      .map(([id, sum]) => `${id}: ${money(sum)}`)
      .join(", ") || "Ninguna tienda con ventas hoy";

    const methodsSummary = Object.entries(methodCounts)
      .map(([m, count]) => `${METHOD_LABEL[m] ?? m} (${count} veces)`)
      .join(", ") || "Ninguno";

    // 2. Gemini integration or local fallback
    const geminiKey = process.env.GEMINI_API_KEY;
    if (geminiKey) {
      try {
        const systemPrompt = `Eres el asistente inteligente de BerryPOS, diseñado para dar soporte al administrador de la tienda. Tienes acceso a los siguientes datos de ventas en tiempo real de su negocio y al manual de soporte.

DATOS DE VENTA EN TIEMPO REAL (Hoy: ${new Date().toLocaleDateString("es-PE")}):
- Ventas totales hoy: ${money(todayCents)}
- Transacciones realizadas hoy: ${salesCount}
- Desglose por tienda: ${storesSummary}
- Métodos de pago más usados hoy: ${methodsSummary}
- Ventas acumuladas en los últimos 7 días: ${money(weekTotalCents)}

MANUAL DE SOPORTE RÁPIDO DE BERRYPOS:
- [Conectar celular para escanear]: En el móvil, abre el enlace HTTPS de Cloudflare terminado en "/movil". Inicia sesión con PIN de cajero (ej: 1111) o admin (9999). Activa "🛒 Modo Venta" arriba y escanea un producto. Entrará al carrito de la PC al instante.
- [Editar / Devolver producto / Anular venta]: Después de registrar una venta, en la confirmación verde de la PC verás el botón "✏️ Editar venta" por 30 segundos. Al pulsarlo, se anula la venta en el backend (se devuelve el stock y se ajusta la caja) y se vuelven a cargar los productos en el carrito activo para modificar cantidades o quitar ítems.
- [Abrir turno de caja]: En la PC, ve a la pestaña "Caja" del menú superior, introduce un saldo inicial en caja (ej: S/ 100.00) y pulsa "Abrir turno". El botón "Cobrar" de ventas se activará.
- [Arqueo / Reporte Z]: Ve a la pestaña "Caja", presiona "Cerrar Turno". El sistema mostrará las ventas esperadas vs. el efectivo contado y generará un reporte de cierre (Arqueo de caja).

Instrucciones de formato:
1. Responde de forma breve, atenta y profesional.
2. Usa viñetas y negrita para destacar datos importantes.
3. Si el usuario te pregunta por ventas o métodos de pago, usa obligatoriamente los DATOS DE VENTA provistos arriba.
4. Si pregunta cómo operar el sistema, usa el MANUAL DE SOPORTE.
5. Si te pide realizar acciones (ej: "crea un producto", "anula la venta #5"), explícale amablemente que como copiloto solo tienes acceso a reportes y manuales, no a editar bases de datos.

Pregunta del usuario: "${message}"`;

        const res = await fetch(
          `https://generativelanguage.googleapis.com/v1beta/models/gemini-1.5-flash:generateContent?key=${geminiKey}`,
          {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({
              contents: [
                {
                  parts: [{ text: systemPrompt }],
                },
              ],
            }),
          }
        );

        if (res.ok) {
          const data = await res.json();
          const reply = data.candidates?.[0]?.content?.parts?.[0]?.text;
          if (reply) {
            return { reply };
          }
        }
      } catch (e) {
        console.error("Error llamando a Gemini:", e);
      }
    }

    // 3. Híbrido local fallback (si no hay API Key o falla Gemini)
    const lower = message.toLowerCase();

    if (
      lower.includes("venta") ||
      lower.includes("cuánto") ||
      lower.includes("recaudado") ||
      lower.includes("total") ||
      lower.includes("hoy") ||
      lower.includes("semana") ||
      lower.includes("ganado")
    ) {
      return {
        reply: `📊 **Reporte de Ventas (Copiloto Local)**\n\n* **Ventas de hoy:** ${money(todayCents)} en **${salesCount}** transacciones.\n* **Desglose por tienda:** ${storesSummary}.\n* **Métodos de pago:** ${methodsSummary}.\n* **Últimos 7 días:** ${money(weekTotalCents)} acumulados.\n\n*Nota: El copiloto local usó consultas estructuradas de base de datos para generar este reporte.*`,
      };
    }

    if (
      lower.includes("celular") ||
      lower.includes("escanear") ||
      lower.includes("teléfono") ||
      lower.includes("móvil") ||
      lower.includes("cámara")
    ) {
      return {
        reply: `📲 **Cómo usar el celular como escáner:**\n\n1. En tu celular, entra a la dirección web del túnel de Cloudflare terminada en \`/movil\` (ej. \`https://...trycloudflare.com/movil\`).\n2. Inicia sesión con el PIN de administrador (**9999**) o cajero (**1111**).\n3. Selecciona **🛒 Modo Venta** en las pestañas superiores.\n4. Comienza a enfocar códigos de barras con la cámara del celular. ¡Los productos aparecerán en tu computadora en tiempo real!`,
      };
    }

    if (
      lower.includes("anular") ||
      lower.includes("editar") ||
      lower.includes("devolver") ||
      lower.includes("error") ||
      lower.includes("cliente ya no quiere")
    ) {
      return {
        reply: `✏️ **Cómo editar o anular una venta registrada:**\n\n* **Edición rápida:** En cuanto cobras una venta, aparece una tarjeta verde de confirmación. Tendrás **30 segundos** para presionar el botón **"✏️ Editar venta"**.\n* **¿Qué sucede al pulsar editar?** El sistema anula la venta en segundo plano (regresa el stock y resta el dinero en caja) y recarga los mismos productos en tu carrito activo. Así puedes eliminar los productos que el cliente ya no quiera y volver a cobrar con el total corregido.`,
      };
    }

    if (
      lower.includes("caja") ||
      lower.includes("abrir") ||
      lower.includes("cerrar") ||
      lower.includes("turno") ||
      lower.includes("arqueo")
    ) {
      return {
        reply: `💵 **Operaciones de Caja (Turnos):**\n\n* **Abrir caja:** Si el botón "Cobrar" está deshabilitado, ve a la pestaña **Caja** en el menú superior de la PC, introduce el monto inicial de efectivo y haz clic en **Abrir turno**.\n* **Arqueo / Cerrar caja:** Al final del día, ve a la pestaña **Caja** y pulsa **Cerrar turno**. Deberás ingresar el efectivo físico contado para verificar si hay sobrantes o faltantes en el arqueo diario.`,
      };
    }

    return {
      reply: `👋 ¡Hola! Soy tu **Copiloto BerryPOS**.\n\nComo asistente del negocio, te puedo ayudar con:\n\n1. **Reportes rápidos en lenguaje natural:** Pregúntame *"¿Cuánto he vendido hoy?"* o *"¿Cuánto acumulé esta semana?"*.\n2. **Manual de ayuda técnica:** Pregúntame *"¿Cómo conecto mi celular para escanear?"* o *"¿Cómo edito una venta?"*.\n\n*Escribe tu duda y con gusto te daré la información.*`,
    };
  }

  private async authorize(token: string | undefined): Promise<string> {
    if (!token) throw new UnauthorizedException("x-admin-token requerido");
    const [tenant] = await this.db
      .select({ id: tenants.id })
      .from(tenants)
      .where(eq(tenants.adminToken, token));
    if (!tenant) throw new UnauthorizedException("token inválido");
    return tenant.id;
  }
}

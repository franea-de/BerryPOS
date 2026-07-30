import { openPosDb } from "../src/db/connect.js";
import { PosService } from "../src/service.js";
import { sales } from "../src/db/schema.js";

const db = openPosDb("data/berrypos.sqlite");
const service = new PosService(db, { tenantId: "dev", storeId: "tienda-1", deviceId: "caja-1" }, "BerryPOS");
const allSales = db.select().from(sales).all();
if (allSales.length > 0) {
  const ticket = service.receiptTicket(allSales[allSales.length - 1].id);
  console.log("PREVIEW_START");
  console.log(ticket.text);
  console.log("PREVIEW_END");
} else {
  console.log("No sales found");
}

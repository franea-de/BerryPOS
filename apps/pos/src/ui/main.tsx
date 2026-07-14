import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import App from "./App.js";
import MobileApp from "./MobileApp.js";
import "./styles.css";

// /movil = the phone companion (camera scanning on the store LAN).
const isMobileCompanion = window.location.pathname.startsWith("/movil");

const root = document.getElementById("root");
if (!root) throw new Error("missing #root element");
createRoot(root).render(
  <StrictMode>{isMobileCompanion ? <MobileApp /> : <App />}</StrictMode>,
);

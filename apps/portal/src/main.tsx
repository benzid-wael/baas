/**
 * Entrypoint. Mirrors the service's `main.ts`: read configuration, build the
 * graph, start — and nothing else, so that everything above it is testable.
 */
import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import { App } from "./App.js";
import { ApiClient } from "./api.js";
import { readConfig } from "./config.js";

/* c8 ignore start -- browser wiring, exercised by running the app */
const root = document.getElementById("root");
if (root === null) {
  throw new Error("no #root element; index.html and main.tsx disagree");
}

createRoot(root).render(
  <StrictMode>
    <App api={new ApiClient(readConfig(import.meta.env))} />
  </StrictMode>,
);
/* c8 ignore stop */

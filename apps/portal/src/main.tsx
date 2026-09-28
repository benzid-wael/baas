/**
 * Entrypoint. Mirrors the service's `main.ts`: read configuration, build the
 * graph, start — and nothing else, so that everything above it is testable.
 */
import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import { App } from "./App.js";
import { ApiClient } from "./api.js";
import { readConfig } from "./config.js";
import { browserFlowStore } from "./oidc.js";

/* c8 ignore start -- browser wiring, exercised by running the app */
const root = document.getElementById("root");
if (root === null) {
  throw new Error("no #root element; index.html and main.tsx disagree");
}

const config = readConfig(import.meta.env);

createRoot(root).render(
  <StrictMode>
    <App
      api={new ApiClient(config)}
      config={config}
      store={browserFlowStore()}
      location={window.location}
      navigate={(url) => {
        window.location.assign(url);
      }}
      clearQuery={() => {
        // `replaceState`, not `assign`: taking the code out of the address bar
        // must not reload the page and lose the session we just obtained.
        window.history.replaceState({}, "", window.location.pathname);
      }}
    />
  </StrictMode>,
);
/* c8 ignore stop */

/**
 * What the bundler injects. Declared by hand rather than pulled from
 * `vite/client`, which also declares ambient modules for every asset type and
 * would quietly widen what this package can import.
 */
interface ImportMetaEnv {
  readonly VITE_API_BASE_URL?: string;
  readonly VITE_OIDC_ISSUER?: string;
  readonly VITE_OIDC_CLIENT_ID?: string;
}

interface ImportMeta {
  readonly env: ImportMetaEnv;
}

/// <reference types="vite/client" />

// Explicit declarations so TypeScript treats these as known properties,
// satisfying noPropertyAccessFromIndexSignature without requiring bracket notation.
interface ImportMetaEnv {
    readonly VITE_API_SERVER?: string;
}

interface ImportMeta {
    readonly env: ImportMetaEnv;
}

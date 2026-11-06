// Séparé de `shared.ts` pour qu'un module PUR (`dvf-parse.ts`) puisse lever une
// `IngestError` sans tirer le client Supabase dans sa chaîne d'import. `shared.ts`
// ré-exporte : `instanceof IngestError` reste vrai partout, c'est la même classe.

export type IngestPhase = "download" | "pre_validate" | "copy" | "validate" | "swap";

export class IngestError extends Error {
  constructor(
    public readonly phase: IngestPhase,
    message: string,
    cause?: unknown,
  ) {
    // Pass cause via Error options so engine-internal slots (Sentry,
    // util.inspect, structured loggers) read it correctly. Constructor-field
    // shadowing breaks that machinery.
    super(message, cause !== undefined ? { cause } : undefined);
    this.name = "IngestError";
  }
}

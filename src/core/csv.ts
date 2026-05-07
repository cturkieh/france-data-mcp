/**
 * Parser CSV minimaliste pour les dumps publics français (séparateur `;`,
 * encoding UTF-8 avec BOM, quotes optionnels). Volontairement sans dépendance.
 *
 * Limites : ne gère pas les retours-ligne dans les valeurs quotées (rare dans
 * les dumps gouv.fr). Si un dataset le requiert, basculer vers une lib dédiée.
 */

const BOM = "﻿";

export type CsvParseOptions = {
  /** Séparateur de champs (défaut `;`, standard FR) */
  delimiter?: string;
  /** Caractère de quotage (défaut `"`) */
  quote?: string;
};

/**
 * Parse une ligne CSV en respectant les valeurs quotées.
 * Une valeur quotée peut contenir le délimiteur sans qu'il soit interprété.
 * Les guillemets doublés `""` à l'intérieur d'une valeur quotée représentent un `"`.
 */
export function parseCsvLine(line: string, options: CsvParseOptions = {}): string[] {
  const delimiter = options.delimiter ?? ";";
  const quote = options.quote ?? '"';
  const fields: string[] = [];
  let current = "";
  let inQuotes = false;
  let i = 0;

  while (i < line.length) {
    const char = line[i];

    if (inQuotes) {
      if (char === quote) {
        if (line[i + 1] === quote) {
          current += quote;
          i += 2;
          continue;
        }
        inQuotes = false;
        i++;
        continue;
      }
      current += char;
      i++;
      continue;
    }

    if (char === quote) {
      inQuotes = true;
      i++;
      continue;
    }
    if (char === delimiter) {
      fields.push(current);
      current = "";
      i++;
      continue;
    }
    current += char;
    i++;
  }

  fields.push(current);
  return fields;
}

/**
 * Parse un CSV complet en mémoire et retourne un tableau d'objets indexés par
 * les en-têtes de la première ligne. Strip le BOM UTF-8 si présent.
 */
export function parseCsv(
  content: string,
  options: CsvParseOptions = {},
): Array<Record<string, string>> {
  const cleaned = content.startsWith(BOM) ? content.slice(BOM.length) : content;
  const lines = cleaned.split(/\r?\n/);
  const result: Array<Record<string, string>> = [];

  if (lines.length === 0) return result;
  const headers = parseCsvLine(lines[0] ?? "", options);

  for (let i = 1; i < lines.length; i++) {
    const line = lines[i];
    if (!line) continue;
    const values = parseCsvLine(line, options);
    const record: Record<string, string> = {};
    for (let j = 0; j < headers.length; j++) {
      const header = headers[j];
      if (header) record[header] = values[j] ?? "";
    }
    result.push(record);
  }

  return result;
}

/**
 * Stream un CSV ligne à ligne. Utile pour les fichiers volumineux que l'on ne
 * veut pas charger entièrement en mémoire (Annuaire Ameli ~146 Mo).
 *
 * Le générateur yield un objet par ligne de données. Le BOM et l'en-tête sont
 * gérés automatiquement.
 */
export async function* streamCsvLines(
  source: AsyncIterable<string>,
  options: CsvParseOptions = {},
): AsyncGenerator<Record<string, string>> {
  let buffer = "";
  let headers: string[] | null = null;
  let firstChunk = true;

  for await (const chunk of source) {
    const data = firstChunk && chunk.startsWith(BOM) ? chunk.slice(BOM.length) : chunk;
    firstChunk = false;
    buffer += data;
    const lines = buffer.split(/\r?\n/);
    buffer = lines.pop() ?? "";

    for (const line of lines) {
      if (!line) continue;
      if (!headers) {
        headers = parseCsvLine(line, options);
        continue;
      }
      yield rowToObject(headers, parseCsvLine(line, options));
    }
  }

  if (buffer.trim().length > 0 && headers) {
    yield rowToObject(headers, parseCsvLine(buffer, options));
  }
}

function rowToObject(headers: string[], values: string[]): Record<string, string> {
  const obj: Record<string, string> = {};
  for (let i = 0; i < headers.length; i++) {
    const header = headers[i];
    if (header) obj[header] = values[i] ?? "";
  }
  return obj;
}

/**
 * Adapte un Web ReadableStream<Uint8Array> en AsyncIterable<string> pour
 * `streamCsvLines`. Décode en UTF-8 strict (`fatal: true`) : si le dump
 * contient des octets invalides (latin-1 ou corruption), on throw au lieu de
 * silencieusement insérer des U+FFFD qui casseraient les filtres
 * insensibles à la casse sur les caractères accentués.
 */
export async function* streamReaderToStrings(
  reader: ReadableStream<Uint8Array>,
): AsyncGenerator<string> {
  const decoder = new TextDecoder("utf-8", { fatal: true });
  const r = reader.getReader();
  try {
    while (true) {
      const { done, value } = await r.read();
      if (done) {
        try {
          const final = decoder.decode();
          if (final) yield final;
        } catch (decodeErr) {
          console.error(
            `[france-data-mcp] UTF-8 decode error at end of stream: ${(decodeErr as Error).message}. Le dump n'est peut-être pas en UTF-8.`,
          );
          throw decodeErr;
        }
        break;
      }
      try {
        yield decoder.decode(value, { stream: true });
      } catch (decodeErr) {
        console.error(
          `[france-data-mcp] UTF-8 decode error in CSV stream: ${(decodeErr as Error).message}.`,
        );
        throw decodeErr;
      }
    }
  } finally {
    r.releaseLock();
  }
}

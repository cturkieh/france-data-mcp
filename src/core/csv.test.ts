import { describe, expect, it } from "vitest";
import { parseCsv, parseCsvLine, streamCsvLines } from "./csv.js";

describe("parseCsvLine", () => {
  it("parse une ligne CSV simple avec séparateur ;", () => {
    expect(parseCsvLine("a;b;c")).toEqual(["a", "b", "c"]);
  });

  it("parse les valeurs quotées contenant le délimiteur", () => {
    expect(parseCsvLine('a;"b;c";d')).toEqual(["a", "b;c", "d"]);
  });

  it("gère les guillemets doublés à l'intérieur d'une valeur quotée", () => {
    expect(parseCsvLine('a;"b ""quote"" c";d')).toEqual(["a", 'b "quote" c', "d"]);
  });

  it("renvoie des champs vides pour les délimiteurs consécutifs", () => {
    expect(parseCsvLine("a;;c")).toEqual(["a", "", "c"]);
  });

  it("supporte un séparateur custom", () => {
    expect(parseCsvLine("a,b,c", { delimiter: "," })).toEqual(["a", "b", "c"]);
  });
});

describe("parseCsv", () => {
  it("parse un CSV complet en objets indexés par en-têtes", () => {
    const csv = "nom;age\nJean;42\nMarie;33";
    expect(parseCsv(csv)).toEqual([
      { nom: "Jean", age: "42" },
      { nom: "Marie", age: "33" },
    ]);
  });

  it("strip le BOM UTF-8 si présent", () => {
    const csv = "﻿nom;age\nJean;42";
    expect(parseCsv(csv)).toEqual([{ nom: "Jean", age: "42" }]);
  });

  it("ignore les lignes vides", () => {
    const csv = "nom;age\n\nJean;42\n\n";
    expect(parseCsv(csv)).toEqual([{ nom: "Jean", age: "42" }]);
  });

  it("renvoie tableau vide si CSV vide", () => {
    expect(parseCsv("")).toEqual([]);
  });
});

describe("streamCsvLines", () => {
  it("stream les lignes en provenance d'un async iterable", async () => {
    async function* source() {
      yield "nom;age\n";
      yield "Jean;42\nMarie;33\n";
      yield "Paul;55";
    }

    const out: Array<Record<string, string>> = [];
    for await (const row of streamCsvLines(source())) {
      out.push(row);
    }
    expect(out).toEqual([
      { nom: "Jean", age: "42" },
      { nom: "Marie", age: "33" },
      { nom: "Paul", age: "55" },
    ]);
  });

  it("strip le BOM même s'il est dans le premier chunk", async () => {
    async function* source() {
      yield "﻿nom;age\nJean;42";
    }
    const out: Array<Record<string, string>> = [];
    for await (const row of streamCsvLines(source())) {
      out.push(row);
    }
    expect(out).toEqual([{ nom: "Jean", age: "42" }]);
  });

  it("ne yield pas de row fantôme sur trailing whitespace", async () => {
    // Régression : avant le fix `buffer.trim().length > 0`, un buffer composé
    // uniquement d'espaces/CR yieldait un row vide qui faussait les comptages.
    async function* source() {
      yield "nom;age\nJean;42\n   ";
    }
    const out: Array<Record<string, string>> = [];
    for await (const row of streamCsvLines(source())) {
      out.push(row);
    }
    expect(out).toEqual([{ nom: "Jean", age: "42" }]);
  });

  it("ne yield pas de row fantôme si le CSV se termine par juste \\r\\n", async () => {
    async function* source() {
      yield "nom;age\nJean;42\n\r\n";
    }
    const out: Array<Record<string, string>> = [];
    for await (const row of streamCsvLines(source())) {
      out.push(row);
    }
    expect(out).toEqual([{ nom: "Jean", age: "42" }]);
  });
});

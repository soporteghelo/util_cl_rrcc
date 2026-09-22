/**
 * Pruebas de la resolucion de nombres de hoja.
 *
 * `normalizarNombreHoja` es puro y no toca la red, asi que se puede probar
 * sin credenciales. Existe porque la pestana de personal aparece escrita de
 * las dos formas segun donde se mire: "BD AESA" en el Spreadsheet y
 * "BD_AESA" en la documentacion interna.
 */

import test from "node:test";
import assert from "node:assert/strict";

import { normalizarNombreHoja } from "../api/_lib/sheets.js";

test("un espacio y un guion bajo son la misma pestana", () => {
  const esperado = normalizarNombreHoja("BD AESA");
  assert.equal(normalizarNombreHoja("BD_AESA"), esperado);
  assert.equal(normalizarNombreHoja("bd aesa"), esperado);
  assert.equal(normalizarNombreHoja("  BD   AESA  "), esperado);
  assert.equal(normalizarNombreHoja("BD-AESA"), esperado);
});

test("no se confunden dos pestanas distintas", () => {
  assert.notEqual(normalizarNombreHoja("BD AESA"), normalizarNombreHoja("BD AESA 2"));
  assert.notEqual(normalizarNombreHoja("BD AESA"), normalizarNombreHoja("FOTOCHEK"));
  assert.notEqual(normalizarNombreHoja("BD AESA"), normalizarNombreHoja("TB_DINAMICS"));
});

test("las tildes tampoco importan", () => {
  assert.equal(normalizarNombreHoja("BD AÉSA"), normalizarNombreHoja("BD AESA"));
});

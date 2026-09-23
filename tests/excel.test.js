/**
 * Pruebas del .xlsx que se genera para exportar (ESTADO RRCC).
 *
 * Lo que se vigila aca es lo que romperia el archivo en Excel sin avisar:
 * que el DNI siga siendo TEXTO (con su cero delante), que la fecha sea una
 * fecha de verdad y no un texto, y que el libro traiga todas sus piezas.
 */

import test from "node:test";
import assert from "node:assert/strict";
import JSZip from "jszip";

import { armarXlsx } from "../src/lib/excel.js";
import { isoASerial } from "../shared/estados.js";

const COLUMNAS = [
  { titulo: "RRCC", ancho: 7 },
  { titulo: "DNI", ancho: 12 },
  { titulo: "APELLIDOS Y NOMBRES", ancho: 34 },
  { titulo: "F. VENCIMIENTO", ancho: 16, tipo: "fecha" },
  { titulo: "DIAS", ancho: 8, tipo: "numero" },
];

const FILAS = [
  ["TC", "07481337", 'ÑOÑO "AVALOS" & CIA <SAC>', "2026-09-19", -4],
  ["ES", "45229293", "GONZALES JACAY CARLOS", "", ""],
];

/** Devuelve las partes del libro ya como texto, para poder mirarlas. */
async function abrir(hojas) {
  const zip = await JSZip.loadAsync(await armarXlsx(hojas, "nodebuffer"));
  const leer = async (n) => (zip.file(n) ? zip.file(n).async("string") : null);
  return {
    zip,
    tipos: await leer("[Content_Types].xml"),
    libro: await leer("xl/workbook.xml"),
    rels: await leer("xl/_rels/workbook.xml.rels"),
    estilos: await leer("xl/styles.xml"),
    hoja1: await leer("xl/worksheets/sheet1.xml"),
    hoja2: await leer("xl/worksheets/sheet2.xml"),
  };
}

test("el libro trae todas las piezas que Excel exige", async () => {
  const x = await abrir([{ nombre: "ESTADO RRCC", columnas: COLUMNAS, filas: FILAS }]);
  for (const parte of ["[Content_Types].xml", "_rels/.rels", "xl/workbook.xml", "xl/_rels/workbook.xml.rels", "xl/styles.xml", "xl/worksheets/sheet1.xml"]) {
    assert.ok(x.zip.file(parte), `falta ${parte}`);
  }
  // la hoja y los estilos tienen que estar declarados o el libro no abre
  assert.match(x.tipos, /\/xl\/worksheets\/sheet1\.xml/);
  assert.match(x.tipos, /\/xl\/styles\.xml/);
  assert.match(x.rels, /Target="worksheets\/sheet1\.xml"/);
  assert.match(x.rels, /Target="styles\.xml"/);
  assert.match(x.libro, /<sheet name="ESTADO RRCC" sheetId="1" r:id="rId1"\/>/);
});

test("el DNI se escribe como texto: Excel no puede comerse el cero de la izquierda", async () => {
  const x = await abrir([{ nombre: "Hoja", columnas: COLUMNAS, filas: FILAS }]);
  assert.match(x.hoja1, /<c r="B2" t="inlineStr"><is><t xml:space="preserve">07481337<\/t><\/is><\/c>/);
});

test("la fecha va como serial con formato de fecha, no como texto", async () => {
  const x = await abrir([{ nombre: "Hoja", columnas: COLUMNAS, filas: FILAS }]);
  assert.match(x.hoja1, new RegExp(`<c r="D2" s="2"><v>${isoASerial("2026-09-19")}</v></c>`));
  assert.match(x.estilos, /numFmtId="164" formatCode="dd\/mm\/yyyy"/);
});

test("los numeros van como numero (se pueden ordenar y sumar)", async () => {
  const x = await abrir([{ nombre: "Hoja", columnas: COLUMNAS, filas: FILAS }]);
  assert.match(x.hoja1, /<c r="E2"><v>-4<\/v><\/c>/);
});

test("los caracteres especiales del nombre no rompen el XML", async () => {
  const x = await abrir([{ nombre: "Hoja", columnas: COLUMNAS, filas: FILAS }]);
  assert.match(x.hoja1, /ÑOÑO &quot;AVALOS&quot; &amp; CIA &lt;SAC&gt;/);
});

test("una celda vacia no se escribe, y la fila conserva su posicion", async () => {
  const x = await abrir([{ nombre: "Hoja", columnas: COLUMNAS, filas: FILAS }]);
  const fila3 = /<row r="3">(.*?)<\/row>/.exec(x.hoja1)[1];
  assert.ok(!fila3.includes('r="D3"'), "la fecha vacia no debe generar celda");
  assert.ok(!fila3.includes('r="E3"'), "los dias vacios no deben generar celda");
  assert.match(fila3, /<c r="A3"/);
});

test("la cabecera queda fija y con filtro, que es para lo que se exporta", async () => {
  const x = await abrir([{ nombre: "Hoja", columnas: COLUMNAS, filas: FILAS }]);
  assert.match(x.hoja1, /<pane ySplit="1" topLeftCell="A2"/);
  assert.match(x.hoja1, /<autoFilter ref="A1:E3"\/>/);
});

test("el nombre de hoja se limpia y no se repite: Excel rechaza ambas cosas", async () => {
  const x = await abrir([
    { nombre: "ESTADO/RRCC [2026]", columnas: COLUMNAS, filas: FILAS },
    { nombre: "ESTADO/RRCC [2026]", columnas: COLUMNAS, filas: FILAS },
  ]);
  assert.match(x.libro, /<sheet name="ESTADO RRCC  2026" sheetId="1"/);
  assert.match(x.libro, /<sheet name="ESTADO RRCC  2026 \(2\)" sheetId="2"/);
  assert.ok(x.hoja2, "la segunda hoja tiene que existir");
});

test("sin hojas no se inventa un archivo vacio", async () => {
  await assert.rejects(() => armarXlsx([]), /al menos una hoja/);
});

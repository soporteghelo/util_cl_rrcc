/**
 * Pruebas del PDF que se genera para el informe de ESTADO TOTAL.
 *
 * Un PDF roto no avisa: el lector dice "archivo dañado" y ya. Lo que se
 * vigila aqui es justo eso — que la tabla de posiciones (xref) apunte a donde
 * empieza cada objeto, que la longitud declarada de cada flujo sea la real, y
 * que los acentos salgan en WinAnsi y no como signos de interrogacion.
 */

import test from "node:test";
import assert from "node:assert/strict";

import { armarPdf, anchoTexto, recortar } from "../src/lib/pdf.js";

const BLOQUE = [
  { tipo: "cabecera", indice: 1, texto: "ÑOPO QUISPE JOSÉ", derecha: "DNI 10000003" },
  { tipo: "nota", texto: "MECANICO GENERAL I · MANTENIMIENTO · 2 vencido(s)" },
  { tipo: "grupo", texto: "A · AUTORIZACIONES VENCIDAS (1)", color: [0.66, 0.09, 0.16] },
  {
    tipo: "item",
    cols: [
      { texto: "PM", x: 18, ancho: 34, negrita: true },
      { texto: "PROTECCION DE MAQUINAS", x: 56, ancho: 230 },
      { texto: "05/09/2026", x: 292, ancho: 72 },
    ],
  },
];

async function texto(bloques, opciones = {}) {
  const blob = await armarPdf({ titulo: "ESTADO TOTAL", subtitulo: "prueba", bloques, ...opciones });
  const bytes = new Uint8Array(await blob.arrayBuffer());
  // cada byte es un caracter: el flujo va sin comprimir a proposito
  return { bytes, crudo: Array.from(bytes, (b) => String.fromCharCode(b)).join("") };
}

test("el archivo es un PDF completo, con cabecera y remate", async () => {
  const { crudo } = await texto([BLOQUE]);
  assert.match(crudo, /^%PDF-1\.4\n/);
  assert.match(crudo, /%%EOF\n$/);
  assert.match(crudo, /\/Type \/Catalog/);
  assert.match(crudo, /\/BaseFont \/Helvetica-Bold/);
});

test("cada posicion del xref cae justo donde empieza su objeto", async () => {
  const { crudo } = await texto([BLOQUE]);
  const inicio = Number(/startxref\n(\d+)\n%%EOF/.exec(crudo)[1]);
  assert.equal(crudo.slice(inicio, inicio + 4), "xref");

  const tabla = crudo.slice(inicio);
  const total = Number(/^xref\n0 (\d+)\n/.exec(tabla)[1]);
  const entradas = [...tabla.matchAll(/^(\d{10}) \d{5} n $/gm)];
  assert.equal(entradas.length, total - 1, "una entrada por objeto (el 0 es el libre)");

  entradas.forEach((m, i) => {
    const pos = Number(m[1]);
    assert.equal(crudo.slice(pos, pos + `${i + 1} 0 obj`.length), `${i + 1} 0 obj`);
  });
});

test("el /Length de cada flujo es el tamaño real del flujo", async () => {
  const { crudo } = await texto([BLOQUE]);
  const flujos = [...crudo.matchAll(/<< \/Length (\d+) >>\nstream\n([\s\S]*?)\nendstream/g)];
  assert.ok(flujos.length, "tiene que haber al menos un flujo");
  for (const [, largo, contenido] of flujos) assert.equal(contenido.length, Number(largo));
});

test("los acentos y la Ñ viajan en WinAnsi, no como '?'", async () => {
  const { bytes, crudo } = await texto([BLOQUE]);
  assert.ok(bytes.includes(0xd1), "Ñ = 0xD1");
  assert.ok(bytes.includes(0xc9), "É = 0xC9");
  assert.ok(bytes.includes(0xb7), "· = 0xB7");
  assert.ok(!crudo.includes("?OPO"), "la Ñ no debe degradarse a '?'");
});

test("los parentesis del texto se escapan: si no, cortan el literal del PDF", async () => {
  const { crudo } = await texto([[{ tipo: "nota", texto: "CARGO (INTERINO) \\ TURNO" }]]);
  assert.match(crudo, /CARGO \\\(INTERINO\\\) \\\\ TURNO/);
});

test("el informe se reparte en varias hojas y todas llevan cabecera y pie", async () => {
  const { crudo } = await texto(Array.from({ length: 60 }, () => BLOQUE));
  const hojas = [...crudo.matchAll(/\/Type \/Page /g)].length;
  assert.ok(hojas > 1, `deberia ocupar varias hojas, salieron ${hojas}`);
  assert.equal([...crudo.matchAll(/\/Count (\d+)/g)][0][1], String(hojas));
  assert.equal([...crudo.matchAll(/Página \d+ de /g)].length, hojas);
  assert.ok(crudo.includes(`Página ${hojas} de ${hojas}`));
});

test("un texto que no entra se recorta en vez de pisar la columna de al lado", () => {
  const largo = "CARGO MUY LARGO QUE NO ENTRA EN LA COLUMNA DE NINGUNA MANERA";
  const cortado = recortar(largo, 9, 80);
  assert.ok(cortado.length < largo.length);
  assert.ok(cortado.endsWith("…"));
  assert.ok(anchoTexto(cortado, 9) <= 80);
});

test("el ancho de los digitos es el de Helvetica (556/1000): el DNI cuadra a la derecha", () => {
  assert.equal(Math.round(anchoTexto("00000000", 10) * 100) / 100, 44.48);
});

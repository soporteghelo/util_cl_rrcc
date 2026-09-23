/**
 * Pruebas del PNG de informe (`src/lib/imagen.js`).
 *
 * El aspecto se revisa mirando la imagen; lo que se fija aqui es lo que no se
 * ve de un vistazo: que salgan TODAS las filas (no solo las que caben en el
 * scroll de la pantalla, que es justo lo que la imagen viene a resolver) y que
 * un informe imposible de dibujar avise en vez de devolver un PNG en blanco.
 *
 * El `<canvas>` se simula: Node no tiene lienzos, asi que se anota lo que se
 * le habria pedido dibujar.
 */

import test from "node:test";
import assert from "node:assert/strict";

import { armarPngTabla, TINTA } from "../src/lib/imagen.js";

/** Lienzo de mentira: apunta cada texto dibujado y devuelve un PNG simbolico. */
function lienzoSimulado() {
  const textos = [];
  const ctx = {
    textos,
    canvas: null,
    set font(_v) {},
    get font() {
      return "";
    },
    textAlign: "left",
    textBaseline: "alphabetic",
    fillStyle: "",
    strokeStyle: "",
    lineWidth: 1,
    scale() {},
    fillRect() {},
    beginPath() {},
    rect() {},
    roundRect() {},
    fill() {},
    stroke() {},
    moveTo() {},
    lineTo() {},
    measureText: (t) => ({ width: String(t).length * 7 }), // ~7 px por caracter
    fillText: (t) => textos.push(String(t)),
  };

  const canvas = {
    width: 0,
    height: 0,
    getContext: () => ctx,
    toBlob: (cb) => cb({ tipo: "image/png", tamano: 1 }),
  };
  ctx.canvas = canvas;

  global.document = { createElement: () => canvas };
  return { ctx, canvas };
}

const COLUMNAS = [
  { titulo: "DNI", ancho: 92, valor: (f) => f.dni },
  { titulo: "Nombre", ancho: 300, valor: (f) => f.nombre },
  { titulo: "Vencidos", ancho: 95, valor: (f) => f.vencidos, pastilla: () => TINTA.rojo },
];

const gente = (n) =>
  Array.from({ length: n }, (_, i) => ({ dni: String(10000000 + i), nombre: `PERSONA ${i}`, vencidos: i % 5 }));

test("dibuja todas las filas, no solo las que caben en pantalla", async () => {
  const { ctx, canvas } = lienzoSimulado();
  const filas = gente(240);

  await armarPngTabla({ titulo: "ESTADO TOTAL", columnas: COLUMNAS, filas });

  for (const f of filas) {
    assert.ok(ctx.textos.includes(f.dni), `falta el DNI ${f.dni}`);
    assert.ok(ctx.textos.includes(f.nombre), `falta ${f.nombre}`);
  }
  // el lienzo crece con las filas: 240 filas no caben en el alto de una pantalla
  assert.ok(canvas.height > 240 * 30, "el lienzo tiene que dar para todas las filas");
});

test("el titulo, las tarjetas y el pie salen en la imagen", async () => {
  const { ctx } = lienzoSimulado();

  await armarPngTabla({
    titulo: "ESTADO TOTAL · RRCC VENCIDOS POR PERSONA",
    subtitulo: "34 persona(s) · al 23/09/2026",
    tarjetas: [
      { numero: 34, rotulo: "personas vencidas" },
      { numero: 94, rotulo: "RRCC vencidos", color: TINTA.rojo },
    ],
    columnas: COLUMNAS,
    filas: gente(3),
    pie: "AESA · U.M. Cerro Lindo",
  });

  assert.ok(ctx.textos.includes("ESTADO TOTAL · RRCC VENCIDOS POR PERSONA"));
  assert.ok(ctx.textos.includes("34 persona(s) · al 23/09/2026"));
  assert.ok(ctx.textos.includes("34") && ctx.textos.includes("94"));
  assert.ok(ctx.textos.includes("PERSONAS VENCIDAS"), "el rotulo de la tarjeta va en mayusculas");
  assert.ok(ctx.textos.includes("AESA · U.M. Cerro Lindo"));
  assert.ok(ctx.textos.includes("DNI") && ctx.textos.includes("NOMBRE"), "la cabecera va en mayusculas");
});

test("lo que no entra en su columna se recorta con puntos suspensivos", async () => {
  const { ctx } = lienzoSimulado();
  const largo = "SUPERVISOR DE OPERACIONES MINA CON UN CARGO INTERMINABLE QUE NO ENTRA";

  await armarPngTabla({ titulo: "X", columnas: COLUMNAS, filas: [{ dni: "1", nombre: largo, vencidos: 0 }] });

  const pintado = ctx.textos.find((t) => t.startsWith("SUPERVISOR"));
  assert.ok(pintado.endsWith("…"));
  assert.ok(pintado.length < largo.length);
});

test("un informe demasiado alto avisa en vez de devolver un PNG en blanco", async () => {
  lienzoSimulado();
  // Chrome no crea lienzos de mas de ~32.700 px: por encima devuelve uno vacio
  await assert.rejects(
    () => armarPngTabla({ titulo: "X", columnas: COLUMNAS, filas: gente(3000) }),
    /filtra un poco/
  );
});

test("sin columnas no se intenta dibujar nada", async () => {
  lienzoSimulado();
  await assert.rejects(() => armarPngTabla({ titulo: "X", columnas: [], filas: [] }), /necesita columnas/);
});

/**
 * Pruebas del filtrado del desplegable de cargos y areas. No tocan el DOM.
 */

import test from "node:test";
import assert from "node:assert/strict";

import { filtrarOpciones, normalizarBusqueda, resaltar } from "../src/vistas/autocompletar.js";

const CARGOS = [
  "AYUDANTE DE OPERADOR DE EQUIPOS",
  "MAESTRO DE OPERACIONES MINA",
  "MAESTRO DE SERVICIOS MINA",
  "OPERADOR DE JUMBO EMPERNADOR I",
  "OPERADOR DE CAMION CISTERNA",
  "NUÑEZ - SUPERVISOR",
  "TECNICO MECANICO",
];

test("normalizarBusqueda ignora tildes, mayusculas y signos", () => {
  assert.equal(normalizarBusqueda("  Núñez - Supervisor  "), "NUNEZ SUPERVISOR");
  assert.equal(normalizarBusqueda(null), "");
});

test("sin texto salen todas las opciones, en su orden", () => {
  assert.deepEqual(filtrarOpciones(CARGOS, ""), CARGOS);
  assert.deepEqual(filtrarOpciones(CARGOS, "   "), CARGOS);
});

test("filtra mientras se escribe, sin importar tildes ni mayusculas", () => {
  assert.deepEqual(filtrarOpciones(CARGOS, "nunez"), ["NUÑEZ - SUPERVISOR"]);
  assert.deepEqual(filtrarOpciones(CARGOS, "maes"), ["MAESTRO DE SERVICIOS MINA", "MAESTRO DE OPERACIONES MINA"].sort((a, b) => a.length - b.length));
  assert.deepEqual(filtrarOpciones(CARGOS, "tecnico m"), ["TECNICO MECANICO"]);
});

test("las palabras se pueden escribir en cualquier orden", () => {
  const r = filtrarOpciones(CARGOS, "mina maestro");
  assert.deepEqual(r.sort(), ["MAESTRO DE OPERACIONES MINA", "MAESTRO DE SERVICIOS MINA"]);
  assert.deepEqual(filtrarOpciones(CARGOS, "cisterna operador"), ["OPERADOR DE CAMION CISTERNA"]);
});

test("una palabra a medias tambien encuentra: 'oper' saca todo lo que tiene OPERADOR u OPERACIONES", () => {
  const r = filtrarOpciones(CARGOS, "oper");
  assert.ok(r.includes("MAESTRO DE OPERACIONES MINA"));
  assert.ok(r.includes("OPERADOR DE JUMBO EMPERNADOR I"));
  assert.ok(!r.includes("TECNICO MECANICO"));
});

test("lo que empieza por lo escrito va antes que lo que solo lo contiene", () => {
  const r = filtrarOpciones(CARGOS, "operador");
  assert.equal(r[0].startsWith("OPERADOR"), true, "los que empiezan por OPERADOR primero");
  assert.equal(r[r.length - 1], "AYUDANTE DE OPERADOR DE EQUIPOS", "el que lo lleva en medio, al final");
});

test("una subcadena dentro de una palabra encuentra en ultimo lugar", () => {
  const r = filtrarOpciones(CARGOS, "canico");
  assert.deepEqual(r, ["TECNICO MECANICO"]);
});

test("sin coincidencias devuelve una lista vacia", () => {
  assert.deepEqual(filtrarOpciones(CARGOS, "xyz"), []);
  assert.deepEqual(filtrarOpciones([], "a"), []);
});

test("resaltar marca las palabras escritas, con tildes y sin romper el HTML", () => {
  assert.equal(resaltar("MAESTRO DE OPERACIONES MINA", "mina maes"), "<mark>MAES</mark>TRO DE OPERACIONES <mark>MINA</mark>");
  assert.equal(resaltar("NUÑEZ", "nunez"), "<mark>NUÑEZ</mark>");
  assert.equal(resaltar("A & B <C>", "b"), "A &amp; <mark>B</mark> &lt;C&gt;");
  assert.equal(resaltar("MINA", ""), "MINA");
});

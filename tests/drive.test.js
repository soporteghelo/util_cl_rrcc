/**
 * Pruebas de la fuente de respaldo en Drive (PDF por RRCC con el nombre
 * `<DNI>_<CODIGO>_<AAAA-MM-DD>_<NOMBRE>.pdf`). No tocan la red.
 */

import test from "node:test";
import assert from "node:assert/strict";

import { carpetasRespaldo, itemsDeArchivos, itemsDeInduccion, sinRespaldoInnecesario } from "../api/_lib/drive.js";
import { construirDiccionario, elegirCertificados, esArchivoDePersona } from "../shared/estados.js";

const dic = construirDiccionario([]);
const archivo = (id, name) => ({ id, name });

test("las carpetas se leen de ids sueltos o de URLs, separados por coma", () => {
  assert.deepEqual(carpetasRespaldo("abc123, def456"), ["abc123", "def456"]);
  assert.deepEqual(
    carpetasRespaldo("https://drive.google.com/drive/folders/1xiaiApVUp_KSdQXRaDOfftSYVR?usp=sharing;1nMUOhCHZ"),
    ["1xiaiApVUp_KSdQXRaDOfftSYVR", "1nMUOhCHZ"]
  );
  assert.deepEqual(carpetasRespaldo(""), []);
  assert.deepEqual(carpetasRespaldo(undefined), []);
});

test("un nombre valido da un item con codigo, curso y fecha del nombre", () => {
  const [it] = itemsDeArchivos([archivo("f1", "46041028_TA_2026-03-20_ANLAS JANAMPA ELIO YODY.pdf")], "46041028");
  assert.equal(it.codigo, "TA");
  assert.equal(it.fecha, "2026-03-20");
  assert.equal(it.curso, "TRABAJO EN ALTURA");
  assert.equal(it.origen, "DRIVE");
  assert.equal(it.respaldo, true);
  assert.equal(it.descargable, true);
  assert.equal(it.id, "f1");
});

test("los nombres con Ñ, minusculas en el codigo y el resto de nombre libre tambien valen", () => {
  const its = itemsDeArchivos(
    [archivo("a", "42649293_SQ_2025-08-12_ÑAÑEZ FLORES JOHN FRANK.pdf"), archivo("b", "42649293_es_2025-08-13_x.PDF")],
    "42649293"
  );
  assert.deepEqual(its.map((i) => i.codigo), ["SQ", "ES"]);
});

test("solo pasa el documento EXACTO: 'contains' de Drive trae subcadenas", () => {
  const its = itemsDeArchivos(
    [archivo("a", "146041028_TA_2026-03-20_OTRO.pdf"), archivo("b", "46041028_TA_2026-03-20_BIEN.pdf")],
    "46041028"
  );
  assert.deepEqual(its.map((i) => i.id), ["b"]);
});

test("se descartan nombres que no siguen la convencion o con un codigo que no existe", () => {
  const its = itemsDeArchivos(
    [
      archivo("a", "46041028_ZZ_2026-03-20_X.pdf"),
      archivo("b", "46041028_TA_20-03-2026_X.pdf"),
      archivo("c", "46041028_ANLAS JANAMPA.pdf"),
      archivo("d", "46041028_TA_2026-03-20_X.docx"),
    ],
    "46041028"
  );
  assert.deepEqual(its, []);
});

test("el respaldo entra donde JOMISER no trae el riesgo y no compite por fecha donde si", () => {
  const items = [
    { curso: "TRABAJOS EN ALTURA", origen: "JOMISER", fecha: "2026-01-10", descargable: true, id: "1" },
    // mas nuevo que el de JOMISER, pero JOMISER ya tiene TA: no se usa
    { id: "d1", codigo: "TA", curso: "TRABAJO EN ALTURA", origen: "DRIVE", respaldo: true, fecha: "2026-05-01", descargable: true },
    // JOMISER no trae SQ: aqui si
    { id: "d2", codigo: "SQ", curso: "SUSTANCIAS QUIMICAS PELIGROSAS", origen: "DRIVE", respaldo: true, fecha: "2026-02-02", descargable: true },
  ];
  const r = elegirCertificados(items, dic);
  assert.equal(r.porRrcc.get("TA").origen, "JOMISER");
  assert.equal(r.porRrcc.get("TA").fecha, "2026-01-10");
  assert.equal(r.porRrcc.get("SQ").origen, "DRIVE");
  assert.equal(r.porRrcc.get("SQ").id, "d2");
  assert.equal(r.noMapeados.length, 0);
});

test("si JOMISER lista el riesgo pero sin certificado descargable, se usa el de Drive", () => {
  const items = [
    { curso: "TRABAJOS EN ALTURA", origen: "JOMISER", fecha: "2026-01-10", descargable: false, id: null },
    { id: "d1", codigo: "TA", curso: "TRABAJO EN ALTURA", origen: "DRIVE", respaldo: true, fecha: "2026-05-01", descargable: true },
  ];
  const r = elegirCertificados(items, dic);
  assert.equal(r.porRrcc.get("TA").origen, "DRIVE");
  assert.equal(r.porRrcc.get("TA").descargable, true);
});

test("entre varios de Drive del mismo riesgo gana el mas reciente", () => {
  const drive = (id, fecha) => ({ id, codigo: "PM", curso: "PROTECCION DE MAQUINAS", origen: "DRIVE", respaldo: true, fecha, descargable: true });
  const r = elegirCertificados([drive("a", "2025-08-10"), drive("b", "2026-03-05"), drive("c", "2025-12-01")], dic);
  assert.equal(r.porRrcc.get("PM").id, "b");
});

test("el archivo consolidado por persona de Drive sigue sin tomarse por un curso", () => {
  const r = elegirCertificados([{ curso: "46041028_ANLAS JANAMPA ELIO YODY", origen: "DRIVE", descargable: true, id: "x" }], dic);
  assert.equal(r.personales.length, 1);
  assert.equal(r.noMapeados.length, 0);
});

test("la busqueda no lista el respaldo de un riesgo que JOMISER ya cubre, y si el de los demas", () => {
  const items = [
    { curso: "TRABAJOS EN ALTURA", origen: "JOMISER", fecha: "2026-01-10", descargable: true },
    { curso: "SISTEMAS PRESURIZADOS", origen: "JOMISER", fecha: "2026-01-11", descargable: false }, // listado sin certificado
    { codigo: "TA", origen: "DRIVE", respaldo: true, id: "d1", descargable: true },
    { codigo: "SP", origen: "DRIVE", respaldo: true, id: "d2", descargable: true },
    { codigo: "SQ", origen: "DRIVE", respaldo: true, id: "d3", descargable: true },
  ];
  const filtrados = sinRespaldoInnecesario(items);
  assert.deepEqual(filtrados.filter((i) => i.respaldo).map((i) => i.codigo).sort(), ["SP", "SQ"]);
  assert.equal(filtrados.filter((i) => !i.respaldo).length, 2, "los de JOMISER se conservan");
});

test("induccion: un archivo <DNI>_<NOMBRE>.pdf da un item con el anio de su subcarpeta", () => {
  const its = itemsDeInduccion(
    [{ id: "f1", name: "47887396_URIOL MACUYAMA MAURO GHERSON.pdf", parents: ["c2026"] }],
    "47887396",
    (id) => ({ c2026: "2026" })[id] || ""
  );
  assert.equal(its.length, 1);
  assert.equal(its[0].origen, "INDUCCION");
  assert.equal(its[0].curso, "REINDUCCIÓN 2026");
  assert.equal(its[0].detalle, "2026");
  assert.equal(its[0].descargable, true);
  assert.equal(its[0].archivo, "47887396_URIOL MACUYAMA MAURO GHERSON.pdf");
});

test("induccion: sin subcarpeta el curso es solo REINDUCCIÓN, y el documento se compara sin ceros iniciales", () => {
  const its = itemsDeInduccion(
    [
      { id: "a", name: "4086358_BERROSPI FRETEL ANGEL ARMANDO.pdf", parents: ["raiz"] },
      { id: "b", name: "04086358_OTRA COPIA.pdf", parents: ["raiz"] },
      { id: "c", name: "14086358_OTRO DOCUMENTO.pdf", parents: ["raiz"] },
      { id: "d", name: "04086358 - sin guion bajo.pdf", parents: ["raiz"] },
    ],
    "04086358"
  );
  assert.deepEqual(its.map((i) => i.id), ["a", "b", "d"]);
  assert.equal(its[0].curso, "REINDUCCIÓN");
});

test("induccion: los nombres que no empiezan con un documento no cuentan", () => {
  assert.deepEqual(itemsDeInduccion([{ id: "x", name: "LISTA GENERAL.pdf", parents: [] }], "47887396"), []);
});

test("un item de induccion es un archivo de persona y nunca un curso sin mapear", () => {
  assert.equal(esArchivoDePersona({ origen: "INDUCCION", curso: "REINDUCCIÓN 2026" }), true);
  assert.equal(esArchivoDePersona({ origen: "DRIVE", curso: "47887396_ALGO" }), true, "el formato anterior sigue valiendo");
  assert.equal(esArchivoDePersona({ origen: "DRIVE", curso: "TRABAJO EN ALTURA", respaldo: true }), false);
  const r = elegirCertificados([{ origen: "INDUCCION", curso: "REINDUCCIÓN 2026", descargable: true, id: "1" }], dic);
  assert.equal(r.personales.length, 1);
  assert.equal(r.noMapeados.length, 0);
  assert.equal(r.porRrcc.size, 0);
});

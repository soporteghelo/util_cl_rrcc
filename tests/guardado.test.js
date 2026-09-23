/**
 * Pruebas del guardado verificado y del reintento ante respuestas rotas de
 * Apps Script. `fetch` se simula: no tocan la red.
 */

import test from "node:test";
import assert from "node:assert/strict";

import { diferenciasFila, leerFila } from "../shared/estados.js";
import { CABECERA, colCap, colVenc, colTipo, INDICE } from "../shared/rrcc.js";
import { pedirAppsScript } from "../api/_lib/apps-script.js";
import { guardarFilaVerificada } from "../src/lib/renovacion.js";
import { cargarImagen } from "../src/lib/fotocheck.js";
import { normalizarCambiosPendientes } from "../src/vistas/renovacion.js";

process.env.APPS_SCRIPT_URL = "https://script.example/exec";
process.env.APPS_SCRIPT_REINTENTO_MS = "0";

const filaVacia = () => CABECERA.map(() => "");
const respuesta = (cuerpo, estado = 200) => ({
  ok: estado >= 200 && estado < 300,
  status: estado,
  text: async () => (typeof cuerpo === "string" ? cuerpo : JSON.stringify(cuerpo)),
});
const PAGINA_404 = "<html><body>No se encontró la página Drive No se pudo abrir el archivo en este momento</body></html>";

async function conFetch(simulado, fn) {
  const real = globalThis.fetch;
  globalThis.fetch = simulado;
  try {
    return await fn();
  } finally {
    globalThis.fetch = real;
  }
}

/* ---- comparacion de filas ---- */

test("diferenciasFila: lo que la hoja tiene igual a lo pedido no da diferencias, aunque la fecha llegue como instante de Apps Script", () => {
  const pedida = filaVacia();
  pedida[colTipo("TA")] = "A";
  pedida[colCap("TA")] = "2026-01-10";
  pedida[colVenc("TA")] = "2027-01-10";
  const leida = filaVacia();
  leida[colTipo("TA")] = "a";
  leida[colCap("TA")] = "2026-01-10T07:00:00.000Z";
  leida[colVenc("TA")] = "2027-01-10T07:00:00.000Z";
  assert.deepEqual(diferenciasFila(pedida, leida, ["TA"]), []);
});

test("diferenciasFila: un riesgo vaciado tiene que quedar vacio en la hoja", () => {
  const pedida = filaVacia(); // TA sin tipo ni fechas
  const leida = filaVacia();
  leida[colTipo("TA")] = "A";
  leida[colCap("TA")] = "2026-01-10T07:00:00.000Z";
  const dif = diferenciasFila(pedida, leida, ["TA"]);
  assert.deepEqual(dif.map((d) => d.campo).sort(), ["capacitacion", "tipo"]);
  assert.equal(dif.find((d) => d.campo === "tipo").real, "A");
  assert.deepEqual(diferenciasFila(pedida, leida, ["CS"]), [], "solo se miran los riesgos indicados");
});

/* ---- reintento de Apps Script ---- */

test("Apps Script: una respuesta rota (pagina 404) se reintenta y la siguiente que si es JSON gana", async () => {
  const respuestas = [respuesta(PAGINA_404, 404), respuesta("", 200), respuesta({ ok: true, fila: 12 })];
  let llamadas = 0;
  await conFetch(async () => respuestas[llamadas++], async () => {
    const r = await pedirAppsScript("sheets", { accion: "guardar" });
    assert.equal(r.fila, 12);
    assert.equal(llamadas, 3);
  });
});

test("Apps Script: si todos los intentos vienen rotos el error queda marcado como ambiguo", async () => {
  let llamadas = 0;
  await conFetch(async () => (llamadas++, respuesta(PAGINA_404, 404)), async () => {
    await assert.rejects(pedirAppsScript("sheets", { accion: "guardar" }), (e) => {
      assert.equal(e.ambiguo, true);
      assert.match(e.message, /No se encontró la página/);
      return true;
    });
    assert.equal(llamadas, 3);
  });
});

test("Apps Script: un error que SI viene en JSON es real y no se reintenta", async () => {
  let llamadas = 0;
  await conFetch(async () => (llamadas++, respuesta({ ok: false, error: "no existe la hoja BD_AESA" })), async () => {
    await assert.rejects(pedirAppsScript("sheets", { accion: "guardar" }), /no existe la hoja/);
    assert.equal(llamadas, 1);
  });
});

const HELLO_DOGET = { ok: true, servicio: "RRCC Apps Script", version: 1 };

test('Apps Script: el "hello" fijo de doGet en vez de la respuesta pedida se reintenta y la siguiente que si contesta gana', async () => {
  // Pasa cuando dos pedidos casi simultaneos saturan el Web App: llega HTTP
  // 200 con JSON valido, pero es el "hello" de doGet, no lo que se pidio.
  const respuestas = [respuesta(HELLO_DOGET), respuesta({ ok: true, fila: 12 })];
  let llamadas = 0;
  await conFetch(async () => respuestas[llamadas++], async () => {
    const r = await pedirAppsScript("sheets", { accion: "guardar" });
    assert.equal(r.fila, 12);
    assert.equal(llamadas, 2);
  });
});

test('Apps Script: si todos los intentos devuelven el "hello" de doGet, el error queda marcado como ambiguo', async () => {
  let llamadas = 0;
  await conFetch(async () => (llamadas++, respuesta(HELLO_DOGET)), async () => {
    await assert.rejects(pedirAppsScript("sheets", { accion: "listado" }), (e) => {
      assert.equal(e.ambiguo, true);
      assert.match(e.message, /hello.*doGet/);
      return true;
    });
    assert.equal(llamadas, 3);
  });
});

/* ---- presupuesto de tiempo del puente ---- */

/** Un Apps Script que nunca contesta: se rinde solo cuando aborta la señal. */
const nuncaContesta = (opciones) =>
  new Promise((_, rechazar) => {
    opciones.signal.addEventListener("abort", () => rechazar(opciones.signal.reason));
  });

test("Apps Script: si no contesta, el puente se rinde dentro de su presupuesto y no espera al corte de Vercel", async () => {
  // Sin esto la funcion se pasa del maxDuration y quien responde es la red de
  // Vercel, con un 504 en HTML: en pantalla queda "respuesta ilegible (HTTP 504)".
  process.env.APPS_SCRIPT_PRESUPUESTO_MS = "150";
  const empezo = Date.now();
  let llamadas = 0;
  try {
    await conFetch(async (_url, opciones) => (llamadas++, nuncaContesta(opciones)), async () => {
      await assert.rejects(pedirAppsScript("sheets", { accion: "listado" }), (e) => {
        assert.equal(e.ambiguo, true, "pudo haberse ejecutado igual: quien escribe debe verificar");
        assert.match(e.message, /no respondió a tiempo a "sheets:listado"/);
        return true;
      });
    });
  } finally {
    delete process.env.APPS_SCRIPT_PRESUPUESTO_MS;
  }
  assert.equal(llamadas, 1, "no arranca un intento que ya no cabe en el presupuesto");
  assert.ok(Date.now() - empezo < 1000, "se rinde en el presupuesto, no cuando lo corten desde afuera");
});

test("Apps Script: una demora que se come el presupuesto no impide aprovechar la respuesta que si llega", async () => {
  process.env.APPS_SCRIPT_PRESUPUESTO_MS = "2000";
  let llamadas = 0;
  try {
    await conFetch(async () => (llamadas++, respuesta({ ok: true, personas: [] })), async () => {
      const r = await pedirAppsScript("sheets", { accion: "listado" });
      assert.deepEqual(r.personas, []);
    });
  } finally {
    delete process.env.APPS_SCRIPT_PRESUPUESTO_MS;
  }
  assert.equal(llamadas, 1);
});

/* ---- guardarFilaVerificada: se simula /api/sheets ---- */

/** `comportamiento(cuerpo)` devuelve lo que responde el servidor, o un Error para un HTTP 502. */
const apiSimulada = (comportamiento) => async (ruta, opciones) => {
  const salida = await comportamiento(JSON.parse(opciones.body));
  if (salida instanceof Error) return { ok: false, status: 502, headers: new Map(), json: async () => ({ error: salida.message }) };
  return { ok: true, status: 200, headers: new Map(), json: async () => salida };
};

function persona() {
  const f = filaVacia();
  f[INDICE["DNI"]] = "04086358";
  return f;
}

test("guardado verificado: se guarda, se relee y se confirma", async () => {
  const pedida = persona();
  await conFetch(
    apiSimulada((b) => (b.accion === "guardar" ? { ok: true, fila: 300 } : { encontrada: true, fila: 300, valores: pedida })),
    async () => {
      const g = await guardarFilaVerificada({ fila: 300, valores: pedida, dni: "04086358", codigos: ["CS"] });
      assert.equal(g.confirmado, true);
      assert.equal(g.recuperado, false);
      assert.equal(g.fila, 300);
    }
  );
});

test("guardado verificado: si Google devuelve una respuesta rota pero la hoja ya lo tiene, cuenta como guardado", async () => {
  const pedida = persona();
  pedida[colTipo("TA")] = "A";
  pedida[colCap("TA")] = "2026-01-10";
  await conFetch(
    apiSimulada((b) => (b.accion === "guardar" ? new Error("No se encontró la página Drive") : { encontrada: true, fila: 300, valores: pedida })),
    async () => {
      const g = await guardarFilaVerificada({ fila: 300, valores: pedida, dni: "04086358", codigos: ["TA"] });
      assert.equal(g.confirmado, true);
      assert.equal(g.recuperado, true);
    }
  );
});

test("guardado verificado: si falla y la hoja sigue igual que antes, se avisa el error original", async () => {
  const pedida = persona();
  pedida[colTipo("TA")] = "A";
  const antes = persona();
  await conFetch(
    apiSimulada((b) => (b.accion === "guardar" ? new Error("No se encontró la página Drive") : { encontrada: true, fila: 300, valores: antes })),
    async () => {
      await assert.rejects(guardarFilaVerificada({ fila: 300, valores: pedida, dni: "04086358", codigos: ["TA"] }), /No se encontró la página Drive/);
    }
  );
});

test("guardado verificado: si se guarda pero la hoja no muestra lo pedido, no se confirma y se listan las diferencias", async () => {
  const pedida = persona();
  pedida[colTipo("TA")] = "A";
  pedida[colCap("TA")] = "2026-01-10";
  const enHoja = persona(); // la hoja se quedo con TA vacio (p. ej. celda protegida por formula)
  await conFetch(
    apiSimulada((b) => (b.accion === "guardar" ? { ok: true, fila: 300 } : { encontrada: true, fila: 300, valores: enHoja })),
    async () => {
      const g = await guardarFilaVerificada({ fila: 300, valores: pedida, dni: "04086358", codigos: ["TA"] });
      assert.equal(g.confirmado, false);
      assert.ok(g.diferencias.some((d) => d.codigo === "TA" && d.campo === "tipo"));
      assert.equal(leerFila(g.valores).riesgos.find((r) => r.codigo === "TA").tipo, "", "devuelve la fila como esta en la hoja");
    }
  );
});

test("guardado verificado: la persona en otra fila no se da por confirmada", async () => {
  const pedida = persona();
  await conFetch(
    apiSimulada((b) => (b.accion === "guardar" ? { ok: true, fila: 300 } : { encontrada: true, fila: 301, valores: pedida })),
    async () => {
      await assert.rejects(guardarFilaVerificada({ fila: 300, valores: pedida, dni: "04086358", codigos: ["TA"] }), /fila esperada/);
    }
  );
});

/* ---- columnas de datos personales (EMO y area) ---- */

import { escribirDatosPersonales } from "../api/_lib/sheets.js";

test("diferenciasFila compara el vencimiento del EMO como fecha y el area como texto", () => {
  const pedida = filaVacia();
  pedida[INDICE["F. Vencimiento"]] = "2027-01-15";
  pedida[INDICE["Area Planilla"]] = "MINA";
  const igual = filaVacia();
  igual[INDICE["F. Vencimiento"]] = "2027-01-15T07:00:00.000Z";
  igual[INDICE["Area Planilla"]] = " MINA ";
  assert.deepEqual(diferenciasFila(pedida, igual, [], ["F. Vencimiento", "Area Planilla"]), []);

  const distinta = filaVacia();
  distinta[INDICE["F. Vencimiento"]] = "2026-10-03T07:00:00.000Z";
  const dif = diferenciasFila(pedida, distinta, [], ["F. Vencimiento", "Area Planilla"]);
  assert.deepEqual(dif.map((d) => d.codigo).sort(), ["AREA", "EMO"]);
  assert.equal(dif.find((d) => d.codigo === "EMO").real, "2026-10-03");
  assert.deepEqual(diferenciasFila(pedida, distinta, [], []), [], "sin pedir esas columnas no se comparan");
});

test("guardado verificado con EMO y area: se envian en `datos` y se confirman al releer", async () => {
  const pedida = persona();
  pedida[INDICE["F. Vencimiento"]] = "2027-01-15";
  pedida[INDICE["Area Planilla"]] = "MINA";
  let enviado = null;
  await conFetch(
    apiSimulada((b) => {
      if (b.accion === "guardar") {
        enviado = b;
        return { ok: true, fila: 300, formulaReemplazada: ["F. Vencimiento"] };
      }
      return { encontrada: true, fila: 300, valores: pedida };
    }),
    async () => {
      const g = await guardarFilaVerificada({
        fila: 300, valores: pedida, dni: "04086358", codigos: [],
        datos: { "F. Vencimiento": "2027-01-15", "Area Planilla": "MINA" },
      });
      assert.equal(g.confirmado, true);
      assert.deepEqual(g.formulaReemplazada, ["F. Vencimiento"]);
      assert.deepEqual(enviado.datos, { "F. Vencimiento": "2027-01-15", "Area Planilla": "MINA" });
    }
  );
});

test("guardado verificado: si la hoja no aplico el EMO (script sin actualizar) se avisa con la diferencia", async () => {
  const pedida = persona();
  pedida[INDICE["F. Vencimiento"]] = "2027-01-15";
  const enHoja = persona();
  enHoja[INDICE["F. Vencimiento"]] = "2026-10-03T07:00:00.000Z";
  await conFetch(
    apiSimulada((b) => (b.accion === "guardar" ? { ok: true, fila: 300 } : { encontrada: true, fila: 300, valores: enHoja })),
    async () => {
      const g = await guardarFilaVerificada({ fila: 300, valores: pedida, dni: "04086358", codigos: [], datos: { "F. Vencimiento": "2027-01-15" } });
      assert.equal(g.confirmado, false);
      assert.deepEqual(g.diferencias.map((d) => [d.codigo, d.esperado, d.real]), [["EMO", "2027-01-15", "2026-10-03"]]);
    }
  );
});

test("normalizarCambiosPendientes limpia el estado pendiente cuando la hoja ya tiene el valor guardado con formato de Apps Script", () => {
  const ficha = {
    valores: persona(),
    ediciones: { TA: { tipo: "a", venc: "2027-01-15T07:00:00.000Z" } },
    datosEdit: { emoVenc: "2027-01-15", area: " MINA " },
  };

  const res = normalizarCambiosPendientes(ficha, {
    baseRiesgo: () => ({ tipo: "A", venc: "2027-01-15" }),
    baseDatos: () => ({ emoVenc: "2027-01-15T07:00:00.000Z", area: "MINA" }),
  });

  assert.equal(res.cambios, 0);
  assert.deepEqual(ficha.ediciones, {});
  assert.deepEqual(ficha.datosEdit, {});
});

test("cargarImagen acepta blobs para que el fotocheck no quede sin foto", async () => {
  const originalImage = globalThis.Image;
  const hechos = [];
  globalThis.Image = class {
    constructor() {
      this.crossOrigin = "";
      this.onload = null;
      this.onerror = null;
      this._src = "";
      hechos.push(this);
    }
    set src(valor) {
      this._src = valor;
      queueMicrotask(() => {
        if (typeof this.onload === "function") this.onload();
      });
    }
    get src() {
      return this._src;
    }
  };

  try {
    const blob = new Blob(["abc"], { type: "image/png" });
    const img = await cargarImagen(blob);
    assert.ok(img);
    assert.match(img.src, /^blob:/);
  } finally {
    globalThis.Image = originalImage;
  }
});

test("la API de Sheets rechaza una columna no editable antes de llamar a Google", async () => {
  await assert.rejects(escribirDatosPersonales(12, { DNI: "1" }), /columna no editable/);
  await assert.rejects(escribirDatosPersonales(12, { "F. Vencimiento": "2027-01-15", Guardia: "X" }), /columna no editable/);
});

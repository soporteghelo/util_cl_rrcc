/**
 * Pruebas del almacen compartido (`src/lib/datos.js`): que una consulta hecha
 * desde una pestana le sirva a las demas, que no salgan dos pedidos iguales a
 * la vez, y que lo que se guarda se refleje en todas sin volver a bajar nada.
 *
 * `fetch` se simula: no tocan la red.
 */

import test from "node:test";
import assert from "node:assert/strict";

import { CABECERA, INDICE } from "../shared/rrcc.js";
import { leerFila } from "../shared/estados.js";
import {
  obtenerContexto,
  obtenerPersonal,
  obtenerPersona,
  obtenerCatalogo,
  precargar,
  personalEnMemoria,
  anotarPersona,
  alCambiar,
  invalidar,
} from "../src/lib/datos.js";

/* ------------------------------------------------------------------ */
/* Utilidades                                                          */
/* ------------------------------------------------------------------ */

function fila({ dni, nombres = "ANA", apellidos = "PEREZ", estado = "VIGENTE", activo = "ACTIVO", cargo = "OPERADOR", area = "MINA" }) {
  const f = CABECERA.map(() => "");
  f[INDICE["DNI"]] = dni;
  f[INDICE["Nombres"]] = nombres;
  f[INDICE["Apellidos"]] = apellidos;
  f[INDICE["ESTADO_FINAL"]] = estado;
  f[INDICE["_EstaTE"]] = activo;
  f[INDICE["Cargo Planilla"]] = cargo;
  f[INDICE["Area Planilla"]] = area;
  return f;
}

/**
 * Lo que devuelve `accion: "listado"`: la fila ya leida, no la fila cruda.
 * `accion: "persona"` en cambio si manda `valores` crudos, que es lo que
 * necesita el motor para recalcular.
 */
const persona = (datos) => leerFila(fila(datos));

/** Espera a que salgan los avisos de listado, que van agrupados (ESPERA_AVISO). */
const reposo = () => new Promise((r) => setTimeout(r, 250));

/** Cuenta los pedidos y contesta segun la accion pedida. */
function espiaFetch(porAccion) {
  const pedidos = [];
  const simulado = async (_ruta, opciones) => {
    const cuerpo = JSON.parse(opciones.body);
    pedidos.push(cuerpo);
    const respuesta = porAccion[cuerpo.accion];
    const datos = typeof respuesta === "function" ? await respuesta(cuerpo) : respuesta;
    return { ok: true, status: 200, json: async () => datos };
  };
  return { simulado, pedidos, cuantos: (accion) => pedidos.filter((p) => p.accion === accion).length };
}

async function conFetch(simulado, fn) {
  const real = globalThis.fetch;
  globalThis.fetch = simulado;
  invalidar(); // cada prueba arranca sin nada guardado
  try {
    return await fn();
  } finally {
    globalThis.fetch = real;
    invalidar();
  }
}

/* ------------------------------------------------------------------ */
/* Una sola consulta para todas las pestanas                           */
/* ------------------------------------------------------------------ */

test("el contexto se pide una sola vez aunque lo pidan varias pestanas a la vez", async () => {
  const espia = espiaFetch({ contexto: { config: { UMBRAL_VENCIDO: 365 }, cursos: [], matriz: [] } });
  await conFetch(espia.simulado, async () => {
    const [a, b] = await Promise.all([obtenerContexto(), obtenerContexto()]);
    const c = await obtenerContexto(); // ya cacheado

    assert.equal(espia.cuantos("contexto"), 1);
    assert.equal(a, b); // la misma promesa compartida, no dos respuestas distintas
    assert.equal(a, c);
    assert.equal(a.config.UMBRAL_VENCIDO, 365);
  });
});

test("dos pestanas que piden el listado a la vez disparan un solo pedido", async () => {
  const espia = espiaFetch({ listado: { personas: [] } });
  await conFetch(espia.simulado, async () => {
    await Promise.all([obtenerPersonal(), obtenerPersonal(), obtenerPersonal()]);
    assert.equal(espia.cuantos("listado"), 1);
  });
});

test("el listado filtrado sale del completo que ya cargo otra pestana, sin tocar la red", async () => {
  const personas = [
    persona({ dni: "11111111", estado: "VENCIDO", activo: "ACTIVO" }),
    persona({ dni: "22222222", estado: "VIGENTE", activo: "ACTIVO" }),
    persona({ dni: "33333333", estado: "VENCIDO", activo: "CESADO" }),
  ];
  const espia = espiaFetch({ listado: ({ filtro }) => ({ personas: filtro ? [] : personas }) });

  await conFetch(espia.simulado, async () => {
    const completo = await obtenerPersonal();
    assert.equal(completo.length, 3);

    const vencidos = await obtenerPersonal({ filtro: "vencidos_activos" });
    assert.equal(espia.cuantos("listado"), 1, "no debe salir un segundo pedido");
    assert.deepEqual(
      vencidos.map((p) => p.dni),
      ["11111111"]
    );
  });
});

test("un listado filtrado NO hace de listado completo: quien lo necesite entero lo pide", async () => {
  const espia = espiaFetch({
    listado: ({ filtro }) => ({
      personas: filtro
        ? [persona({ dni: "11111111", estado: "VENCIDO" })]
        : [persona({ dni: "11111111" }), persona({ dni: "22222222" })],
    }),
  });

  await conFetch(espia.simulado, async () => {
    const filtrado = await obtenerPersonal({ filtro: "vencidos_activos" });
    assert.equal(filtrado.length, 1);
    assert.equal(personalEnMemoria(), null, "lo filtrado no puede pasar por completo");

    const completo = await obtenerPersonal();
    assert.equal(completo.length, 2);
    assert.equal(espia.cuantos("listado"), 2);
  });
});

test("el backend filtra, pero si devuelve de mas el filtro se vuelve a aplicar aca", async () => {
  // un Apps Script viejo ignora `filtro` y contesta con todo el mundo
  const espia = espiaFetch({
    listado: () => ({ personas: [persona({ dni: "11111111", estado: "VENCIDO" }), persona({ dni: "22222222", estado: "VIGENTE" })] }),
  });
  await conFetch(espia.simulado, async () => {
    const lista = await obtenerPersonal({ filtro: "vencidos_activos" });
    assert.deepEqual(
      lista.map((p) => p.dni),
      ["11111111", "22222222"],
      "obtenerPersonal devuelve lo que llego: filtrarlo de nuevo es cosa de la vista"
    );
  });
});

test("refrescar salta lo guardado y vuelve a preguntarle a la hoja", async () => {
  let vuelta = 0;
  const espia = espiaFetch({ listado: () => ({ personas: [persona({ dni: "11111111", nombres: `ANA${++vuelta}` })] }) });
  await conFetch(espia.simulado, async () => {
    const primera = await obtenerPersonal();
    const cacheada = await obtenerPersonal();
    assert.equal(espia.cuantos("listado"), 1);
    assert.equal(primera, cacheada);

    const recargada = await obtenerPersonal({ refrescar: true });
    assert.equal(espia.cuantos("listado"), 2);
    assert.equal(recargada[0].nombres, "ANA2");
  });
});

/* ------------------------------------------------------------------ */
/* Una persona                                                         */
/* ------------------------------------------------------------------ */

test("la fila de una persona se cachea, y `refrescar` la vuelve a leer", async () => {
  const espia = espiaFetch({
    persona: ({ dni }) => ({ encontrada: true, dni, fila: 7, valores: fila({ dni }) }),
  });
  await conFetch(espia.simulado, async () => {
    await obtenerPersona("11111111");
    await obtenerPersona("11111111");
    assert.equal(espia.cuantos("persona"), 1);

    await obtenerPersona("11111111", { refrescar: true });
    assert.equal(espia.cuantos("persona"), 2);

    await obtenerPersona("22222222");
    assert.equal(espia.cuantos("persona"), 3, "otra persona es otra lectura");
  });
});

/* ------------------------------------------------------------------ */
/* Una escritura se ve en todas las pestanas                           */
/* ------------------------------------------------------------------ */

test("guardar una fila parchea el listado compartido y avisa a las vistas", async () => {
  const espia = espiaFetch({
    listado: () => ({ personas: [persona({ dni: "11111111", cargo: "OPERADOR" }), persona({ dni: "22222222" })] }),
  });

  await conFetch(espia.simulado, async () => {
    const antes = await obtenerPersonal();
    assert.equal(antes[0].cargo, "OPERADOR");

    const avisos = [];
    const baja = alCambiar((ev) => avisos.push(ev));

    anotarPersona({ dni: "11111111", fila: 5, valores: fila({ dni: "11111111", cargo: "SUPERVISOR" }) });
    await reposo(); // el aviso de listado se agrupa: no sale en el mismo tick
    baja();

    const despues = personalEnMemoria();
    assert.equal(espia.cuantos("listado"), 1, "no se vuelve a bajar el listado por un guardado");
    assert.equal(despues[0].cargo, "SUPERVISOR");
    assert.equal(despues.length, 2);
    assert.notEqual(despues, antes, "lista nueva: las vistas comparan por identidad para repintar");

    // la persona va al instante; el listado, agrupado y despues
    assert.deepEqual(
      avisos.map((a) => a.tipo),
      ["persona", "personal"]
    );
    assert.equal(avisos[0].dni, "11111111");
    assert.equal(avisos[0].fila, 5);
    assert.equal(avisos[1].origen, "escritura");
    assert.equal(avisos[1].personas, despues);
  });
});

test("varios guardados seguidos dan UN solo aviso de listado, no uno por persona", async () => {
  const espia = espiaFetch({ listado: () => ({ personas: [persona({ dni: "11111111" }), persona({ dni: "22222222" })] }) });
  await conFetch(espia.simulado, async () => {
    await obtenerPersonal();
    const avisos = [];
    const baja = alCambiar((ev) => ev.tipo === "personal" && avisos.push(ev));

    // una renovacion en lote: sin agrupar, cada una repintaria 600 filas
    for (const dni of ["11111111", "22222222"]) {
      anotarPersona({ dni, fila: 5, valores: fila({ dni, cargo: "SUPERVISOR" }) });
    }
    await reposo();
    baja();

    assert.equal(avisos.length, 1);
    assert.deepEqual(
      avisos[0].personas.map((p) => p.cargo),
      ["SUPERVISOR", "SUPERVISOR"],
      "el aviso unico trae ya los dos cambios"
    );
  });
});

test("un alta entra en el listado completo que ya estaba cargado", async () => {
  const espia = espiaFetch({ listado: () => ({ personas: [persona({ dni: "11111111" })] }) });
  await conFetch(espia.simulado, async () => {
    await obtenerPersonal();
    anotarPersona({ dni: "99999999", fila: 40, valores: fila({ dni: "99999999", apellidos: "NUEVO" }) });

    const lista = personalEnMemoria();
    assert.equal(lista.length, 2);
    assert.equal(lista[1].dni, "99999999");
  });
});

test("sobre un listado filtrado, un alta no se inventa una persona que el filtro no trajo", async () => {
  const espia = espiaFetch({ listado: () => ({ personas: [persona({ dni: "11111111", estado: "VENCIDO" })] }) });
  await conFetch(espia.simulado, async () => {
    await obtenerPersonal({ filtro: "vencidos_activos" });
    anotarPersona({ dni: "99999999", fila: 40, valores: fila({ dni: "99999999" }) });

    const lista = await obtenerPersonal({ filtro: "vencidos_activos" });
    assert.deepEqual(
      lista.map((p) => p.dni),
      ["11111111"]
    );
  });
});

test("la persona guardada queda como la version buena: la siguiente lectura no va a la hoja", async () => {
  const espia = espiaFetch({ persona: ({ dni }) => ({ encontrada: true, dni, fila: 7, valores: fila({ dni }) }) });
  await conFetch(espia.simulado, async () => {
    anotarPersona({ dni: "11111111", fila: 7, valores: fila({ dni: "11111111", cargo: "SUPERVISOR" }) });
    const leida = await obtenerPersona("11111111");

    assert.equal(espia.cuantos("persona"), 0);
    assert.equal(leida.datos.cargo, "SUPERVISOR");
    assert.equal(leida.fila, 7);
  });
});

/* ------------------------------------------------------------------ */
/* Catalogo de cargos y areas                                          */
/* ------------------------------------------------------------------ */

test("los cargos y areas salen del listado ya cargado en vez de pedirlos aparte", async () => {
  const espia = espiaFetch({
    listado: () => ({
      personas: [
        persona({ dni: "11111111", cargo: "OPERADOR", area: "MINA" }),
        persona({ dni: "22222222", cargo: "CAPATAZ", area: "MINA" }),
      ],
    }),
    cargos: { cargos: ["NO DEBERIA"], areas: ["NO DEBERIA"] },
  });

  await conFetch(espia.simulado, async () => {
    await obtenerPersonal();
    const catalogo = await obtenerCatalogo();

    assert.equal(espia.cuantos("cargos"), 0);
    assert.deepEqual(catalogo.cargos, ["CAPATAZ", "OPERADOR"]);
    assert.deepEqual(catalogo.areas, ["MINA"]);
  });
});

test("sin listado cargado, el catalogo se le pide al backend una sola vez", async () => {
  const espia = espiaFetch({ cargos: { cargos: ["OPERADOR"], areas: ["MINA"] } });
  await conFetch(espia.simulado, async () => {
    const [a, b] = await Promise.all([obtenerCatalogo(), obtenerCatalogo()]);
    assert.equal(espia.cuantos("cargos"), 1);
    assert.deepEqual(a.cargos, ["OPERADOR"]);
    assert.equal(a, b);
  });
});

/* ------------------------------------------------------------------ */
/* Fallos                                                              */
/* ------------------------------------------------------------------ */

test("un pedido fallido no se queda cacheado: el siguiente reintenta", async () => {
  let intento = 0;
  const simulado = async (_ruta, opciones) => {
    JSON.parse(opciones.body);
    intento++;
    if (intento === 1) return { ok: false, status: 502, json: async () => ({ error: "Apps Script no respondio" }) };
    return { ok: true, status: 200, json: async () => ({ personas: [] }) };
  };

  await conFetch(simulado, async () => {
    await assert.rejects(() => obtenerPersonal(), /no respondio/);
    const lista = await obtenerPersonal();
    assert.deepEqual(lista, []);
    assert.equal(intento, 2);
  });
});

/* ------------------------------------------------------------------ */
/* Precarga al abrir la pagina                                         */
/* ------------------------------------------------------------------ */

test("al arrancar se deja lista la base: contexto y listado completo", async () => {
  const espia = espiaFetch({
    contexto: { config: {}, cursos: [], matriz: [] },
    listado: () => ({ personas: [persona({ dni: "11111111" }), persona({ dni: "22222222" })] }),
  });

  await conFetch(espia.simulado, async () => {
    const r = await precargar();
    assert.equal(r.error, null);
    assert.equal(r.personas.length, 2);

    // y a partir de ahi ninguna vista vuelve a pedir nada
    await obtenerContexto();
    await obtenerPersonal();
    await obtenerPersonal({ filtro: "vencidos_activos" });
    assert.equal(espia.cuantos("contexto"), 1);
    assert.equal(espia.cuantos("listado"), 1);
  });
});

test("la precarga no tumba la app cuando no hay configuracion de Google", async () => {
  const simulado = async () => ({ ok: false, status: 500, json: async () => ({ error: "falta GOOGLE_SHEET_ID" }) });
  await conFetch(simulado, async () => {
    const r = await precargar(); // no debe lanzar: la extraccion de certificados no pasa por Sheets
    assert.equal(r.contexto, null);
    assert.match(r.error.message, /GOOGLE_SHEET_ID/);
  });
});

test("el listado precargado tambien sirve el catalogo: no sale un pedido de cargos", async () => {
  const espia = espiaFetch({
    contexto: { config: {}, cursos: [], matriz: [] },
    listado: () => ({ personas: [persona({ dni: "11111111", cargo: "OPERADOR", area: "MINA" })] }),
    cargos: { cargos: ["NO DEBERIA"], areas: ["NO DEBERIA"] },
  });

  await conFetch(espia.simulado, async () => {
    // el catalogo se pide MIENTRAS el listado sigue en el aire, como al arrancar
    const precarga = precargar();
    const catalogo = await obtenerCatalogo();
    await precarga;

    assert.equal(espia.cuantos("cargos"), 0);
    assert.deepEqual(catalogo.cargos, ["OPERADOR"]);
  });
});

/* ------------------------------------------------------------------ */
/* Prioridad: la precarga cede el turno                                */
/* ------------------------------------------------------------------ */

test("un pedido del usuario se adelanta a la precarga que sigue esperando turno", async () => {
  const orden = [];
  let soltarPrimero;
  const primero = new Promise((r) => (soltarPrimero = r));

  const simulado = async (_ruta, opciones) => {
    const { accion } = JSON.parse(opciones.body);
    orden.push(accion);
    // el primer pedido (contexto) se queda en el aire a proposito: con el
    // ocupado, los otros dos se ponen en fila y se ve cual sale antes
    if (accion === "contexto") await primero;
    return {
      ok: true,
      status: 200,
      json: async () => (accion === "contexto" ? { config: {}, cursos: [], matriz: [] } : accion === "listado" ? { personas: [] } : { encontrada: false }),
    };
  };

  await conFetch(simulado, async () => {
    const contexto = obtenerContexto(); // ocupa la cola
    await new Promise((r) => setTimeout(r, 10));

    const precarga = obtenerPersonal({ fondo: true }); // se encola en el carril de fondo
    const usuario = obtenerPersona("11111111"); // llega DESPUES, pero es del usuario

    soltarPrimero();
    await Promise.all([contexto, precarga, usuario]);

    assert.deepEqual(orden, ["contexto", "persona", "listado"], "la precarga va ultima aunque se pidio antes");
  });
});

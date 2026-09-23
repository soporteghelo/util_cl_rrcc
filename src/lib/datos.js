/**
 * Almacen compartido de la base (`BD AESA`).
 *
 * Todas las pestanas leen lo mismo de Google Sheets: el "contexto" (CONFIG +
 * diccionario de cursos + matriz por puesto), el listado de personal y la
 * fila de una persona. Antes cada vista lo pedia por su cuenta: abrir ESTADO
 * RRCC y despues ESTADO TOTAL bajaba DOS veces a las 600+ personas de la hoja
 * (~1.5 MB y varios segundos cada vez) y cada pestana volvia a pedir el
 * contexto aunque otra ya lo tuviera.
 *
 * Aca se pide UNA vez y se reparte:
 *
 *   - lo traido queda guardado con su hora; mientras siga fresco se reutiliza
 *     sin tocar la red;
 *   - dos vistas que piden lo mismo a la vez comparten la MISMA promesa, asi
 *     que sale un solo pedido (importante porque `api.js` pone en fila todo
 *     lo que habla con Apps Script: dos pedidos son el doble de espera);
 *   - el listado filtrado ("vencidos_activos") se saca del listado completo
 *     sin red cuando ese ya esta en memoria, y al reves nunca: un listado
 *     filtrado no puede hacer de completo;
 *   - cuando se ESCRIBE (guardar / alta) se parchea lo guardado con la fila
 *     nueva y se avisa a todas las vistas montadas, que repintan con el dato
 *     actualizado sin volver a bajar nada.
 *
 * Los pedidos compartidos van SIN `AbortSignal` a proposito: son lecturas
 * cortas e idempotentes que varias vistas estan esperando, y el "cancelar" de
 * una de ellas no puede tumbarle el pedido a las demas. Quien cancela deja de
 * esperar; el pedido termina y queda cacheado para el siguiente. La excepcion
 * es la lectura de UNA persona (`obtenerPersona`), que sale del bucle de
 * renovacion y si se cancela de verdad.
 */

import { sheets } from "./api.js";
import { construirDiccionario, leerFila, normalizarDocumento } from "../../shared/estados.js";

/** Cuanto vale lo guardado antes de volver a preguntarle a la hoja (ms). */
export const VIDA = {
  contexto: 15 * 60 * 1000, // CONFIG y matriz casi nunca cambian durante una sesion
  personal: 5 * 60 * 1000, // la hoja la editan otros: 5 min es el compromiso
  persona: 60 * 1000, // solo para lecturas; lo que va a escribir pide fresco
  catalogo: 30 * 60 * 1000,
};

/** Ultimo listado traido con exito, para pintar algo al instante la proxima
    vez mientras llega el real. Leer 600+ personas de Apps Script tarda varios
    segundos y sin esto la pantalla se queda en blanco todo ese rato. */
const CLAVE_SNAPSHOT = "rrcc.base.personal";
const CLAVE_SNAPSHOT_VIEJA = "rrcc.estado.snapshot"; // la que usaba solo ESTADO RRCC
const CLAVE_CATALOGO = "rrcc.catalogo";

/* ------------------------------------------------------------------ */
/* Aviso a las vistas                                                  */
/* ------------------------------------------------------------------ */

const oyentes = new Set();

/**
 * Se entera de todo cambio en lo compartido. Devuelve la funcion para darse
 * de baja. El evento es `{ tipo, ... }`:
 *
 *   { tipo: "personal", personas, completo, origen }  listado nuevo o parcheado
 *   { tipo: "persona", dni, fila, datos, valores }    una fila guardada
 *   { tipo: "contexto", contexto }                    CONFIG/matriz nuevos
 *   { tipo: "vaciado" }                               se tiro todo lo guardado
 */
export function alCambiar(fn) {
  oyentes.add(fn);
  return () => oyentes.delete(fn);
}

function avisar(evento) {
  // copia: un oyente puede darse de baja mientras se reparte el aviso
  for (const fn of [...oyentes]) {
    try {
      fn(evento);
    } catch {
      /* una vista rota no puede dejar sin aviso a las demas */
    }
  }
}

/**
 * Los avisos de "el listado cambio" se juntan antes de repartirlos.
 *
 * Una renovacion en lote guarda persona por persona, y cada guardado parchea
 * la lista: sin agrupar, las dos vistas de estado repintarian sus 600 filas y
 * se reserializaria 1.5 MB al navegador UNA VEZ POR PERSONA. Con la espera,
 * un lote de 50 personas se pinta unas pocas veces.
 */
const ESPERA_AVISO = 150;
let avisoPendiente = null;

function avisarPersonalPronto(origen) {
  if (avisoPendiente) {
    avisoPendiente.origen = origen;
    return;
  }
  avisoPendiente = { origen };
  setTimeout(() => {
    const motivo = avisoPendiente?.origen;
    avisoPendiente = null;
    const e = cache.personal;
    if (!Array.isArray(e.valor)) return;
    guardarSnapshot(e.valor, e.completo, contextoEnMemoria()?.config);
    avisar({ tipo: "personal", personas: e.valor, completo: e.completo, origen: motivo });
  }, ESPERA_AVISO);
}

/* ------------------------------------------------------------------ */
/* Motor de cache                                                      */
/* ------------------------------------------------------------------ */

const cache = {
  contexto: { valor: null, ts: 0, enVuelo: null },
  // `prometida`: el listado completo que la precarga del arranque ya se
  // comprometio a traer, aunque todavia no haya salido el pedido
  personal: { valor: null, ts: 0, enVuelo: null, completo: false, prometida: null },
  catalogo: { valor: null, ts: 0, enVuelo: null },
};

/** Filas de persona por DNI: { [dni]: { valor, ts } }. */
const personas = new Map();

const fresco = (entrada, vida) => entrada.valor !== null && Date.now() - entrada.ts < vida;

/**
 * Devuelve lo guardado si sigue fresco; si no, lo pide UNA vez y hace que
 * todos los que lo esten esperando compartan esa misma promesa.
 */
function memo(entrada, vida, traer, { refrescar = false } = {}) {
  if (!refrescar && fresco(entrada, vida)) return Promise.resolve(entrada.valor);
  if (entrada.enVuelo) return entrada.enVuelo; // ya lo esta pidiendo otra vista

  const promesa = (async () => {
    const valor = await traer();
    entrada.valor = valor;
    entrada.ts = Date.now();
    return valor;
  })();

  entrada.enVuelo = promesa;
  // un fallo no debe quedar cacheado: se limpia para que el siguiente reintente
  promesa.then(
    () => {
      if (entrada.enVuelo === promesa) entrada.enVuelo = null;
    },
    () => {
      if (entrada.enVuelo === promesa) entrada.enVuelo = null;
    }
  );
  return promesa;
}

/* ------------------------------------------------------------------ */
/* Snapshot en el navegador                                            */
/* ------------------------------------------------------------------ */

function leerSnapshot() {
  for (const clave of [CLAVE_SNAPSHOT, CLAVE_SNAPSHOT_VIEJA]) {
    try {
      const datos = JSON.parse(localStorage.getItem(clave));
      if (Array.isArray(datos?.personas)) {
        return {
          personas: datos.personas,
          config: datos.config || {},
          // la clave vieja guardaba siempre el listado completo
          completo: clave === CLAVE_SNAPSHOT_VIEJA ? true : datos.completo !== false,
          ts: Number(datos.ts) || 0,
        };
      }
    } catch {
      /* cache invalido o sin almacenamiento: se ignora */
    }
  }
  return null;
}

function guardarSnapshot(lista, completo, config) {
  // un listado filtrado no representa a la hoja: guardarlo haria que la
  // proxima sesion arrancara creyendo que la empresa tiene 30 personas
  if (!completo) return;
  try {
    localStorage.setItem(
      CLAVE_SNAPSHOT,
      JSON.stringify({ ts: Date.now(), completo: true, config: config || {}, personas: lista })
    );
  } catch {
    /* localStorage lleno o no disponible: solo se pierde el atajo */
  }
}

/**
 * El ultimo listado COMPLETO guardado en este navegador, o `null`.
 * Sirve para pintar algo mientras llega el de verdad; no cuenta como cache
 * en memoria y por eso no lo devuelve `obtenerPersonal`.
 */
export function personalGuardado() {
  const snap = leerSnapshot();
  return snap?.completo ? snap : null;
}

/* ------------------------------------------------------------------ */
/* Contexto: CONFIG + cursos + matriz                                  */
/* ------------------------------------------------------------------ */

/** CONFIG, diccionario de cursos y matriz por puesto, en una sola llamada. */
export function obtenerContexto({ refrescar = false } = {}) {
  return memo(
    cache.contexto,
    VIDA.contexto,
    async () => {
      const datos = await sheets({ accion: "contexto" });
      const ctx = {
        config: datos.config || {},
        matriz: datos.matriz || [],
        cursos: datos.cursos || [],
        diccionario: construirDiccionario(datos.cursos || []),
      };
      avisar({ tipo: "contexto", contexto: ctx });
      return ctx;
    },
    { refrescar }
  );
}

/** El contexto que ya este en memoria, sin pedir nada. `null` si no hay. */
export const contextoEnMemoria = () => (fresco(cache.contexto, VIDA.contexto) ? cache.contexto.valor : null);

/* ------------------------------------------------------------------ */
/* Listado de personal                                                 */
/* ------------------------------------------------------------------ */

const norm = (valor) => String(valor ?? "").trim().toUpperCase();

/**
 * Mismo criterio que el filtro `vencidos_activos` del backend, pero sobre el
 * objeto ya leido: es lo que permite servir la vista ESTADO TOTAL desde el
 * listado completo que cargo ESTADO RRCC, sin tocar la red.
 */
const FILTROS = {
  vencidos_activos: (p) => norm(p.estadoFinal) === "VENCIDO" && norm(p.estadoTrabajador) === "ACTIVO",
};

/**
 * Todo el personal de `BD AESA`, o el subconjunto que pida `filtro`.
 *
 * - sin `filtro`: hace falta el listado completo;
 * - con `filtro`: si el completo esta en memoria se filtra aca (gratis); si
 *   no, se le pide filtrado al backend, que es lo que evita bajar 1.5 MB para
 *   mostrar unas pocas decenas de personas. Un backend viejo que no reconozca
 *   el filtro lo ignora y devuelve a todo el mundo, por eso se vuelve a
 *   filtrar aca igual.
 *
 * `fondo: true` lo manda por el carril de precarga de `api.js`, que le cede el
 * turno a cualquier cosa que pida el usuario mientras tanto.
 */
export async function obtenerPersonal({ filtro = "", refrescar = false, fondo = false } = {}) {
  const aplicar = FILTROS[filtro];
  const e = cache.personal;

  if (!refrescar && fresco(e, VIDA.personal)) {
    if (e.completo) return aplicar ? e.valor.filter(aplicar) : e.valor;
    // lo guardado esta filtrado: solo sirve si se pide exactamente ese filtro
    if (aplicar && e.filtro === filtro) return e.valor;
  }
  // otra vista ya esta pidiendo lo mismo (o algo que sirve): se comparte
  if (!refrescar && e.enVuelo && (e.enVueloCompleto || e.enVueloFiltro === filtro)) {
    const lista = await e.enVuelo;
    return aplicar && e.enVueloCompleto ? lista.filter(aplicar) : lista;
  }

  const completo = !filtro;
  const promesa = (async () => {
    const datos = await sheets({ accion: "listado", filtro: filtro || undefined }, undefined, { fondo });
    const lista = datos.personas || [];
    e.valor = lista;
    e.ts = Date.now();
    e.completo = completo;
    e.filtro = filtro;
    guardarSnapshot(lista, completo, contextoEnMemoria()?.config);
    avisar({ tipo: "personal", personas: lista, completo, origen: "hoja" });
    return lista;
  })();

  e.enVuelo = promesa;
  e.enVueloCompleto = completo;
  e.enVueloFiltro = filtro;
  const limpiar = () => {
    if (e.enVuelo === promesa) e.enVuelo = null;
  };
  promesa.then(limpiar, limpiar);

  const lista = await promesa;
  return aplicar && completo ? lista.filter(aplicar) : lista;
}

/**
 * El listado que ya este en memoria y sirva para `filtro`, sin pedir nada.
 * Devuelve `null` si no hay; es lo que usa una vista al montarse para
 * aprovechar lo que ya cargo otra pestana.
 */
export function personalEnMemoria(filtro = "") {
  const e = cache.personal;
  if (!fresco(e, VIDA.personal)) return null;
  const aplicar = FILTROS[filtro];
  if (e.completo) return aplicar ? e.valor.filter(aplicar) : e.valor;
  return aplicar && e.filtro === filtro ? e.valor : null;
}

/** Hora (ms) del ultimo listado traido de la hoja, o 0. */
export const edadPersonal = () => cache.personal.ts;

/* ------------------------------------------------------------------ */
/* Una persona                                                         */
/* ------------------------------------------------------------------ */

const clavePersona = (dni) => normalizarDocumento(String(dni ?? "").trim());

/**
 * La fila de una persona: `{ encontrada, dni, fila, valores, datos }`.
 *
 * `refrescar: true` salta el cache. Lo usa todo lo que va a ESCRIBIR sobre esa
 * fila: recalcular y guardar encima de una copia vieja pisaria lo que otro
 * haya editado en la hoja mientras tanto.
 */
export async function obtenerPersona(dni, { refrescar = false, senal } = {}) {
  const clave = clavePersona(dni);
  if (!clave) return { encontrada: false, dni: clave };

  const guardado = personas.get(clave);
  if (!refrescar && guardado && Date.now() - guardado.ts < VIDA.persona) return guardado.valor;

  const registro = await sheets({ accion: "persona", dni: clave }, senal);
  personas.set(clave, { valor: registro, ts: Date.now() });
  return registro;
}

/* ------------------------------------------------------------------ */
/* Catalogo de cargos y areas                                          */
/* ------------------------------------------------------------------ */

const distintos = (valores) => [...new Set(valores.map((v) => String(v ?? "").trim()).filter(Boolean))].sort();

/**
 * Cargos y areas que ya existen en `BD AESA`, para los desplegables.
 *
 * Si el listado completo esta en memoria salen de ahi sin tocar la red; si no,
 * se le piden al backend (`accion: "cargos"`, que lee solo esas dos columnas).
 * La ultima respuesta queda en el navegador para que el desplegable no salga
 * vacio mientras Apps Script contesta.
 */
export function obtenerCatalogo({ refrescar = false } = {}) {
  const deLaLista = (lista) => {
    const catalogo = { cargos: distintos(lista.map((p) => p.cargo)), areas: distintos(lista.map((p) => p.area)) };
    cache.catalogo.valor = catalogo;
    cache.catalogo.ts = Date.now();
    guardarCatalogo(catalogo);
    return catalogo;
  };

  const enMemoria = personalEnMemoria();
  if (enMemoria?.length) return Promise.resolve(deLaLista(enMemoria));

  // El listado completo ya viene en camino (la precarga del arranque): sale mas
  // a cuenta esperarlo que pedir las dos columnas por separado, porque Apps
  // Script atiende de a uno y ese pedido extra retrasaria al que ya esta en la
  // fila. Si el listado falla, se cae al pedido normal.
  const e = cache.personal;
  const enCamino = (e.enVuelo && e.enVueloCompleto && e.enVuelo) || e.prometida;
  if (!refrescar && enCamino) {
    return enCamino.then(
      (lista) => (lista?.length ? deLaLista(lista) : pedirCatalogo({ refrescar })),
      () => pedirCatalogo({ refrescar })
    );
  }

  return pedirCatalogo({ refrescar });
}

function pedirCatalogo({ refrescar }) {

  return memo(
    cache.catalogo,
    VIDA.catalogo,
    async () => {
      const catalogo = await sheets({ accion: "cargos" });
      const limpio = { cargos: catalogo.cargos || [], areas: catalogo.areas || [] };
      guardarCatalogo(limpio);
      return limpio;
    },
    { refrescar }
  );
}

/** El ultimo catalogo conocido (memoria o navegador), sin pedir nada. */
export function catalogoGuardado() {
  if (cache.catalogo.valor) return cache.catalogo.valor;
  try {
    const c = JSON.parse(localStorage.getItem(CLAVE_CATALOGO));
    return Array.isArray(c?.cargos) && Array.isArray(c?.areas) ? c : null;
  } catch {
    return null;
  }
}

function guardarCatalogo(catalogo) {
  try {
    localStorage.setItem(CLAVE_CATALOGO, JSON.stringify(catalogo));
  } catch {
    /* sin almacenamiento solo se pierde el atajo */
  }
}

/* ------------------------------------------------------------------ */
/* Precarga al abrir la pagina                                         */
/* ------------------------------------------------------------------ */

/**
 * Deja la base lista apenas se abre la app, para que ninguna pestana tenga que
 * esperar a Sheets cuando el usuario llegue a ella.
 *
 * Se trae primero el contexto (pequeno, y lo necesitan RENOVACION y NUEVO
 * PERSONAL para arrancar) y despues el listado completo, que es lo pesado y va
 * por el carril de fondo: mientras espera turno, cualquier cosa que pida el
 * usuario se le adelanta.
 *
 * No lanza: sin configuracion de Google esto falla y la app tiene que seguir
 * sirviendo igual para extraer certificados, que no toca Sheets. Devuelve
 * `{ contexto, personas, error }` por si alguien quiere contarlo en pantalla.
 */
export function precargar({ log = () => {} } = {}) {
  const e = cache.personal;

  const trabajo = (async () => {
    const resultado = { contexto: null, personas: null, error: null };
    try {
      resultado.contexto = await obtenerContexto();
    } catch (err) {
      resultado.error = err;
      log(`no se pudo leer la configuracion de la hoja: ${err.message}`, "warn");
      return resultado; // sin contexto, el listado tampoco va a salir
    }

    try {
      resultado.personas = await obtenerPersonal({ fondo: true });
      log(`${resultado.personas.length} persona(s) precargadas de la base`, "ok");
    } catch (err) {
      resultado.error = err;
      // no es grave: cada vista puede pedirlo cuando la abran
      log(`no se pudo precargar el personal: ${err.message}`, "warn");
    }
    return resultado;
  })();

  /*
   * Desde este mismo instante queda dicho que el listado viene en camino,
   * aunque todavia se este trayendo el contexto. Hace falta porque las vistas
   * se montan antes: RENOVACION pide su catalogo de areas nada mas arrancar y,
   * sin esta promesa, lanzaria un `cargos` aparte para sacar dos columnas que
   * el listado ya trae, retrasando de paso al que si esta en la fila.
   */
  const prometida = trabajo.then((r) => {
    if (r.personas) return r.personas;
    throw r.error || new Error("no se precargo el personal");
  });
  const olvidar = () => {
    if (e.prometida === prometida) e.prometida = null;
  };
  prometida.then(olvidar, olvidar);
  e.prometida = prometida;

  return trabajo;
}

/* ------------------------------------------------------------------ */
/* Escrituras: parchear lo guardado y avisar                           */
/* ------------------------------------------------------------------ */

/**
 * Deja constancia de que la fila `fila` quedo en la hoja con `valores`.
 *
 * Se llama despues de cada guardado y de cada alta. En vez de tirar el cache
 * (que obligaria a volver a bajar las 600+ personas) parchea en el sitio:
 * reemplaza a esa persona en el listado, refresca su fila y avisa a todas las
 * vistas montadas, que repintan al instante con el dato nuevo. Es lo que hace
 * que renovar a alguien en RENOVACION se vea igual de actualizado en ESTADO
 * RRCC y ESTADO TOTAL sin recargar nada.
 */
export function anotarPersona({ dni, fila, valores }) {
  if (!Array.isArray(valores)) return null;
  const datos = leerFila(valores);
  const clave = clavePersona(dni) || datos.dni;
  if (!clave) return null;

  const registro = { encontrada: true, dni: clave, fila: Number(fila) || null, valores, datos };
  personas.set(clave, { valor: registro, ts: Date.now() });

  const e = cache.personal;
  if (Array.isArray(e.valor)) {
    const i = e.valor.findIndex((p) => clavePersona(p.dni) === clave);
    if (i >= 0) {
      // lista nueva (no mutada): las vistas comparan por identidad para repintar
      e.valor = e.valor.slice();
      e.valor[i] = datos;
    } else if (e.completo) {
      e.valor = [...e.valor, datos]; // alta: el listado completo ahora la incluye
    }
    avisarPersonalPronto("escritura");
  }

  // el aviso de UNA persona si va al instante: es barato y hay quien lo espera
  // para refrescar su ficha en pantalla
  avisar({ tipo: "persona", dni: clave, fila: registro.fila, datos, valores });
  return registro;
}

/**
 * Tira lo guardado para que la proxima consulta vaya a la hoja.
 * `que` puede ser "contexto", "personal", "persona", "catalogo" o nada (todo).
 */
export function invalidar(que) {
  const todo = !que;
  if (todo || que === "contexto") Object.assign(cache.contexto, { valor: null, ts: 0 });
  if (todo || que === "catalogo") Object.assign(cache.catalogo, { valor: null, ts: 0 });
  if (todo || que === "personal")
    Object.assign(cache.personal, { valor: null, ts: 0, completo: false, filtro: "", prometida: null });
  if (todo || que === "persona") personas.clear();
  if (todo) avisar({ tipo: "vaciado" });
}

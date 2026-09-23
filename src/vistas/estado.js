/**
 * Vista "ESTADO RRCC": vencimientos de todo el personal agrupados por riesgo
 * critico, ordenados de vencido a por vencer (o al reves) y listos para
 * imprimir.
 *
 * A diferencia de RENOVACION (que consulta persona por persona contra
 * JOMISER/EIN/Drive), esta vista solo lee lo que ya esta en `BD AESA`: es un
 * reporte de lo guardado, no vuelve a verificar certificados.
 */

import {
  $,
  crearConsola,
  crearMultiSelect,
  notificar,
  escaparHtml,
  conReintento,
  descargarBlob,
} from "./comun.js";
import { cargarContexto, listarPersonal } from "../lib/renovacion.js";
import { armarXlsx } from "../lib/excel.js";
import { personasPorRiesgo, aFormatoCorto, aIso, hoyIso } from "../../shared/estados.js";
import { RRCC } from "../../shared/rrcc.js";

const CLASE_ESTADO = {
  VIGENTE: "et-vigente",
  ACTUALIZAR: "et-actualizar",
  VENCIDO: "et-vencido",
  "NO APLICA": "et-noaplica",
};

/** Orden de urgencia al ordenar por la columna Estado: igual criterio que VENCIDO -> POR VENCER. */
const RANGO_ESTADO = { VENCIDO: 0, ACTUALIZAR: 1, VIGENTE: 2, "NO APLICA": 3 };

const COLUMNAS = [
  { campo: "dni", texto: "DNI", valor: (it) => it.persona.dni || "" },
  { campo: "cargo", texto: "Cargo", valor: (it) => (it.persona.cargo || "").toUpperCase() },
  { campo: "nombre", texto: "Apellidos y Nombres", valor: (it) => (it.persona.nombreCompleto || "").toUpperCase() },
  { campo: "estado", texto: "Estado", valor: (it) => RANGO_ESTADO[it.estado] ?? 99 },
  { campo: "fecha", texto: "F. Vencimiento", valor: (it) => it.riesgo.venc || "" },
];

/**
 * Columnas del Excel exportado: las cinco que se ven en pantalla mas el RRCC
 * (impreso es el titulo de cada tabla, pero en una hoja plana tiene que ir en
 * cada fila para poder filtrar) y los dias que faltan, que ya estan
 * calculados y son lo primero por lo que se suele ordenar.
 */
const COLUMNAS_EXCEL = [
  { titulo: "RRCC", ancho: 7, valor: (it, g) => g.codigo },
  { titulo: "RIESGO CRITICO", ancho: 32, valor: (it, g) => g.nombre },
  { titulo: "DNI", ancho: 12, valor: (it) => it.persona.dni || "" },
  { titulo: "CARGO", ancho: 30, valor: (it) => (it.persona.cargo || "").toUpperCase() },
  { titulo: "APELLIDOS Y NOMBRES", ancho: 34, valor: (it) => (it.persona.nombreCompleto || "").toUpperCase() },
  { titulo: "ESTADO", ancho: 13, valor: (it) => it.estado },
  { titulo: "F. VENCIMIENTO", ancho: 16, tipo: "fecha", valor: (it) => it.riesgo.venc || "" },
  { titulo: "DIAS", ancho: 8, tipo: "numero", valor: (it) => (it.dias === null ? "" : it.dias) },
  { titulo: "AREA", ancho: 26, valor: (it) => (it.persona.area || "").toUpperCase() },
];

const CLAVE_CACHE = "rrcc.estado.snapshot";

/** Ultima lista de personas traida con exito, para pintarla al instante la
    proxima vez mientras se trae la real: leer 600+ personas de Apps Script
    tarda varios segundos, y sin esto la pantalla se queda en blanco todo
    ese tiempo aunque no haya cambiado casi nada desde la ultima carga. */
function leerSnapshot() {
  try {
    const datos = JSON.parse(localStorage.getItem(CLAVE_CACHE));
    return Array.isArray(datos?.personas) ? datos : null;
  } catch {
    return null; // cache invalido o sin almacenamiento: se ignora
  }
}

function guardarSnapshot(config, personas) {
  try {
    localStorage.setItem(CLAVE_CACHE, JSON.stringify({ config: config || {}, personas }));
  } catch {
    /* localStorage lleno o no disponible: no es critico, solo se pierde el atajo */
  }
}

export function montarEstado() {
  const consola = crearConsola("es-term", "es-log-clear");

  const el = {
    buscar: $("es-buscar"),
    hasta: $("es-hasta"),
    hastaBorrar: $("es-hasta-borrar"),
    orden: $("es-orden"),
    cargar: $("es-cargar"),
    imprimir: $("es-imprimir"),
    excel: $("es-excel"),
    count: $("es-count"),
    resCount: $("es-res-count"),
    resultados: $("es-resultados"),
    resumenRiesgo: $("es-resumen-riesgo"),
  };

  let personas = [];
  let contexto = null;
  let configSnapshot = null; // config del ultimo snapshot, solo hasta que llegue el contexto real
  let descendente = false;
  let cargando = false;
  let visible = { grupos: [], vencHasta: "" }; // lo ultimo pintado, que es lo que se imprime y se exporta
  const ordenPorGrupo = new Map(); // codigo RRCC -> { campo, direccion }, al hacer clic en un encabezado

  const selRiesgo = crearMultiSelect(
    "es-riesgo",
    RRCC.map((r) => ({ valor: r.codigo, etiqueta: `${r.codigo} · ${r.rotulo}` })),
    { textoTodos: "TODOS LOS RRCC", resumen: (op) => op.valor }
  );
  const selEstado = crearMultiSelect(
    "es-estado",
    ["VENCIDO", "ACTUALIZAR", "VIGENTE", "NO APLICA"].map((e) => ({ valor: e, etiqueta: e })),
    { textoTodos: "TODOS LOS ESTADOS" }
  );

  function actualizarBotonOrden() {
    el.orden.textContent = descendente ? "VIGENTE → VENCIDO" : "VENCIDO → POR VENCER";
    el.orden.title = descendente
      ? "De lo que menos urge a lo mas vencido. Clic para invertir"
      : "De lo mas vencido a lo que menos urge. Clic para invertir";
    el.orden.setAttribute("aria-pressed", String(descendente));
  }
  actualizarBotonOrden();

  /** Orden manual de este grupo (clic en un encabezado), o el orden natural
      que ya trae (vencido -> por vencer / al reves) si no se toco ninguno. */
  function itemsDelGrupo(grupo) {
    const orden = ordenPorGrupo.get(grupo.codigo);
    if (!orden) return grupo.items;
    const clave = COLUMNAS.find((c) => c.campo === orden.campo)?.valor;
    if (!clave) return grupo.items;
    return [...grupo.items].sort((a, b) => {
      const va = clave(a);
      const vb = clave(b);
      const cmp = va < vb ? -1 : va > vb ? 1 : 0;
      return cmp * orden.direccion;
    });
  }

  function htmlDeGrupo(grupo, vencHasta) {
    const orden = ordenPorGrupo.get(grupo.codigo);
    const filas = itemsDelGrupo(grupo)
      .map(({ persona, riesgo, estado }) => {
        const clase = CLASE_ESTADO[estado] || "et-noaplica";
        return (
          `<tr class="${clase}">` +
          `<td>${escaparHtml(persona.dni)}</td>` +
          `<td>${escaparHtml(persona.cargo) || "—"}</td>` +
          `<td>${escaparHtml(persona.nombreCompleto)}</td>` +
          `<td><span class="et-badge ${clase}">${estado}</span></td>` +
          `<td>${aFormatoCorto(riesgo.venc) || "—"}</td>` +
          `</tr>`
        );
      })
      .join("");

    // Los <th> del encabezado ordenan al hacer clic (delegado en el
    // contenedor, ver alClicEncabezado). La primera fila de <thead> repite
    // el titulo del grupo en cada hoja al imprimir/exportar a PDF (por eso
    // va DENTRO de <thead>, no como un div aparte: eso no se repite al
    // cortar una tabla larga entre paginas); en pantalla queda oculta,
    // porque para eso ya esta el titulo de arriba (.estado-grupo-head).
    const encabezado = COLUMNAS.map(({ campo, texto }) => {
      const activo = orden?.campo === campo;
      const flecha = activo ? (orden.direccion === 1 ? " ▲" : " ▼") : "";
      return (
        `<th data-campo="${campo}" tabindex="0" role="button" aria-label="Ordenar por ${texto}"` +
        `${activo ? ' class="es-th-activo"' : ""}>${texto}${flecha}</th>`
      );
    }).join("");

    // El ancho de columna se fija con <colgroup> (no con el width de cada
    // <th>): la fila de titulo de arriba tiene un solo <th colspan> y, sin
    // colgroup, un motor de tablas puede tomar ESA fila como referencia para
    // repartir columnas en table-layout:fixed y arruinar el ancho de las 4.
    // El corte por fecha va en el titulo que se imprime: en pantalla se ve en
    // el contador de arriba, pero la hoja impresa tiene que decir por si sola
    // hasta que fecha esta recortada la lista.
    const corte = vencHasta ? ` · VENCEN HASTA ${aFormatoCorto(vencHasta)}` : "";

    return (
      `<section class="estado-grupo">` +
      `<div class="estado-grupo-head"><b>${grupo.codigo} · ${escaparHtml(grupo.nombre)}</b><span>${grupo.items.length}</span></div>` +
      `<table class="estado-tabla" data-codigo="${grupo.codigo}">` +
      `<colgroup><col class="ec-dni" /><col class="ec-cargo" /><col class="ec-nombre" /><col class="ec-estado" /><col class="ec-fecha" /></colgroup>` +
      `<thead>` +
      `<tr class="estado-tabla-titulo"><th colspan="${COLUMNAS.length}">${grupo.codigo} · ${escaparHtml(grupo.nombre)} (${grupo.items.length})${corte}</th></tr>` +
      `<tr>${encabezado}</tr>` +
      `</thead><tbody>${filas}</tbody></table>` +
      `</section>`
    );
  }

  function pintar() {
    const textoFiltro = el.buscar.value.trim().toUpperCase();
    const riesgosFiltro = selRiesgo.obtener();
    const estadosFiltro = selEstado.obtener();
    // Corte por fecha de vencimiento: deja solo lo que vence hasta ese dia
    // (incluido), es decir lo que hay que renovar de aqui a esa fecha.
    const vencHasta = aIso(el.hasta.value);
    const umbrales = {
      vencido: Number(contexto?.config?.UMBRAL_VENCIDO ?? configSnapshot?.UMBRAL_VENCIDO ?? 365),
      actualizar: Number(contexto?.config?.UMBRAL_ACTUALIZAR ?? configSnapshot?.UMBRAL_ACTUALIZAR ?? 330),
    };

    // Todos los RRCC con el filtro de estado/activo/texto ya aplicado, ANTES
    // de recortar por "riesgo critico": de aca sale tanto el resumen de la
    // izquierda (cuenta por RRCC, los 18) como las tablas de la derecha
    // (solo los RRCC elegidos, y sin las que quedan en 0).
    const gruposFiltrados = personasPorRiesgo(personas, { descendente, umbrales }).map((g) => ({
      ...g,
      items: g.items
        .filter((it) => (it.persona.estadoTrabajador || "").toUpperCase() === "ACTIVO")
        .filter((it) => estadosFiltro.size === 0 || estadosFiltro.has(it.estado))
        .filter((it) => !vencHasta || (it.riesgo.venc && it.riesgo.venc <= vencHasta))
        .filter(
          (it) =>
            !textoFiltro ||
            [it.persona.nombreCompleto, it.persona.dni, it.persona.area, it.persona.cargo].some((v) =>
              String(v || "").toUpperCase().includes(textoFiltro)
            )
        ),
    }));

    el.resumenRiesgo.innerHTML = personas.length
      ? [...gruposFiltrados]
          .sort((a, b) => b.items.length - a.items.length)
          .map((g) => `<div class="resumen-riesgo-fila"><b>${g.codigo}</b><span>${escaparHtml(g.rotulo)}</span><em>${g.items.length}</em></div>`)
          .join("")
      : "";

    const grupos = gruposFiltrados
      .filter((g) => riesgosFiltro.size === 0 || riesgosFiltro.has(g.codigo))
      .filter((g) => g.items.length);

    const vacio = !personas.length
      ? "carga el personal para ver sus vencimientos"
      : vencHasta
        ? `ningún RRCC vence hasta el ${aFormatoCorto(vencHasta)} con este filtro`
        : "nada coincide con el filtro";

    el.resultados.innerHTML = grupos.length
      ? grupos.map((g) => htmlDeGrupo(g, vencHasta)).join("")
      : `<div class="estado-vacio">${vacio}</div>`;

    visible = { grupos, vencHasta };

    const totalItems = grupos.reduce((n, g) => n + g.items.length, 0);
    el.resCount.textContent = personas.length
      ? `${totalItems} vencimiento(s) · ${grupos.length} RRCC` + (vencHasta ? ` · hasta ${aFormatoCorto(vencHasta)}` : "")
      : "";
    el.imprimir.disabled = totalItems === 0;
    el.excel.disabled = totalItems === 0;
  }

  /**
   * Exporta a .xlsx lo mismo que saldria por la impresora: los grupos que
   * estan a la vista, en su orden, con los filtros ya aplicados. Va todo a
   * UNA hoja (con la columna RRCC) en vez de una hoja por riesgo: asi se
   * puede filtrar, ordenar y hacer tablas dinamicas sobre el conjunto.
   */
  async function exportar() {
    const filas = visible.grupos.flatMap((g) =>
      itemsDelGrupo(g).map((it) => COLUMNAS_EXCEL.map((c) => c.valor(it, g)))
    );
    if (!filas.length) return;

    const corte = visible.vencHasta ? ` hasta ${visible.vencHasta}` : "";
    const nombre = `ESTADO RRCC ${hoyIso()}${corte}.xlsx`;

    el.excel.disabled = true;
    try {
      descargarBlob(await armarXlsx([{ nombre: "ESTADO RRCC", columnas: COLUMNAS_EXCEL, filas }]), nombre);
      consola(`${filas.length} fila(s) exportadas a ${nombre}`, "ok");
    } catch (e) {
      consola(`no se pudo exportar: ${e.message}`, "err");
      notificar("No se pudo exportar", e.message, "warn");
    } finally {
      el.excel.disabled = false;
    }
  }

  async function cargar() {
    if (cargando) return;
    cargando = true;
    el.cargar.disabled = true;
    consola.limpiar();
    consola.cabecera("CARGANDO PERSONAL");
    ordenPorGrupo.clear();

    // Antes de esperar a Apps Script, pinta al instante lo que se trajo la
    // ultima vez (queda guardado en este navegador): con 600+ personas la
    // carga real tarda varios segundos, y asi la pantalla no se queda en
    // blanco todo ese tiempo. Se repinta solo con lo real en cuanto llega.
    if (!personas.length) {
      const snap = leerSnapshot();
      if (snap) {
        configSnapshot = snap.config;
        personas = snap.personas;
        el.count.textContent = `${personas.length} persona(s) (de la última carga, actualizando…)`;
        pintar();
        consola(`${personas.length} persona(s) de la última carga guardada; trayendo datos actuales…`, "info");
      }
    }

    try {
      const [ctx, lista] = await conReintento(
        () => Promise.all([contexto ? Promise.resolve(contexto) : cargarContexto(), listarPersonal()]),
        consola
      );
      contexto = ctx;
      personas = lista;
      guardarSnapshot(ctx.config, lista);
      el.count.textContent = `${personas.length} persona(s)`;
      consola(`${personas.length} persona(s) leída(s) de la hoja`, "ok");
      pintar();
      notificar("Personal cargado", `${personas.length} persona(s) listas para el reporte de vencimientos.`);
    } catch (e) {
      consola(`no se pudo cargar: ${e.message}`, "err");
      notificar("No se pudo cargar", e.message, "warn");
    } finally {
      cargando = false;
      el.cargar.disabled = false;
    }
  }

  /** Clic (o Enter/Espacio) en un <th data-campo>: ordena ese grupo por esa
      columna, alternando ascendente/descendente; un clic en otra columna
      empieza de nuevo en ascendente. Delegado en el contenedor porque las
      tablas se reconstruyen enteras en cada pintar(). */
  function ordenarPorEncabezado(th) {
    const codigo = th.closest("table[data-codigo]")?.dataset.codigo;
    const campo = th.dataset.campo;
    if (!codigo || !campo) return;
    const actual = ordenPorGrupo.get(codigo);
    const direccion = actual?.campo === campo ? -actual.direccion : 1;
    ordenPorGrupo.set(codigo, { campo, direccion });
    pintar();
  }
  el.resultados.addEventListener("click", (ev) => {
    const th = ev.target.closest("th[data-campo]");
    if (th) ordenarPorEncabezado(th);
  });
  el.resultados.addEventListener("keydown", (ev) => {
    if (ev.key !== "Enter" && ev.key !== " ") return;
    const th = ev.target.closest("th[data-campo]");
    if (!th) return;
    ev.preventDefault();
    ordenarPorEncabezado(th);
  });

  el.cargar.addEventListener("click", cargar);
  el.buscar.addEventListener("input", pintar);
  el.hasta.addEventListener("input", pintar);
  el.hasta.addEventListener("change", pintar);
  el.hastaBorrar.addEventListener("click", () => {
    el.hasta.value = "";
    pintar();
    el.hasta.focus();
  });
  selRiesgo.alCambiar(pintar);
  selEstado.alCambiar(pintar);
  el.orden.addEventListener("click", () => {
    descendente = !descendente;
    ordenPorGrupo.clear(); // el orden global vuelve a mandar en todos los grupos
    actualizarBotonOrden();
    pintar();
  });
  el.imprimir.addEventListener("click", () => window.print());
  el.excel.addEventListener("click", exportar);

  pintar();

  return { recargar: cargar };
}

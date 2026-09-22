/**
 * Vista "ESTADO RRCC": vencimientos de todo el personal agrupados por riesgo
 * critico, ordenados de vencido a por vencer (o al reves) y listos para
 * imprimir.
 *
 * A diferencia de RENOVACION (que consulta persona por persona contra
 * JOMISER/EIN/Drive), esta vista solo lee lo que ya esta en `BD AESA`: es un
 * reporte de lo guardado, no vuelve a verificar certificados.
 */

import { $, crearConsola, notificar } from "./comun.js";
import { cargarContexto, listarPersonal } from "../lib/renovacion.js";
import { personasPorRiesgo, aFormatoCorto } from "../../shared/estados.js";
import { RRCC } from "../../shared/rrcc.js";

const CLASE_ESTADO = {
  VIGENTE: "et-vigente",
  ACTUALIZAR: "et-actualizar",
  VENCIDO: "et-vencido",
  "NO APLICA": "et-noaplica",
};

const escaparHtml = (valor) =>
  String(valor ?? "")
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");

function textoDias(dias) {
  if (dias === null || dias === undefined || Number.isNaN(dias)) return "—";
  if (dias > 0) return `faltan ${dias} día(s)`;
  if (dias === 0) return "vence hoy";
  return `vencido hace ${Math.abs(dias)} día(s)`;
}

export function montarEstado() {
  const consola = crearConsola("es-term", "es-log-clear");

  const el = {
    buscar: $("es-buscar"),
    riesgo: $("es-riesgo"),
    estado: $("es-estado"),
    orden: $("es-orden"),
    cargar: $("es-cargar"),
    imprimir: $("es-imprimir"),
    count: $("es-count"),
    resCount: $("es-res-count"),
    resultados: $("es-resultados"),
  };

  let personas = [];
  let contexto = null;
  let descendente = false;
  let cargando = false;

  el.riesgo.innerHTML =
    `<option value="">TODOS LOS RRCC</option>` +
    RRCC.map((r) => `<option value="${r.codigo}">${r.codigo} · ${escaparHtml(r.rotulo)}</option>`).join("");

  function actualizarBotonOrden() {
    el.orden.textContent = descendente ? "VIGENTE → VENCIDO" : "VENCIDO → POR VENCER";
    el.orden.title = descendente
      ? "De lo que menos urge a lo mas vencido. Clic para invertir"
      : "De lo mas vencido a lo que menos urge. Clic para invertir";
    el.orden.setAttribute("aria-pressed", String(descendente));
  }
  actualizarBotonOrden();

  function htmlDeGrupo(grupo) {
    const filas = grupo.items
      .map(({ persona, riesgo, dias, estado }) => {
        const clase = CLASE_ESTADO[estado] || "et-noaplica";
        return (
          `<tr class="${clase}">` +
          `<td>${escaparHtml(persona.dni)}</td>` +
          `<td>${escaparHtml(persona.nombreCompleto)}</td>` +
          `<td>${escaparHtml([persona.cargo, persona.area].filter(Boolean).join(" · ")) || "—"}</td>` +
          `<td>${aFormatoCorto(riesgo.cap) || "—"}</td>` +
          `<td>${aFormatoCorto(riesgo.venc) || "—"}</td>` +
          `<td>${textoDias(dias)}</td>` +
          `<td><span class="et-badge ${clase}">${estado}</span></td>` +
          `</tr>`
        );
      })
      .join("");

    return (
      `<section class="estado-grupo">` +
      `<div class="estado-grupo-head"><b>${grupo.codigo} · ${escaparHtml(grupo.nombre)}</b><span>${grupo.items.length}</span></div>` +
      `<table class="estado-tabla"><thead><tr>` +
      `<th>DNI</th><th>Nombre</th><th>Cargo / Área</th><th>Capacitación</th><th>Vigencia</th><th>Días</th><th>Estado</th>` +
      `</tr></thead><tbody>${filas}</tbody></table>` +
      `</section>`
    );
  }

  function pintar() {
    const textoFiltro = el.buscar.value.trim().toUpperCase();
    const riesgoFiltro = el.riesgo.value;
    const estadoFiltro = el.estado.value;
    const umbrales = {
      vencido: Number(contexto?.config?.UMBRAL_VENCIDO ?? 365),
      actualizar: Number(contexto?.config?.UMBRAL_ACTUALIZAR ?? 330),
    };

    const grupos = personasPorRiesgo(personas, { descendente, umbrales })
      .filter((g) => !riesgoFiltro || g.codigo === riesgoFiltro)
      .map((g) => ({
        ...g,
        items: g.items
          .filter((it) => !estadoFiltro || it.estado === estadoFiltro)
          .filter(
            (it) =>
              !textoFiltro ||
              [it.persona.nombreCompleto, it.persona.dni, it.persona.area, it.persona.cargo].some((v) =>
                String(v || "").toUpperCase().includes(textoFiltro)
              )
          ),
      }))
      .filter((g) => g.items.length);

    el.resultados.innerHTML = grupos.length
      ? grupos.map(htmlDeGrupo).join("")
      : `<div class="estado-vacio">${
          personas.length ? "nada coincide con el filtro" : "carga el personal para ver sus vencimientos"
        }</div>`;

    const totalItems = grupos.reduce((n, g) => n + g.items.length, 0);
    el.resCount.textContent = personas.length ? `${totalItems} vencimiento(s) · ${grupos.length} RRCC` : "";
    el.imprimir.disabled = totalItems === 0;
  }

  async function cargar() {
    if (cargando) return;
    cargando = true;
    el.cargar.disabled = true;
    consola.limpiar();
    consola.cabecera("CARGANDO PERSONAL");
    try {
      const [ctx, lista] = await Promise.all([contexto ? Promise.resolve(contexto) : cargarContexto(), listarPersonal()]);
      contexto = ctx;
      personas = lista;
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

  el.cargar.addEventListener("click", cargar);
  el.buscar.addEventListener("input", pintar);
  el.riesgo.addEventListener("change", pintar);
  el.estado.addEventListener("change", pintar);
  el.orden.addEventListener("click", () => {
    descendente = !descendente;
    actualizarBotonOrden();
    pintar();
  });
  el.imprimir.addEventListener("click", () => window.print());

  pintar();

  return { recargar: cargar };
}

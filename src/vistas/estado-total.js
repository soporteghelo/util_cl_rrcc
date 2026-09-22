/**
 * Vista "ESTADO TOTAL": quienes ya perdieron alguna autorizacion de riesgo
 * critico y siguen activos — ESTADO_FINAL = VENCIDO y _EstaTE = ACTIVO en
 * `BD AESA` — con un dashboard de cuantos RRCC estan vencidos y cuantos por
 * vencer, y el detalle por persona en un flotante al hacer clic en su fila.
 *
 * Igual que ESTADO RRCC, es un reporte de lo guardado: no vuelve a consultar
 * JOMISER/EIN/Drive.
 */

import { $, crearConsola, notificar, escaparHtml, textoDias, conReintento } from "./comun.js";
import { cargarContexto, listarPersonal } from "../lib/renovacion.js";
import { riesgosProblemaDe, aFormatoCorto } from "../../shared/estados.js";

export function montarEstadoTotal() {
  const consola = crearConsola("et-term", "et-log-clear");

  const el = {
    buscar: $("et-buscar"),
    orden: $("et-orden"),
    cargar: $("et-cargar"),
    count: $("et-count"),
    resCount: $("et-res-count"),
    dash: $("et-dash"),
    dashPersonas: $("et-dash-personas"),
    dashVencidos: $("et-dash-vencidos"),
    dashPorVencer: $("et-dash-porvencer"),
    resultados: $("et-resultados"),
  };

  let personas = [];
  let contexto = null;
  let descendente = false;
  let cargando = false;
  let filas = []; // lo ultimo pintado, para abrir el flotante por indice

  function actualizarBotonOrden() {
    el.orden.textContent = descendente ? "MENOS URGENTE → MÁS" : "MÁS URGENTE → MENOS";
    el.orden.title = descendente
      ? "De lo que menos urge a lo mas vencido. Clic para invertir"
      : "De lo mas vencido a lo que menos urge. Clic para invertir";
    el.orden.setAttribute("aria-pressed", String(descendente));
  }
  actualizarBotonOrden();

  /* ------------------------------------------------------------------ */
  /* Flotante de detalle                                                 */
  /* ------------------------------------------------------------------ */

  let flotante = null;

  function cerrarFlotante() {
    flotante?.remove();
    flotante = null;
    document.removeEventListener("click", alClicFuera, true);
    document.removeEventListener("keydown", alEscape, true);
  }
  function alClicFuera(ev) {
    if (flotante && !flotante.contains(ev.target)) cerrarFlotante();
  }
  function alEscape(ev) {
    if (ev.key === "Escape") cerrarFlotante();
  }

  /**
   * En la hoja en vivo (Apps Script) `rotulo` viene igual al `codigo` (Code.gs
   * no tiene el catalogo completo): se muestra el nombre largo solo cuando de
   * verdad aporta algo distinto, y siempre con el tipo A/C a la vista — es lo
   * que el usuario pidio distinguir en el flotante.
   */
  function filaDeRiesgo(r) {
    const tipo = r.tipo === "A" || r.tipo === "C" ? r.tipo : "";
    const titulo = tipo === "A" ? "Autorizado" : tipo === "C" ? "Capacitado" : "sin tipo";
    const etiqueta = r.rotulo && r.rotulo !== r.codigo ? `${r.codigo} · ${r.rotulo}` : r.codigo;
    return (
      `<li><span>` +
      `<b class="et-tipo${tipo ? " et-tipo-" + tipo.toLowerCase() : ""}" title="${titulo}">${tipo || "?"}</b>` +
      `${escaparHtml(etiqueta)}</span>` +
      `<span>${aFormatoCorto(r.venc) || "—"} · ${textoDias(r.dias)}</span></li>`
    );
  }

  function contenidoFlotante({ persona, vencidos, porVencer }) {
    const grupo = (titulo, clase, items) =>
      items.length
        ? `<div class="et-flotante-grupo"><b class="${clase}">${titulo} (${items.length})</b><ul>${items
            .map(filaDeRiesgo)
            .join("")}</ul></div>`
        : "";
    return (
      `<div class="et-flotante-head">` +
      `<b>${escaparHtml(persona.nombreCompleto || persona.dni)}<span>${escaparHtml(persona.dni)}</span></b>` +
      `<button class="et-flotante-x" type="button" aria-label="Cerrar">×</button>` +
      `</div>` +
      grupo("VENCIDO", "et-vencido", vencidos) +
      grupo("POR VENCER", "et-actualizar", porVencer) +
      (!vencidos.length && !porVencer.length ? `<div class="estado-vacio">sin riesgos vencidos ni por vencer</div>` : "")
    );
  }

  function abrirFlotante(item, x, y) {
    cerrarFlotante();
    const div = document.createElement("div");
    div.className = "et-flotante";
    div.innerHTML = contenidoFlotante(item);
    document.body.appendChild(div);
    flotante = div;

    const margen = 10;
    const maxX = window.innerWidth - div.offsetWidth - margen;
    const maxY = window.innerHeight - div.offsetHeight - margen;
    div.style.left = `${Math.min(Math.max(margen, x), Math.max(margen, maxX))}px`;
    div.style.top = `${Math.min(Math.max(margen, y), Math.max(margen, maxY))}px`;

    div.querySelector(".et-flotante-x")?.addEventListener("click", cerrarFlotante);
    // se registra en el siguiente turno: el clic que abrio el flotante no debe cerrarlo de una
    setTimeout(() => {
      document.addEventListener("click", alClicFuera, true);
      document.addEventListener("keydown", alEscape, true);
    }, 0);
  }

  function alClicEnFila(ev) {
    const fila = ev.target.closest(".et-fila");
    if (!fila) return;
    const item = filas[Number(fila.dataset.indice)];
    if (item) abrirFlotante(item, ev.clientX + 12, ev.clientY + 12);
  }
  function alTecladoEnFila(ev) {
    if (ev.key !== "Enter" && ev.key !== " ") return;
    const fila = ev.target.closest(".et-fila");
    if (!fila) return;
    ev.preventDefault();
    const item = filas[Number(fila.dataset.indice)];
    if (!item) return;
    const r = fila.getBoundingClientRect();
    abrirFlotante(item, r.left + 12, r.bottom + 6);
  }

  /* ------------------------------------------------------------------ */
  /* Tabla + dashboard                                                   */
  /* ------------------------------------------------------------------ */

  function filaHtml({ persona, vencidos, porVencer }, indice) {
    return (
      `<tr class="et-fila" data-indice="${indice}" tabindex="0">` +
      `<td>${escaparHtml(persona.dni)}</td>` +
      `<td>${escaparHtml(persona.nombreCompleto) || "—"}</td>` +
      `<td>${escaparHtml([persona.cargo, persona.area].filter(Boolean).join(" · ")) || "—"}</td>` +
      `<td><span class="et-badge et-vencido">${vencidos.length}</span></td>` +
      `<td><span class="et-badge et-actualizar">${porVencer.length}</span></td>` +
      `<td>${textoDias(Number(persona.dias))}</td>` +
      `</tr>`
    );
  }

  function pintar() {
    cerrarFlotante();
    const textoFiltro = el.buscar.value.trim().toUpperCase();
    const normalizar = (valor) => String(valor ?? "").trim().toUpperCase();
    const umbrales = {
      vencido: Number(contexto?.config?.UMBRAL_VENCIDO ?? 365),
      actualizar: Number(contexto?.config?.UMBRAL_ACTUALIZAR ?? 330),
    };

    filas = personas
      .filter((p) => normalizar(p.estadoFinal) === "VENCIDO" && normalizar(p.estadoTrabajador) === "ACTIVO")
      .filter(
        (p) =>
          !textoFiltro ||
          [p.nombreCompleto, p.dni, p.area, p.cargo].some((v) => String(v || "").toUpperCase().includes(textoFiltro))
      )
      .map((persona) => ({ persona, ...riesgosProblemaDe(persona, { umbrales }) }));

    filas.sort((a, b) => {
      const da = Number(a.persona.dias) || 0;
      const db = Number(b.persona.dias) || 0;
      return descendente ? db - da : da - db;
    });

    el.resultados.innerHTML = filas.length
      ? `<table class="estado-tabla et-tabla"><thead><tr>` +
        `<th>DNI</th><th>Nombre</th><th>Cargo / Área</th><th>Vencidos</th><th>Por vencer</th><th>Días</th>` +
        `</tr></thead><tbody>${filas.map(filaHtml).join("")}</tbody></table>`
      : `<div class="estado-vacio">${
          personas.length ? "nadie coincide con el filtro" : "carga el personal para ver el estado total"
        }</div>`;

    const totalVencidos = filas.reduce((n, f) => n + f.vencidos.length, 0);
    const totalPorVencer = filas.reduce((n, f) => n + f.porVencer.length, 0);
    el.dash.hidden = !personas.length;
    el.dashPersonas.textContent = String(filas.length);
    el.dashVencidos.textContent = String(totalVencidos);
    el.dashPorVencer.textContent = String(totalPorVencer);

    el.resCount.textContent = personas.length ? `${filas.length} persona(s) vencida(s)` : "";
  }

  async function cargar() {
    if (cargando) return;
    cargando = true;
    el.cargar.disabled = true;
    consola.limpiar();
    consola.cabecera("CARGANDO PERSONAL");
    try {
      const [ctx, lista] = await conReintento(
        () =>
          Promise.all([
            contexto ? Promise.resolve(contexto) : cargarContexto(),
            listarPersonal(undefined, "vencidos_activos"),
          ]),
        consola
      );
      contexto = ctx;
      personas = lista;
      el.count.textContent = `${personas.length} persona(s)`;
      consola(`${personas.length} persona(s) leída(s) (filtrado en el backend cuando esta disponible)`, "ok");
      pintar();
      notificar("Personal cargado", `${personas.length} persona(s) listas para el estado total.`);
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
  el.orden.addEventListener("click", () => {
    descendente = !descendente;
    actualizarBotonOrden();
    pintar();
  });
  el.resultados.addEventListener("click", alClicEnFila);
  el.resultados.addEventListener("keydown", alTecladoEnFila);

  pintar();

  return { recargar: cargar };
}

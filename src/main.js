/**
 * NEXA_CERT_EXTRACTOR — orquestador del navegador.
 *
 * El navegador dirige todo el proceso y las funciones serverless solo hacen de
 * proxy de una operacion cada una. Es la unica forma de que entre en Vercel:
 * una sola funcion que descargara todo se pasaria del limite de 60 s y del
 * limite de 4.5 MB por respuesta.
 */

import "./style.css";
import { desdeTexto, normalizarDni, normalizarLista } from "./lib/dni.js";
import { extraerDocumentos } from "./lib/excel.js";
import { buscar, descargar } from "./lib/api.js";
import {
  EscritorCarpeta,
  descargarZip,
  elegirCarpeta,
  guardarEnCarpeta,
  soportaCarpeta,
} from "./lib/guardar.js";

const $ = (id) => document.getElementById(id);

const el = {
  dnis: $("dnis"),
  count: $("dni-count"),
  archivo: $("archivo"),
  limpiar: $("btn-limpiar"),
  avisoCeros: $("aviso-ceros"),
  avisoArchivo: $("aviso-archivo"),
  run: $("btn-run"),
  stop: $("btn-stop"),
  barWrap: $("bar-wrap"),
  barFill: $("bar-fill"),
  barTxt: $("bar-txt"),
  barPct: $("bar-pct"),
  panelRes: $("panel-res"),
  resCount: $("res-count"),
  resultados: $("resultados"),
  guardar: $("acciones-guardar"),
  zip: $("btn-zip"),
  carpeta: $("btn-carpeta"),
  term: $("term"),
  logClear: $("btn-log-clear"),
  destRow: $("dest-row"),
  destTxt: $("dest-txt"),
  btnDest: $("btn-dest"),
  toast: $("toast"),
  toastIc: $("toast-ic"),
  toastTit: $("toast-tit"),
  toastSub: $("toast-sub"),
  toastX: $("toast-x"),
};

let corriendo = false;
let abortador = null;
let resultados = [];
let carpetaDestino = null; // FileSystemDirectoryHandle elegido por el usuario

/* ------------------------------------------------------------------ */
/* Consola                                                             */
/* ------------------------------------------------------------------ */

let cursor = null;

function log(texto, clase = "info") {
  cursor?.remove();
  const linea = document.createElement("div");
  linea.className = `ln ln-${clase}`;
  linea.textContent = texto;
  el.term.appendChild(linea);

  cursor = document.createElement("span");
  cursor.className = "cursor";
  el.term.appendChild(cursor);
  el.term.scrollTop = el.term.scrollHeight;
}

const logHead = (t) => log(t, "head");

/* ------------------------------------------------------------------ */
/* Entrada de documentos                                               */
/* ------------------------------------------------------------------ */

function objetivosActuales() {
  return normalizarLista(desdeTexto(el.dnis.value));
}

function refrescarConteo() {
  const { items, rellenados, atipicos, descartados } = objetivosActuales();
  el.count.textContent = `${items.length} DNI`;

  const partes = [];
  if (rellenados.length) {
    const muestra = rellenados
      .slice(0, 6)
      .map((r) => `<code>${r.original}</code> → <code>${r.dni}</code>`)
      .join(", ");
    partes.push(
      `<b>${rellenados.length} documento(s) con ceros restaurados:</b> ${muestra}` +
        (rellenados.length > 6 ? ` y ${rellenados.length - 6} más` : "") +
        `. Excel guarda los DNI como número y borra el cero inicial; se rellenó a 8 dígitos.`
    );
  }
  if (atipicos.length) {
    partes.push(
      `<b>${atipicos.length} documento(s) no tienen 8 dígitos</b> (${atipicos
        .slice(0, 5)
        .map((a) => `<code>${a.dni}</code>`)
        .join(", ")}). Se consultarán igual, pero revísalos.`
    );
  }
  if (descartados.length) {
    partes.push(`<b>${descartados.length} valor(es) sin dígitos</b> ignorados.`);
  }

  el.avisoCeros.hidden = !partes.length;
  el.avisoCeros.innerHTML = partes.join("<br><br>");
}

el.dnis.addEventListener("input", refrescarConteo);

el.limpiar.addEventListener("click", () => {
  el.dnis.value = "";
  el.avisoArchivo.hidden = true;
  refrescarConteo();
  el.dnis.focus();
});

el.archivo.addEventListener("change", async (ev) => {
  const archivo = ev.target.files?.[0];
  if (!archivo) return;
  try {
    log(`leyendo ${archivo.name} (${(archivo.size / 1024).toFixed(0)} KB)...`);
    const { valores, numericas, detalle } = await extraerDocumentos(archivo);
    if (!valores.length) throw new Error("no se encontró ninguna columna con documentos");

    const previos = desdeTexto(el.dnis.value);
    const union = normalizarLista([...previos, ...valores]);

    // Los cambios se calculan sobre los valores CRUDOS del archivo: una vez
    // volcados al textarea ya estan normalizados y el relleno seria invisible.
    // Se recorre valor por valor (no la lista deduplicada) para no perder un
    // relleno cuyo resultado coincida con otra fila ya presente.
    const vistos = new Set();
    const corregidos = [];
    for (const v of valores) {
      const r = normalizarDni(v);
      if (!r || !r.relleno) continue;
      const clave = `${r.original}>${r.dni}`;
      if (vistos.has(clave)) continue;
      vistos.add(clave);
      corregidos.push(r);
    }
    const delArchivo = normalizarLista(valores);

    el.dnis.value = union.items.map((i) => i.dni).join("\n");
    refrescarConteo();

    const partes = [`<b>${archivo.name}</b> → ${valores.length} valor(es) leído(s) de ${detalle}.`];
    if (corregidos.length) {
      partes.push(
        `<b>${corregidos.length} con el cero inicial restaurado:</b> ` +
          corregidos.map((r) => `<code>${r.original}</code> → <code>${r.dni}</code>`).join(", ") +
          `. Excel guarda los DNI como número y borra el cero.`
      );
    } else if (numericas) {
      partes.push(`${numericas} venían como número; ninguna había perdido ceros.`);
    } else {
      partes.push(`Todas venían como texto: los ceros se conservaron tal cual.`);
    }
    if (delArchivo.atipicos.length) {
      partes.push(
        `<b>${delArchivo.atipicos.length} sin 8 dígitos:</b> ` +
          delArchivo.atipicos.map((a) => `<code>${a.dni}</code>`).join(", ") + `. Revísalos.`
      );
    }

    el.avisoArchivo.hidden = false;
    el.avisoArchivo.innerHTML = partes.join("<br><br>");

    log(`${valores.length} documento(s) desde ${detalle}`, "ok");
    for (const r of corregidos) log(`  cero restaurado: ${r.original} → ${r.dni}`, "warn");
  } catch (e) {
    el.avisoArchivo.hidden = false;
    el.avisoArchivo.innerHTML = `<b>No se pudo leer el archivo:</b> ${e.message}`;
    log(`error leyendo archivo: ${e.message}`, "err");
  } finally {
    ev.target.value = "";
  }
});

el.logClear.addEventListener("click", () => {
  el.term.innerHTML = "";
  cursor = null;
});

/* ------------------------------------------------------------------ */
/* Carpeta de guardado                                                 */
/* ------------------------------------------------------------------ */

function pintarDestino() {
  if (carpetaDestino) {
    el.destRow.classList.add("ok");
    el.destTxt.textContent = carpetaDestino.name;
    el.destTxt.title = carpetaDestino.name;
    el.btnDest.textContent = "CAMBIAR";
  } else {
    el.destRow.classList.remove("ok");
    el.destTxt.textContent = soportaCarpeta()
      ? "sin elegir — se pedirá al iniciar"
      : "este navegador descarga un ZIP";
    el.btnDest.hidden = !soportaCarpeta();
  }
}

/** Abre el explorador. Debe invocarse dentro del gesto del usuario. */
async function pedirCarpeta() {
  try {
    carpetaDestino = await elegirCarpeta();
    pintarDestino();
    log(`carpeta de guardado: ${carpetaDestino.name}`, "ok");
    return true;
  } catch (e) {
    if (e.name === "AbortError") {
      log("selección de carpeta cancelada", "warn");
      return false;
    }
    log(`no se pudo abrir la carpeta: ${e.message}`, "err");
    return false;
  }
}

el.btnDest.addEventListener("click", pedirCarpeta);

/* ------------------------------------------------------------------ */
/* Notificacion de fin                                                 */
/* ------------------------------------------------------------------ */

let cerrarToast = null;

function notificar(titulo, detalle, tipo = "ok") {
  // 1) aviso dentro de la pagina (siempre funciona)
  clearTimeout(cerrarToast);
  el.toast.className = `toast ${tipo === "ok" ? "" : tipo}`.trim();
  el.toastIc.textContent = tipo === "ok" ? "✓" : "!";
  el.toastTit.textContent = titulo;
  el.toastSub.textContent = detalle;
  el.toast.hidden = false;
  // reinicia la animacion de la barra al reutilizar el mismo nodo
  const barra = el.toast.querySelector(".toast-bar");
  barra.style.animation = "none";
  void barra.offsetWidth;
  barra.style.animation = "";
  cerrarToast = setTimeout(() => (el.toast.hidden = true), 12000);

  // 2) notificacion del sistema, util si la pestana esta en segundo plano
  try {
    if ("Notification" in window && Notification.permission === "granted") {
      const n = new Notification(titulo, { body: detalle, icon: "/favicon.svg", tag: "nexa-cert" });
      n.onclick = () => {
        window.focus();
        n.close();
      };
    }
  } catch {
    /* algunos navegadores lanzan si la pagina no es segura */
  }

  // 3) pitido corto: en lotes largos avisa sin mirar la pantalla
  if (tipo === "ok") pitido();
}

function pitido() {
  try {
    const ctx = new (window.AudioContext || window.webkitAudioContext)();
    const t0 = ctx.currentTime;
    for (const [i, hz] of [880, 1320].entries()) {
      const osc = ctx.createOscillator();
      const gan = ctx.createGain();
      osc.type = "sine";
      osc.frequency.value = hz;
      gan.gain.setValueAtTime(0.0001, t0 + i * 0.11);
      gan.gain.exponentialRampToValueAtTime(0.08, t0 + i * 0.11 + 0.01);
      gan.gain.exponentialRampToValueAtTime(0.0001, t0 + i * 0.11 + 0.1);
      osc.connect(gan).connect(ctx.destination);
      osc.start(t0 + i * 0.11);
      osc.stop(t0 + i * 0.11 + 0.11);
    }
    setTimeout(() => ctx.close(), 600);
  } catch {
    /* sin audio disponible */
  }
}

el.toastX.addEventListener("click", () => {
  clearTimeout(cerrarToast);
  el.toast.hidden = true;
});

/* ------------------------------------------------------------------ */
/* Barra de progreso                                                   */
/* ------------------------------------------------------------------ */

function progreso(hecho, total, texto) {
  const pct = total ? Math.round((hecho / total) * 100) : 0;
  el.barFill.style.width = `${pct}%`;
  el.barPct.textContent = `${pct}%`;
  el.barTxt.textContent = texto;
}

/* ------------------------------------------------------------------ */
/* Render de resultados                                                */
/* ------------------------------------------------------------------ */

const CLASE_ESTADO = {
  DESCARGADO: "st-ok",
  "SIN CERTIFICADO": "st-skip",
  PENDIENTE: "st-wait",
};

/** Un PDF puede estar en memoria (pdf) o ya escrito en disco (guardado). */
const obtenido = (it) => Boolean(it.pdf || it.guardado);
const totalObtenidos = () => resultados.reduce((n, r) => n + r.items.filter(obtenido).length, 0);

function pintar() {
  el.panelRes.hidden = false;
  el.resultados.innerHTML = "";

  let ok = 0;
  for (const obj of resultados) {
    const card = document.createElement("div");
    card.className = "card";

    const descargados = obj.items.filter(obtenido).length;
    ok += descargados;

    const cab = document.createElement("div");
    cab.className = "card-head";
    cab.innerHTML =
      `<span class="card-dni">${obj.dni}</span>` +
      (obj.original !== obj.dni ? `<span class="item-meta">(archivo: ${obj.original})</span>` : "") +
      `<span class="card-n">${descargados}/${obj.items.length}</span>` +
      `<span class="card-nom">${obj.participante || "— sin registros —"}</span>`;
    card.appendChild(cab);

    const cont = document.createElement("div");
    cont.className = "items";
    for (const it of obj.items) {
      const fila = document.createElement("div");
      fila.className = "item";
      const clase = it.error ? "st-err" : CLASE_ESTADO[it.estado] || "st-skip";
      const etiqueta = it.error ? "ERROR" : it.estado;
      fila.innerHTML =
        `<span class="item-txt">${it.curso} <span class="item-meta">· ${it.fecha}</span>` +
        `${it.error ? `<br><span class="item-meta">${it.error}</span>` : ""}</span>` +
        `<span class="item-st ${clase}">${etiqueta}</span>`;
      cont.appendChild(fila);
    }
    if (!obj.items.length) {
      const vacio = document.createElement("div");
      vacio.className = "item";
      vacio.innerHTML = `<span class="item-txt item-meta">Sin certificados</span>`;
      cont.appendChild(vacio);
    }
    card.appendChild(cont);
    el.resultados.appendChild(card);
  }

  el.resCount.textContent = `${ok} PDF · ${resultados.length} DNI`;

  // Si ya se escribio en la carpeta elegida no hay nada mas que guardar.
  const enMemoria = resultados.some((r) => r.items.some((i) => i.pdf));
  el.guardar.hidden = !enMemoria;
  el.carpeta.hidden = !soportaCarpeta();
}

/* ------------------------------------------------------------------ */
/* Proceso principal                                                   */
/* ------------------------------------------------------------------ */

async function ejecutar() {
  const { items: objetivos } = objetivosActuales();
  if (!objetivos.length) {
    log("no hay documentos que consultar", "warn");
    el.dnis.focus();
    return;
  }

  corriendo = true;
  abortador = new AbortController();
  const senal = abortador.signal;
  resultados = [];

  // Se escribe directo en la carpeta elegida conforme llegan los PDF.
  const escritor = carpetaDestino ? new EscritorCarpeta(carpetaDestino) : null;

  el.run.disabled = true;
  el.stop.hidden = false;
  el.barWrap.hidden = false;
  el.guardar.hidden = true;
  el.term.innerHTML = "";
  cursor = null;

  logHead(`INICIO · ${objetivos.length} documento(s)`);
  log(
    escritor
      ? `se guardará en la carpeta "${escritor.nombre}" según se descargue`
      : "al terminar se descargará un ZIP",
    "info"
  );

  let hecho = 0;
  let totalEstimado = objetivos.length; // se ajusta al conocer los certificados

  try {
    for (const [i, obj] of objetivos.entries()) {
      if (senal.aborted) break;

      const registro = { dni: obj.dni, original: obj.original, participante: "", items: [], avisos: [] };
      resultados.push(registro);

      logHead(`[${i + 1}/${objetivos.length}] DNI ${obj.dni}`);
      if (obj.relleno) log(`  documento original "${obj.original}" → ${obj.dni}`, "warn");
      progreso(hecho, totalEstimado, `consultando ${obj.dni}`);

      /* ---- inventario ---- */
      let inv;
      try {
        inv = await buscar({ dni: obj.dni }, senal);
      } catch (e) {
        if (senal.aborted) break;
        log(`  fallo la consulta: ${e.message}`, "err");
        registro.avisos.push(`consulta: ${e.message}`);
        pintar();
        continue;
      }

      if (inv.error) {
        log(`  ${inv.error}`, "err");
        registro.avisos.push(inv.error);
      }
      for (const a of inv.avisos || []) {
        log(`  ${a}`, "warn");
        registro.avisos.push(a);
      }

      registro.participante = inv.participante || "";
      if (inv.participante) log(`  ${inv.participante}`, "ok");

      registro.items = (inv.items || []).map((p) => ({
        ...p,
        estado: p.descargable ? "PENDIENTE" : p.estado || "SIN CERTIFICADO",
        pdf: null,
        error: null,
      }));

      const descargables = registro.items.filter((x) => x.descargable);
      totalEstimado += descargables.length;
      log(`  ${registro.items.length} registro(s), ${descargables.length} descargable(s)`);
      pintar();

      /* ---- descarga uno por uno ---- */
      for (const it of descargables) {
        if (senal.aborted) break;
        progreso(hecho, totalEstimado, `${obj.dni} · ${it.curso}`.slice(0, 52));

        try {
          const r = await descargar({ id: it.id, origen: it.origen }, senal);
          it.pdf = r.pdf;
          it.estado = "DESCARGADO";
          const kb = (r.pdf.byteLength / 1024).toFixed(0);

          if (escritor) {
            // se vuelca a disco ya, no se acumula en memoria
            it.archivo = await escritor.guardarItem(obj.dni, it);
            it.pdf = null;
            it.guardado = true;
            log(`  · ${it.curso}: ${kb} KB → ${it.archivo}`, "ok");
          } else {
            log(`  · ${it.curso}: ${kb} KB`, "ok");
          }
        } catch (e) {
          if (senal.aborted) break;
          it.error = e.message;
          it.estado = "ERROR";
          log(`  · ${it.curso}: ${e.message}`, "err");
        }

        hecho++;
        progreso(hecho, totalEstimado, `${obj.dni} · ${it.curso}`.slice(0, 52));
        pintar();
      }

      hecho++;
      pintar();
    }

    /* ---- cierre ---- */
    const totalPdf = totalObtenidos();
    const errores = resultados.reduce(
      (n, r) => n + r.items.filter((i) => i.error).length + r.avisos.length,
      0
    );
    progreso(1, 1, senal.aborted ? "abortado" : "completado");
    pintar();

    if (senal.aborted) {
      logHead(`ABORTADO · ${totalPdf} PDF ya descargado(s)`);
      notificar(
        "Extracción abortada",
        escritor
          ? `${totalPdf} certificado(s) quedaron guardados en "${escritor.nombre}".`
          : `${totalPdf} certificado(s) descargado(s). Puedes guardarlos igual.`,
        "warn"
      );
      return;
    }

    logHead(`COMPLETADO · ${totalPdf} PDF de ${resultados.length} documento(s)`);

    if (!totalPdf) {
      log("no se descargo ningun certificado", "warn");
      notificar("Sin certificados", `No se encontró ninguno para ${resultados.length} documento(s).`, "warn");
      return;
    }

    const deDnis = `${totalPdf} certificado(s) de ${resultados.length} documento(s)`;
    if (escritor) {
      log(`guardado en la carpeta "${escritor.nombre}"`, "ok");
      notificar(
        "Descarga completa",
        `${deDnis} guardado(s) en "${escritor.nombre}".` + (errores ? ` ${errores} aviso(s).` : ""),
        errores ? "warn" : "ok"
      );
    } else {
      log("listo para guardar: usa ZIP o guardar en carpeta", "ok");
      notificar(
        "Descarga completa",
        `${deDnis} listo(s). Pulsa DESCARGAR ZIP para guardarlos.` + (errores ? ` ${errores} aviso(s).` : ""),
        errores ? "warn" : "ok"
      );
    }
  } finally {
    corriendo = false;
    el.run.disabled = false;
    el.stop.hidden = true;
  }
}

el.run.addEventListener("click", async () => {
  if (corriendo) return;

  // El explorador se abre ANTES de empezar. Tiene que ser lo primero del
  // manejador: si se hace await de otra cosa antes, el navegador ya no
  // considera que estamos dentro del gesto del usuario y lo bloquea.
  if (soportaCarpeta() && !carpetaDestino) {
    const elegida = await pedirCarpeta();
    if (!elegida) {
      notificar("Falta la carpeta", "Elige dónde guardar los certificados para poder empezar.", "warn");
      return;
    }
  }

  // Permiso para avisar al terminar (los lotes tardan y se deja en 2º plano).
  // SIN await: el aviso del navegador se queda esperando respuesta y dejaria
  // la extraccion parada hasta que el usuario lo conteste.
  try {
    if ("Notification" in window && Notification.permission === "default") {
      Notification.requestPermission().catch(() => {});
    }
  } catch {
    /* sin soporte de notificaciones */
  }

  ejecutar();
});

el.stop.addEventListener("click", () => {
  abortador?.abort();
  log("abortando...", "warn");
});

/* ------------------------------------------------------------------ */
/* Guardado                                                            */
/* ------------------------------------------------------------------ */

el.zip.addEventListener("click", async () => {
  el.zip.disabled = true;
  try {
    log("comprimiendo...");
    const r = await descargarZip(resultados, (p) => progreso(p, 100, `comprimiendo ${Math.round(p)}%`));
    log(`${r.nombre} · ${r.archivos} PDF · ${(r.bytes / 1048576).toFixed(1)} MB`, "ok");
    progreso(1, 1, "ZIP generado");
  } catch (e) {
    log(`error generando el ZIP: ${e.message}`, "err");
  } finally {
    el.zip.disabled = false;
  }
});

el.carpeta.addEventListener("click", async () => {
  el.carpeta.disabled = true;
  try {
    const r = await guardarEnCarpeta(resultados, carpetaDestino);
    log(`${r.archivos} PDF guardado(s) en la carpeta "${r.carpeta}"`, "ok");
    notificar("Guardado", `${r.archivos} certificado(s) en "${r.carpeta}".`);
  } catch (e) {
    if (e.name === "AbortError") log("guardado cancelado", "warn");
    else log(`error guardando: ${e.message}`, "err");
  } finally {
    el.carpeta.disabled = false;
  }
});

/* ------------------------------------------------------------------ */
/* Arranque                                                            */
/* ------------------------------------------------------------------ */

(function arrancar() {
  const lineas = [
    "NEXA_CERT_EXTRACTOR v2.0",
    "objetivo: aula.jomiser.com",
    soportaCarpeta()
      ? "al iniciar se pedirá la carpeta de guardado"
      : "este navegador descarga un ZIP (guardado en carpeta: Chrome/Edge de escritorio)",
    "esperando documentos...",
  ];
  lineas.forEach((t, i) => setTimeout(() => log(t, i === 0 ? "head" : "info"), i * 190));
  pintarDestino();
  refrescarConteo();
})();

/** Puente sin credenciales de Google: el Web App de Apps Script hace el trabajo. */
export function appsScriptUrl() {
  return String(process.env.APPS_SCRIPT_URL || "").trim();
}

/** Intentos totales ante una respuesta que no es JSON (el primero + los reintentos). */
const INTENTOS = 3;
/** Espera antes de reintentar (ms x numero de intento); se puede cambiar por entorno, las pruebas la ponen a 0. */
const espera = (intento) => Number(process.env.APPS_SCRIPT_REINTENTO_MS ?? 1200) * intento;

const dormir = (ms) => new Promise((r) => setTimeout(r, ms));

/** Una peticion: { r, texto, datos } con `datos` = null si la respuesta no era JSON. */
async function unaPeticion(url, cuerpo) {
  const r = await fetch(url, {
    method: "POST",
    headers: { "Content-Type": "text/plain;charset=utf-8" },
    body: JSON.stringify(cuerpo),
  });
  const texto = await r.text();
  try {
    return { r, texto, datos: JSON.parse(texto.replace(/^﻿/, "").trim()) };
  } catch {
    return { r, texto, datos: null };
  }
}

/** Mensaje legible de una respuesta que no es JSON (normalmente una pagina de error de Google). */
function mensajeDePagina(r, texto) {
  const limpio = texto
    .replace(/<script[\s\S]*?<\/script>/gi, " ")
    .replace(/<style[\s\S]*?<\/style>/gi, " ")
    .replace(/<[^>]+>/g, " ")
    .replace(/&nbsp;/gi, " ")
    .replace(/\s+/g, " ")
    .trim();
  // La pagina de error de Google a veces lleva el mensaje dentro de un
  // <script>, que el recorte de arriba elimina: se rescata de ahi.
  const enScript = /(?:Exception|Error)[: ][^"<\\]{10,240}/.exec(texto);
  return (
    limpio ||
    (enScript && enScript[0].trim()) ||
    `respuesta ilegible de Apps Script (HTTP ${r.status}${texto.trim() ? "" : ", vacia"})`
  );
}

/**
 * Cuando el script tarda (arranque en frio, o la hoja recalculando), Google
 * entrega la respuesta rota: una pagina 404 "No se encontro la pagina Drive"
 * o un HTML vacio, AUNQUE la ejecucion si haya ocurrido (el cambio queda en la
 * hoja). Las acciones del puente son idempotentes (guardar reescribe la misma
 * fila, alta comprueba que el DNI no exista, subir reemplaza el archivo), asi
 * que ante una respuesta que no es JSON se reintenta: la segunda suele salir
 * en unos segundos con el script ya caliente.
 *
 * Un error que SI viene en JSON (validacion, hoja inexistente...) es real y no
 * se reintenta.
 */
export async function pedirAppsScript(servicio, cuerpo) {
  const url = appsScriptUrl();
  if (!url) throw new Error("Apps Script no esta configurado: define APPS_SCRIPT_URL");
  const envio = { servicio, ...cuerpo, token: process.env.APPS_SCRIPT_TOKEN || "" };

  let ultima = null;
  for (let intento = 1; intento <= INTENTOS; intento++) {
    ultima = await unaPeticion(url, envio);
    if (ultima.datos) break;
    if (intento < INTENTOS) await dormir(espera(intento));
  }

  const { r, texto, datos } = ultima;
  if (!datos) {
    const e = new Error(mensajeDePagina(r, texto));
    e.ambiguo = true; // la ejecucion pudo haber ocurrido: quien escribe debe verificarlo
    throw e;
  }
  if (!r.ok || datos.ok === false || datos.error) throw new Error(datos.error || `Apps Script respondio HTTP ${r.status}`);
  return datos;
}

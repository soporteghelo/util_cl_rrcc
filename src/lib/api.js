/** Cliente de las funciones serverless. */

async function pedir(ruta, cuerpo, senal) {
  const res = await fetch(ruta, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(cuerpo),
    signal: senal,
  });
  return res;
}

async function json(ruta, cuerpo, senal) {
  const res = await pedir(ruta, cuerpo, senal);
  const datos = await res.json().catch(() => ({ error: `respuesta ilegible (HTTP ${res.status})` }));
  if (!res.ok) {
    const e = new Error(datos.error || `HTTP ${res.status}`);
    e.estado = res.status;
    e.detalle = datos;
    throw e;
  }
  return datos;
}

/** Inventario de certificados de un DNI. */
export function buscar(cuerpo, senal) {
  return json("/api/search", cuerpo, senal);
}

/** Descarga UN certificado. Devuelve { pdf: ArrayBuffer }. */
export async function descargar(cuerpo, senal) {
  const res = await pedir("/api/download", cuerpo, senal);
  const tipo = res.headers.get("content-type") || "";

  if (tipo.includes("application/pdf")) {
    return { pdf: await res.arrayBuffer() };
  }

  const datos = await res.json().catch(() => ({ error: `respuesta ilegible (HTTP ${res.status})` }));
  if (datos.sinCertificado) return datos;
  throw new Error(datos.error || `HTTP ${res.status}`);
}

/* ------------------------------------------------------------------ */
/* Cola hacia Apps Script (Sheets y Drive comparten el mismo Web App)   */
/* ------------------------------------------------------------------ */

/**
 * `/api/sheets` y `/api/drive-output` terminan las dos en el mismo Web App
 * de Apps Script. Con dos o mas pedidos simultaneos (p.ej. "contexto" +
 * "cargos" al montar la pestaña, o eso mas la foto del fotocheck) Google
 * satura las ejecuciones concurrentes del Web App: cada pedido pasa de
 * tardar unos segundos a tardar 30-100+, y a veces ni siquiera devuelve lo
 * que se le pidio (llega la respuesta de otro pedido, o una pagina de error
 * en vez de JSON). Por eso todo lo que hable con Apps Script se turna aca,
 * uno a la vez, sin importar desde que parte de la app se dispare.
 */
let colaAppsScript = Promise.resolve();
function unoALaVez(tarea) {
  const turno = colaAppsScript.then(tarea, tarea);
  colaAppsScript = turno.then(
    () => {},
    () => {}
  ); // un pedido fallido no debe atascar la fila
  return turno;
}

/* ------------------------------------------------------------------ */
/* Base en Google Sheets                                               */
/* ------------------------------------------------------------------ */

/** Una accion de /api/sheets: contexto | persona | guardar | alta | cargos | setup. */
export function sheets(cuerpo, senal) {
  return unoALaVez(() => json("/api/sheets", cuerpo, senal));
}

/* ------------------------------------------------------------------ */
/* Salidas en Google Drive                                             */
/* ------------------------------------------------------------------ */

/** Una accion de /api/drive-output: carpeta | subir | foto | bajar | listar. */
export function drive(cuerpo, senal) {
  return unoALaVez(() => json("/api/drive-output", cuerpo, senal));
}

/* ------------------------------------------------------------------ */
/* Binarios <-> base64                                                 */
/* ------------------------------------------------------------------ */

/**
 * El JSON de las funciones no transporta binarios, asi que los PDF y las
 * imagenes viajan en base64. Se convierte por trozos porque
 * `String.fromCharCode(...bytes)` con un array de 400 KB revienta la pila.
 */
export function aBase64(bufferOBlob) {
  const bytes = bufferOBlob instanceof Uint8Array ? bufferOBlob : new Uint8Array(bufferOBlob);
  let binario = "";
  const trozo = 0x8000;
  for (let i = 0; i < bytes.length; i += trozo) {
    binario += String.fromCharCode.apply(null, bytes.subarray(i, i + trozo));
  }
  return btoa(binario);
}

export function desdeBase64(texto) {
  const binario = atob(String(texto || ""));
  const bytes = new Uint8Array(binario.length);
  for (let i = 0; i < binario.length; i++) bytes[i] = binario.charCodeAt(i);
  return bytes;
}

export async function blobABase64(blob) {
  return aBase64(await blob.arrayBuffer());
}

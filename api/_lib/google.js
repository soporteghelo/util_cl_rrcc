/**
 * Autenticacion con Google usando una cuenta de servicio.
 *
 * Sin dependencias: se firma el JWT con `node:crypto` (RS256) y se canjea
 * por un access token en el endpoint OAuth2. Es media pagina de codigo y
 * evita arrastrar `googleapis`, que pesa decenas de MB y tarda en arrancar
 * en frio en una funcion serverless.
 *
 * Variables de entorno (Vercel → Settings → Environment Variables):
 *   GOOGLE_SA_EMAIL        client_email del JSON de la cuenta de servicio
 *   GOOGLE_SA_PRIVATE_KEY  private_key del mismo JSON (los "\n" pueden ir
 *                          escapados: Vercel no admite saltos de linea)
 *   GOOGLE_SA_JSON         alternativa: el JSON completo en una variable
 *
 * El Spreadsheet y las carpetas de Drive tienen que estar compartidos con
 * GOOGLE_SA_EMAIL como **Editor**: la cuenta de servicio es un usuario mas.
 */

import crypto from "node:crypto";

const OAUTH_TOKEN = "https://oauth2.googleapis.com/token";

export const AMBITOS = [
  "https://www.googleapis.com/auth/spreadsheets",
  "https://www.googleapis.com/auth/drive",
];

/** El token dura 1 h; se renueva 2 min antes para no usarlo al filo. */
const MARGEN_MS = 120000;
let cache = null;

/* ------------------------------------------------------------------ */
/* Credenciales                                                        */
/* ------------------------------------------------------------------ */

export function credenciales() {
  const json = process.env.GOOGLE_SA_JSON;
  if (json) {
    try {
      const o = JSON.parse(json);
      if (o.client_email && o.private_key) {
        return { email: o.client_email, clave: normalizarClave(o.private_key) };
      }
    } catch {
      throw new Error("GOOGLE_SA_JSON no es un JSON valido");
    }
  }
  const email = process.env.GOOGLE_SA_EMAIL;
  const clave = process.env.GOOGLE_SA_PRIVATE_KEY;
  if (!email || !clave) return null;
  return { email, clave: normalizarClave(clave) };
}

/** true si la app puede hablar con Sheets/Drive como cuenta de servicio. */
export const hayCuentaDeServicio = () => Boolean(credenciales());

/**
 * Vercel guarda la clave en una sola linea con "\n" literales; PEM necesita
 * saltos reales. Tambien se aceptan claves pegadas entre comillas.
 */
function normalizarClave(bruta) {
  let k = String(bruta).trim();
  if (/^".*"$/s.test(k) || /^'.*'$/s.test(k)) k = k.slice(1, -1);
  return k.replace(/\\n/g, "\n");
}

/* ------------------------------------------------------------------ */
/* JWT                                                                 */
/* ------------------------------------------------------------------ */

const base64url = (b) => Buffer.from(b).toString("base64").replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");

function firmarJwt({ email, clave }, ambitos) {
  const ahora = Math.floor(Date.now() / 1000);
  const cabecera = base64url(JSON.stringify({ alg: "RS256", typ: "JWT" }));
  const cuerpo = base64url(
    JSON.stringify({
      iss: email,
      scope: ambitos.join(" "),
      aud: OAUTH_TOKEN,
      iat: ahora,
      exp: ahora + 3600,
    })
  );
  const contenido = `${cabecera}.${cuerpo}`;
  let firma;
  try {
    firma = crypto.createSign("RSA-SHA256").update(contenido).sign(clave);
  } catch (e) {
    throw new Error(
      "no se pudo firmar con GOOGLE_SA_PRIVATE_KEY (revisa que este completa, " +
        'con las lineas "-----BEGIN PRIVATE KEY-----" y sus saltos): ' + (e.message || e)
    );
  }
  return `${contenido}.${base64url(firma)}`;
}

/* ------------------------------------------------------------------ */
/* Access token                                                        */
/* ------------------------------------------------------------------ */

/**
 * Devuelve un access token, reutilizando el de la invocacion anterior
 * mientras siga vivo (las funciones de Vercel reusan el proceso en caliente).
 */
export async function token(ambitos = AMBITOS) {
  const clave = ambitos.join(" ");
  if (cache && cache.clave === clave && cache.expira - MARGEN_MS > Date.now()) return cache.token;

  const cred = credenciales();
  if (!cred) {
    throw new Error(
      "faltan las credenciales de Google: define GOOGLE_SA_EMAIL y GOOGLE_SA_PRIVATE_KEY (o GOOGLE_SA_JSON)"
    );
  }

  const res = await fetch(OAUTH_TOKEN, {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({
      grant_type: "urn:ietf:params:oauth:grant-type:jwt-bearer",
      assertion: firmarJwt(cred, ambitos),
    }).toString(),
  });

  const texto = await res.text();
  let datos = {};
  try {
    datos = JSON.parse(texto);
  } catch {
    /* respuesta no-JSON: se informa el texto crudo */
  }
  if (!res.ok || !datos.access_token) {
    const detalle = datos.error_description || datos.error || texto.slice(0, 200);
    throw new Error(`Google no entrego el token (HTTP ${res.status}): ${detalle}`);
  }

  cache = {
    clave,
    token: datos.access_token,
    expira: Date.now() + Number(datos.expires_in || 3600) * 1000,
  };
  return cache.token;
}

/* ------------------------------------------------------------------ */
/* Llamadas a las APIs                                                 */
/* ------------------------------------------------------------------ */

/**
 * fetch autenticado contra las APIs de Google, con el error ya desenvuelto:
 * Google devuelve el motivo real dentro de `error.message` y sin esto solo
 * se veria "HTTP 403".
 */
export async function pedirGoogle(url, opciones = {}) {
  const acceso = await token(opciones.ambitos || AMBITOS);
  const cabeceras = Object.assign({ Authorization: `Bearer ${acceso}` }, opciones.headers || {});

  const res = await fetch(url, {
    method: opciones.method || "GET",
    headers: cabeceras,
    body: opciones.body,
  });

  if (opciones.binario) {
    const buffer = Buffer.from(await res.arrayBuffer());
    if (!res.ok) throw new Error(mensajeDeError(res.status, buffer.toString("utf8")));
    return buffer;
  }

  const texto = await res.text();
  if (!res.ok) throw new Error(mensajeDeError(res.status, texto));
  if (!texto) return null;
  try {
    return JSON.parse(texto);
  } catch {
    return texto;
  }
}

function mensajeDeError(status, texto) {
  try {
    const o = JSON.parse(texto);
    const msg = o?.error?.message || o?.error_description || o?.error;
    if (msg) return `Google HTTP ${status}: ${msg}`;
  } catch {
    /* cuerpo no-JSON */
  }
  return `Google HTTP ${status}: ${String(texto).slice(0, 200)}`;
}

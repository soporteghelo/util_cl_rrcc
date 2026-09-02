/**
 * Nucleo de extraccion: JOMISER + EIN (WebNexa).
 * Sin dependencias externas: usa fetch y zlib de Node.
 */

import zlib from "node:zlib";

export const JOMISER_BASE = "https://aula.jomiser.com";
export const EIN_BASE = "http://44.193.188.247/WebNexa";
export const EIN_LOGIN = `${EIN_BASE}/serviceit/Login_g.aspx`;
export const EIN_GRID = `${EIN_BASE}/serviceit/WebFormContraCerti.aspx`;

const PREFIJO = "ctl00$ContentPlaceHolder1$";
const UA =
  "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/125 Safari/537.36";

/* ------------------------------------------------------------------ */
/* DNI                                                                 */
/* ------------------------------------------------------------------ */

/**
 * Normaliza un documento. Excel guarda los DNI como numero y se come los
 * ceros de la izquierda: 07481337 llega como 7481337. Se rellena a 8 digitos.
 */
export function normalizarDni(valor, largo = 8) {
  if (valor === null || valor === undefined) return null;
  let bruto = String(valor).trim();
  if (!bruto) return null;

  // Notacion cientifica de Excel (7.1481337E+7)
  if (/^\d+(\.\d+)?[eE][+-]?\d+$/.test(bruto)) {
    const n = Number(bruto);
    if (Number.isFinite(n)) bruto = String(Math.round(n));
  }
  // "71481337.0" -> "71481337"
  if (/^\d+\.0+$/.test(bruto)) bruto = bruto.split(".")[0];

  const digitos = bruto.replace(/\D/g, "");
  if (!digitos) return null;

  let dni = digitos;
  let relleno = 0;
  if (digitos.length < largo) {
    dni = digitos.padStart(largo, "0");
    relleno = largo - digitos.length;
  }
  return {
    dni,
    original: String(valor).trim(),
    relleno,
    // >8 digitos = carne de extranjeria u otro documento; se permite igual
    largoAtipico: dni.length !== largo,
  };
}

/* ------------------------------------------------------------------ */
/* HTTP con cookies y reintentos                                       */
/* ------------------------------------------------------------------ */

export class Jar {
  constructor(inicial) {
    this.cookies = new Map();
    if (inicial) this.cargar(inicial);
  }
  cargar(cadena) {
    for (const parte of String(cadena).split(/;\s*/)) {
      const i = parte.indexOf("=");
      if (i > 0) this.cookies.set(parte.slice(0, i).trim(), parte.slice(i + 1).trim());
    }
  }
  guardar(respuesta) {
    const lista =
      typeof respuesta.headers.getSetCookie === "function"
        ? respuesta.headers.getSetCookie()
        : [respuesta.headers.get("set-cookie")].filter(Boolean);
    for (const c of lista) {
      const primero = String(c).split(";")[0];
      const i = primero.indexOf("=");
      if (i > 0) this.cookies.set(primero.slice(0, i).trim(), primero.slice(i + 1).trim());
    }
  }
  get cabecera() {
    return [...this.cookies].map(([k, v]) => `${k}=${v}`).join("; ");
  }
  get vacio() {
    return this.cookies.size === 0;
  }
}

const dormir = (ms) => new Promise((r) => setTimeout(r, ms));

/**
 * fetch que sigue los redirects a mano para poder capturar las cookies que
 * el servidor entrega EN los 302 (ASP.NET manda ahi la cookie de sesion).
 */
export async function pedir(url, { metodo = "GET", cuerpo = null, jar, referer, intentos = 3, timeout = 45000 } = {}) {
  let ultimo;
  for (let intento = 0; intento < intentos; intento++) {
    try {
      let actual = url;
      let met = metodo;
      let datos = cuerpo;

      for (let salto = 0; salto < 6; salto++) {
        const cabeceras = {
          "User-Agent": UA,
          Accept: "text/html,application/xhtml+xml,application/pdf,*/*",
          "Accept-Language": "es-ES,es;q=0.9",
        };
        if (jar && !jar.vacio) cabeceras.Cookie = jar.cabecera;
        if (referer) cabeceras.Referer = referer;
        if (met === "POST" && datos) cabeceras["Content-Type"] = "application/x-www-form-urlencoded";

        const ctrl = new AbortController();
        const t = setTimeout(() => ctrl.abort(), timeout);
        let res;
        try {
          res = await fetch(actual, {
            method: met,
            headers: cabeceras,
            body: met === "POST" ? datos : undefined,
            redirect: "manual",
            signal: ctrl.signal,
          });
        } finally {
          clearTimeout(t);
        }

        if (jar) jar.guardar(res);

        if (res.status >= 300 && res.status < 400) {
          const destino = res.headers.get("location");
          if (!destino) return { res, url: actual, buffer: Buffer.from(await res.arrayBuffer()) };
          actual = new URL(destino, actual).toString();
          met = "GET"; // tras un 302, el navegador cambia a GET
          datos = null;
          continue;
        }

        const buffer = Buffer.from(await res.arrayBuffer());
        if (res.status >= 500) throw new Error(`HTTP ${res.status} en ${actual}`);
        return { res, url: actual, buffer };
      }
      throw new Error("demasiados redirects");
    } catch (e) {
      ultimo = e;
      if (intento < intentos - 1) await dormir(1200 + intento * 1800);
    }
  }
  throw ultimo;
}

/* ------------------------------------------------------------------ */
/* Utilidades HTML / PDF                                               */
/* ------------------------------------------------------------------ */

const ENTIDADES = { amp: "&", lt: "<", gt: ">", quot: '"', "#39": "'", apos: "'", nbsp: " " };

export function desescapar(texto) {
  return String(texto ?? "")
    .replace(/&#(\d+);/g, (_, n) => String.fromCharCode(Number(n)))
    .replace(/&#x([0-9a-f]+);/gi, (_, n) => String.fromCharCode(parseInt(n, 16)))
    .replace(/&(\w+);/g, (m, n) => ENTIDADES[n] ?? m);
}

export function sinTags(html) {
  return desescapar(String(html ?? "").replace(/<[^>]+>/g, " "))
    .replace(/\s+/g, " ")
    .trim();
}

/** Todos los <input type="hidden"> de una pagina ASP.NET. */
export function camposOcultos(html) {
  const campos = {};
  const tags = String(html).match(/<input[^>]*type="hidden"[^>]*>/gi) || [];
  for (const tag of tags) {
    const n = tag.match(/name="([^"]+)"/i);
    const v = tag.match(/value="([^"]*)"/i);
    if (n) campos[desescapar(n[1])] = v ? desescapar(v[1]) : "";
  }
  return campos;
}

const form = (obj) => new URLSearchParams(obj).toString();

/** Texto legible de un PDF (streams FlateDecode). */
export function textoDePdf(buffer) {
  const crudo = buffer.toString("latin1");
  const partes = [];
  const re = /stream\r?\n([\s\S]*?)endstream/g;
  let m;
  while ((m = re.exec(crudo))) {
    try {
      partes.push(zlib.inflateSync(Buffer.from(m[1], "latin1")).toString("latin1"));
    } catch {
      /* stream no-Flate (imagenes DCT); se ignora */
    }
  }
  return partes.join(" ");
}

const esPdf = (buffer) => buffer.length > 4 && buffer.subarray(0, 4).toString("latin1") === "%PDF";

/* ------------------------------------------------------------------ */
/* JOMISER                                                             */
/* ------------------------------------------------------------------ */

export async function jomiserBuscar(dni) {
  const { buffer } = await pedir(`${JOMISER_BASE}/certificados?dni=${encodeURIComponent(dni)}`);
  const html = buffer.toString("utf8");

  const mp = html.match(/PARTICIPANTE:\s*<\/label>\s*<span>([\s\S]*?)<\/span>/i);
  // Sin resultados JOMISER pinta "-": es un marcador, no un nombre.
  const crudo = mp ? sinTags(mp[1]) : "";
  const participante = crudo === "-" ? "" : crudo;

  const mi = html.match(/COD\.\s*IDENTIDAD:\s*<\/label>\s*<span>([\s\S]*?)<\/span>/i);
  const identidad = mi ? sinTags(mi[1]) : "";

  const items = [];
  const tabla = html.match(/<table[^>]*id="example-table"[\s\S]*?<\/table>/i);
  if (tabla) {
    const tbody = tabla[0].match(/<tbody[^>]*>([\s\S]*?)<\/tbody>/i);
    const filas = (tbody ? tbody[1] : tabla[0]).match(/<tr[^>]*>[\s\S]*?<\/tr>/gi) || [];
    for (const fila of filas) {
      const celdas = fila.match(/<td[^>]*>([\s\S]*?)<\/td>/gi) || [];
      if (celdas.length < 4) continue;
      const val = (i) => sinTags(celdas[i].replace(/^<td[^>]*>|<\/td>$/gi, ""));
      const accion = celdas[3];
      const enlace = accion.match(/href="[^"]*exportar-certificado\/(\d+)"/i);
      items.push({
        fuente: "JOMISER",
        id: enlace ? enlace[1] : null,
        empresa: val(0),
        curso: val(1),
        fecha: val(2),
        estado: enlace ? "DISPONIBLE" : sinTags(accion) || "SIN CERTIFICADO",
        descargable: Boolean(enlace),
      });
    }
  }

  // JOMISER busca por coincidencia exacta; aun asi verificamos lo devuelto.
  const coincide = !identidad || identidad === "-" || identidad === dni;
  return {
    participante: coincide ? participante : "",
    identidad,
    items: coincide ? items : [],
    aviso: coincide ? null : `JOMISER devolvio el documento ${identidad} para la busqueda ${dni}`,
  };
}

export async function jomiserDescargar(id) {
  if (!/^\d+$/.test(String(id))) throw new Error("id de certificado invalido");
  const { buffer, res } = await pedir(`${JOMISER_BASE}/pdf/exportar-certificado/${id}`, { timeout: 60000 });
  if (!esPdf(buffer)) throw new Error(`respuesta no-PDF (${res.headers.get("content-type") || "?"})`);
  return buffer;
}

/* ------------------------------------------------------------------ */
/* EIN / WebNexa                                                       */
/* ------------------------------------------------------------------ */

export async function einLogin(usuario, password, jar = new Jar()) {
  const inicio = await pedir(EIN_LOGIN, { jar });
  const campos = camposOcultos(inicio.buffer.toString("utf8"));
  campos.txtusuario = usuario;
  campos.txtpass = password;
  campos.btnlogg = "Ingresar";

  const salida = await pedir(EIN_LOGIN, { metodo: "POST", cuerpo: form(campos), jar, referer: EIN_LOGIN });
  const html = salida.buffer.toString("utf8");
  if (salida.url.includes("Login_g.aspx") || html.includes('id="txtusuario"')) {
    throw new Error("credenciales EIN rechazadas");
  }
  return jar;
}

/** Devuelve el HTML del grid tras buscar por DNI, y la empresa seleccionada. */
async function einGridBuscado(jar, dni) {
  const pagina = await pedir(EIN_GRID, { jar });
  const html = pagina.buffer.toString("utf8");
  if (!html.includes("DropInteresados")) throw new Error("sesion EIN expirada");

  let empresa = "2";
  const combo = html.match(/id="ctl00_ContentPlaceHolder1_DropInteresados"[\s\S]*?<\/select>/i);
  if (combo) {
    const sel =
      combo[0].match(/<option[^>]*selected[^>]*value="([^"]*)"/i) ||
      combo[0].match(/<option[^>]*value="([^"]*)"[^>]*selected/i);
    if (sel) empresa = desescapar(sel[1]);
  }

  const campos = camposOcultos(html);
  campos[`${PREFIJO}DropInteresados`] = empresa;
  campos[`${PREFIJO}DropOpf`] = "DNI";
  campos[`${PREFIJO}txtdat`] = dni;
  campos[`${PREFIJO}btnfil`] = "Buscar";

  const res = await pedir(EIN_GRID, { metodo: "POST", cuerpo: form(campos), jar, referer: EIN_GRID });
  return { html: res.buffer.toString("utf8"), empresa };
}

function einFilas(html, dni) {
  const filas = [];
  const tabla = html.match(/id="ctl00_ContentPlaceHolder1_GridView1"[\s\S]*?<\/table>/i);
  if (!tabla) return { filas, descartadas: 0 };

  const trs = tabla[0].match(/<tr[^>]*>[\s\S]*?<\/tr>/gi) || [];
  let indice = 0;
  let descartadas = 0;
  for (const tr of trs) {
    const tds = tr.match(/<td[^>]*>([\s\S]*?)<\/td>/gi) || [];
    if (!tds.length) continue; // cabecera
    const c = tds.map((x) => sinTags(x.replace(/^<td[^>]*>|<\/td>$/gi, "")));
    if (c.length < 12) continue;

    const fila = {
      fuente: "EIN",
      indice, // posicion real dentro del GridView (Select$N)
      cod: c[1],
      documento: c[2],
      apellidos: c[3],
      nombres: c[4],
      cargo: c[5],
      curso: c[6],
      promedio: c[7],
      condicion: c[8],
      inicio: c[9],
      final: c[10],
    };
    indice++;

    // CRITICO: EIN busca por coincidencia PARCIAL. Buscar "0350889" devuelve
    // los certificados de "10350889". Solo aceptamos coincidencia exacta.
    if (fila.documento !== dni) {
      descartadas++;
      continue;
    }
    filas.push(fila);
  }
  return { filas, descartadas };
}

export async function einBuscar(jar, dni) {
  const { html } = await einGridBuscado(jar, dni);
  const { filas, descartadas } = einFilas(html, dni);
  const participante = filas.length ? `${filas[0].apellidos}, ${filas[0].nombres}` : "";
  return {
    participante,
    items: filas.map((f) => ({ ...f, estado: "DISPONIBLE", descargable: true })),
    descartadas,
    aviso: descartadas
      ? `${descartadas} fila(s) de otro documento descartadas (EIN busca por coincidencia parcial)`
      : null,
  };
}

/** Abre el reporte de una fila. Devuelve null si ese registro no tiene certificado. */
async function einAbrirReporte(jar, dni, cod) {
  const { html, empresa } = await einGridBuscado(jar, dni);
  const { filas } = einFilas(html, dni);

  // Se localiza por COD, no por posicion: el orden del grid puede cambiar.
  const fila = filas.find((f) => f.cod === String(cod));
  if (!fila) throw new Error(`el registro COD ${cod} ya no aparece para el DNI ${dni}`);

  const campos = camposOcultos(html);
  campos.__EVENTTARGET = `${PREFIJO}GridView1`;
  campos.__EVENTARGUMENT = `Select$${fila.indice}`;
  campos[`${PREFIJO}DropInteresados`] = empresa;
  campos[`${PREFIJO}DropOpf`] = "DNI";
  campos[`${PREFIJO}txtdat`] = dni;
  delete campos[`${PREFIJO}btnfil`];

  const res = await pedir(EIN_GRID, { metodo: "POST", cuerpo: form(campos), jar, referer: EIN_GRID });
  const reporte = res.buffer.toString("utf8");

  // Sin visor Crystal => ese registro no tiene certificado emitido (desaprobado).
  const ocultos = camposOcultos(reporte);
  if (!Object.keys(ocultos).some((k) => k.startsWith("__CRYSTALSTATE"))) return null;

  return { url: res.url, html: reporte, fila };
}

/** Ejecuta el "Print to PDF" del visor Crystal. */
async function einExportar(jar, url, html) {
  const campos = camposOcultos(html);
  const clave = Object.keys(campos).find((k) => k.startsWith("__CRYSTALSTATE"));
  const control = clave.slice("__CRYSTALSTATE".length); // ctl00$...$CrystalReportViewer1
  const vid = control.split("$").pop();

  campos.__EVENTTARGET = control;
  campos.__EVENTARGUMENT = '{"text":"PDF", "range":"false", "tb":"crexport"}';
  campos[`${vid}_toptoolbar_search_textField`] = "Find...";
  campos[`text_${vid}_toptoolbar_selectPg`] = "1 of 1+";
  campos[`text_${vid}_toptoolbar_zoom`] = "100%";

  const res = await pedir(url, { metodo: "POST", cuerpo: form(campos), jar, referer: url, timeout: 55000, intentos: 2 });
  return res.buffer;
}

/**
 * Comprueba que el PDF sea de la persona correcta.
 * El servidor EIN devuelve de forma intermitente el certificado de OTRA
 * persona (bug de concurrencia del reporte Crystal).
 *   true  -> correcto
 *   false -> es de otra persona
 *   null  -> no verificable
 */
export function einValidar(pdf, cod, dni) {
  const texto = textoDePdf(pdf);
  if (!texto) return null;
  if (texto.includes(String(cod) + dni)) return true; // registro INRC ... - <COD><DNI>
  const hallados = [...texto.matchAll(/Con DNI:\s*(\d+)/g)].map((m) => m[1]);
  if (hallados.length) return hallados.includes(dni);
  return texto.includes(dni) ? true : null;
}

export async function einDescargar(jar, dni, cod, intentos = 3) {
  let ultimoMotivo = "desconocido";
  for (let intento = 1; intento <= intentos; intento++) {
    const reporte = await einAbrirReporte(jar, dni, cod);
    if (reporte === null) return { pdf: null, motivo: "SIN CERTIFICADO" };

    const pdf = await einExportar(jar, reporte.url, reporte.html);
    if (!esPdf(pdf)) {
      ultimoMotivo = "el servidor no devolvio un PDF";
      await dormir(1500);
      continue;
    }

    const estado = einValidar(pdf, cod, dni);
    if (estado === true) return { pdf, fila: reporte.fila, verificado: true };
    if (estado === null) return { pdf, fila: reporte.fila, verificado: false };

    ultimoMotivo = "el servidor devolvio el certificado de otra persona";
    await dormir(2000);
  }
  throw new Error(`${ultimoMotivo} tras ${intentos} intentos`);
}

/* ------------------------------------------------------------------ */
/* Nombres de archivo                                                  */
/* ------------------------------------------------------------------ */

export function nombreArchivo(texto, max = 90) {
  return (
    String(texto ?? "")
      .replace(/[\\/:*?"<>|\r\n\t]+/g, " ")
      .replace(/\s+/g, " ")
      .trim()
      .replace(/^\.+|\.+$/g, "")
      .slice(0, max)
      .trim() || "SIN_NOMBRE"
  );
}

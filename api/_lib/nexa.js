/**
 * Nucleo de extraccion: JOMISER (aula.jomiser.com).
 * Sin dependencias externas: usa el fetch de Node.
 */

export const JOMISER_BASE = "https://aula.jomiser.com";

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
/* HTTP con reintentos                                                 */
/* ------------------------------------------------------------------ */

const dormir = (ms) => new Promise((r) => setTimeout(r, ms));

export async function pedir(url, { intentos = 3, timeout = 45000 } = {}) {
  let ultimo;
  for (let intento = 0; intento < intentos; intento++) {
    try {
      const ctrl = new AbortController();
      const t = setTimeout(() => ctrl.abort(), timeout);
      let res;
      try {
        res = await fetch(url, {
          headers: {
            "User-Agent": UA,
            Accept: "text/html,application/xhtml+xml,application/pdf,*/*",
            "Accept-Language": "es-ES,es;q=0.9",
          },
          signal: ctrl.signal,
        });
      } finally {
        clearTimeout(t);
      }

      const buffer = Buffer.from(await res.arrayBuffer());
      if (res.status >= 500) throw new Error(`HTTP ${res.status} en ${url}`);
      return { res, buffer };
    } catch (e) {
      ultimo = e;
      if (intento < intentos - 1) await dormir(1200 + intento * 1800);
    }
  }
  throw ultimo;
}

/* ------------------------------------------------------------------ */
/* Utilidades HTML                                                     */
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

export const esPdf = (buffer) => buffer.length > 4 && buffer.subarray(0, 4).toString("latin1") === "%PDF";

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

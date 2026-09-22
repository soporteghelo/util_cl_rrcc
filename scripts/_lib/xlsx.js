/**
 * Lector de .xlsx por entradas sueltas.
 *
 * `_1. BASE DE RIESGOS CRITICOS AESA VERSION 1.xlsx` pesa 300 MB, de los
 * cuales 298 son las 586 fotos incrustadas. Abrirlo con JSZip significaria
 * meterlo entero en memoria para leer una hoja de 3 MB. Aca se lee el
 * directorio central del ZIP y se descomprime SOLO la entrada pedida, con
 * `zlib` y `fs`, sin dependencias.
 *
 * Tambien resuelve la cadena de "imagenes dentro de la celda" (rich values),
 * que es como Excel 365 guarda hoy la columna FOTO:
 *
 *   celda  vm="N"        -> metadata.xml, bloque N-1 de <valueMetadata>
 *     rc v="M"           -> metadata.xml, bloque M de futureMetadata XLRICHVALUE
 *       xlrd:rvb i="K"   -> rdrichvalue.xml, <rv> numero K
 *         primer <v>     -> richValueRel.xml, <rel> numero IDX
 *           r:id         -> richValueRel.xml.rels -> xl/media/imageX.png
 */

import fs from "node:fs";
import zlib from "node:zlib";

/* ------------------------------------------------------------------ */
/* ZIP                                                                 */
/* ------------------------------------------------------------------ */

const FIN_CENTRAL = 0x06054b50;
const ENTRADA_CENTRAL = 0x02014b50;

export class Zip {
  constructor(ruta) {
    this.fd = fs.openSync(ruta, "r");
    this.tamano = fs.fstatSync(this.fd).size;
    this.entradas = this._directorio();
  }

  cerrar() {
    fs.closeSync(this.fd);
  }

  _leer(desde, largo) {
    const buffer = Buffer.alloc(largo);
    fs.readSync(this.fd, buffer, 0, largo, desde);
    return buffer;
  }

  _directorio() {
    // El fin del directorio central esta en los ultimos 64 KB (22 bytes de
    // cabecera + hasta 64 KB de comentario del ZIP).
    const cola = Math.min(this.tamano, 66000);
    const buffer = this._leer(this.tamano - cola, cola);
    let pos = -1;
    for (let i = buffer.length - 22; i >= 0; i--) {
      if (buffer.readUInt32LE(i) === FIN_CENTRAL) {
        pos = i;
        break;
      }
    }
    if (pos < 0) throw new Error("no parece un .xlsx (no se encontro el directorio del ZIP)");

    const total = buffer.readUInt16LE(pos + 10);
    const tamCentral = buffer.readUInt32LE(pos + 12);
    const inicioCentral = buffer.readUInt32LE(pos + 16);
    if (inicioCentral === 0xffffffff) throw new Error("ZIP64 no soportado por este lector");

    const central = this._leer(inicioCentral, tamCentral);
    const mapa = new Map();
    let p = 0;
    for (let i = 0; i < total && p + 46 <= central.length; i++) {
      if (central.readUInt32LE(p) !== ENTRADA_CENTRAL) break;
      const metodo = central.readUInt16LE(p + 10);
      const comprimido = central.readUInt32LE(p + 20);
      const original = central.readUInt32LE(p + 24);
      const largoNombre = central.readUInt16LE(p + 28);
      const largoExtra = central.readUInt16LE(p + 30);
      const largoComent = central.readUInt16LE(p + 32);
      const offset = central.readUInt32LE(p + 42);
      const nombre = central.toString("utf8", p + 46, p + 46 + largoNombre);
      mapa.set(nombre, { metodo, comprimido, original, offset });
      p += 46 + largoNombre + largoExtra + largoComent;
    }
    return mapa;
  }

  tiene(nombre) {
    return this.entradas.has(nombre);
  }

  nombres() {
    return [...this.entradas.keys()];
  }

  /** Contenido de una entrada, como Buffer. */
  leer(nombre) {
    const e = this.entradas.get(nombre);
    if (!e) throw new Error(`el .xlsx no tiene "${nombre}"`);
    // El nombre y el "extra" del encabezado local pueden diferir del central,
    // asi que hay que leerlos de nuevo para saber donde arrancan los datos.
    const local = this._leer(e.offset, 30);
    const largoNombre = local.readUInt16LE(26);
    const largoExtra = local.readUInt16LE(28);
    const datos = this._leer(e.offset + 30 + largoNombre + largoExtra, e.comprimido);
    if (e.metodo === 0) return datos;
    if (e.metodo === 8) return zlib.inflateRawSync(datos, { maxOutputLength: e.original + 1024 });
    throw new Error(`compresion ${e.metodo} no soportada en "${nombre}"`);
  }

  texto(nombre) {
    return this.leer(nombre).toString("utf8");
  }
}

/* ------------------------------------------------------------------ */
/* XML minimo                                                          */
/* ------------------------------------------------------------------ */

const ENTIDADES = { amp: "&", lt: "<", gt: ">", quot: '"', apos: "'" };

export function desescapar(t) {
  return String(t ?? "")
    .replace(/&#(\d+);/g, (_, n) => String.fromCharCode(Number(n)))
    .replace(/&#x([0-9a-f]+);/gi, (_, n) => String.fromCharCode(parseInt(n, 16)))
    .replace(/&(\w+);/g, (m, n) => ENTIDADES[n] ?? m);
}

/** Todos los atributos de una etiqueta suelta. */
function atributos(tag) {
  const o = {};
  for (const m of tag.matchAll(/([\w:.-]+)="([^"]*)"/g)) o[m[1]] = desescapar(m[2]);
  return o;
}

/* ------------------------------------------------------------------ */
/* Hojas                                                               */
/* ------------------------------------------------------------------ */

export function cadenasCompartidas(zip) {
  if (!zip.tiene("xl/sharedStrings.xml")) return [];
  const xml = zip.texto("xl/sharedStrings.xml");
  const salida = [];
  for (const m of xml.matchAll(/<si\b[^>]*>([\s\S]*?)<\/si>/g)) {
    let s = "";
    for (const t of m[1].matchAll(/<t\b[^>]*>([\s\S]*?)<\/t>/g)) s += desescapar(t[1]);
    salida.push(s);
  }
  return salida;
}

/** Nombre de hoja -> ruta de su XML dentro del paquete. */
export function hojas(zip) {
  const wb = zip.texto("xl/workbook.xml");
  const rels = zip.texto("xl/_rels/workbook.xml.rels");

  const porId = new Map();
  for (const m of rels.matchAll(/<Relationship\b[^>]*\/>/g)) {
    const a = atributos(m[0]);
    if (!a.Type?.endsWith("/worksheet")) continue;
    porId.set(a.Id, "xl/" + a.Target.replace(/^\/?xl\//, "").replace(/^\.\.\//, ""));
  }

  const salida = new Map();
  for (const m of wb.matchAll(/<sheet\b[^>]*\/>/g)) {
    const a = atributos(m[0]);
    const ruta = porId.get(a["r:id"]);
    if (ruta) salida.set(a.name, { ruta, oculta: a.state === "hidden" || a.state === "veryHidden" });
  }
  return salida;
}

export function columnaDeRef(ref) {
  const m = /^([A-Z]+)/.exec(ref || "");
  if (!m) return 0;
  let n = 0;
  for (const ch of m[1]) n = n * 26 + (ch.charCodeAt(0) - 64);
  return n - 1;
}

/**
 * Filas de una hoja. Cada celda es { valor, tipo, vm } donde `vm` es el
 * indice de metadatos (el que lleva a la imagen dentro de la celda).
 *
 * Se devuelve el valor CACHEADO de las formulas, que es lo que interesa:
 * el Excel guarda el ultimo resultado calculado junto a la formula.
 */
export function filasDeHoja(zip, ruta, compartidas) {
  const xml = zip.texto(ruta);
  const cuerpo = xml.match(/<sheetData\b[^>]*>([\s\S]*?)<\/sheetData>/);
  if (!cuerpo) return [];

  const filas = [];
  // El orden de las alternativas importa: la autocerrada va PRIMERO. Si se
  // probara antes `<row ...>...</row>`, una fila vacia `<row r="9"/>` casaria
  // como apertura y se comeria todas las filas hasta el siguiente </row>.
  for (const mf of cuerpo[1].matchAll(/<row\b([^>]*?)\/>|<row\b([^>]*?)>([\s\S]*?)<\/row>/g)) {
    const atrFila = atributos("<row " + (mf[1] || mf[2] || "") + ">");
    const numero = Number(atrFila.r || filas.length + 1);
    const celdas = [];
    let secuencial = 0;

    for (const mc of (mf[3] || "").matchAll(/<c\b([^>]*?)\/>|<c\b([^>]*?)>([\s\S]*?)<\/c>/g)) {
      const a = atributos("<c " + (mc[1] || mc[2] || "") + ">");
      const col = a.r ? columnaDeRef(a.r) : secuencial;
      secuencial = col + 1;
      const interior = mc[3] || "";

      let valor = "";
      if (a.t === "inlineStr") {
        for (const t of interior.matchAll(/<t\b[^>]*>([\s\S]*?)<\/t>/g)) valor += desescapar(t[1]);
      } else {
        const v = interior.match(/<v>([\s\S]*?)<\/v>/);
        valor = v ? desescapar(v[1]) : "";
        if (a.t === "s" && valor !== "") valor = compartidas[Number(valor)] ?? "";
      }

      celdas[col] = { valor: String(valor).trim(), tipo: a.t || "n", vm: a.vm ? Number(a.vm) : 0 };
    }
    filas.push({ numero, celdas });
  }
  return filas;
}

/* ------------------------------------------------------------------ */
/* Imagenes dentro de la celda (rich values)                           */
/* ------------------------------------------------------------------ */

/**
 * Resuelve las fotos de la columna FOTO.
 *
 * En este libro la columna D NO guarda la imagen en la celda: guarda la
 * formula CONCATENATE("FOTOS/",DNI,".png"), y las 557 fotos viven en el
 * almacen de rich data como un ARRAY paralelo a las filas de `Tabla1`
 * (rdarray.xml, 616 entradas para las filas 4..619). Es decir: la foto de
 * una persona se localiza por su POSICION en la tabla, no por su celda.
 *
 * Devuelve { porFila, porVm, total }:
 *   porFila(n) -> "xl/media/imageX.png" de la fila n de la hoja
 *   porVm(vm)  -> lo mismo para las celdas que si llevan imagen incrustada
 */
export function resolvedorDeFotos(zip, { filaInicial = 0 } = {}) {
  const nulo = { porFila: () => null, porVm: () => null, total: 0 };
  if (!zip.tiene("xl/metadata.xml") || !zip.tiene("xl/richData/rdrichvalue.xml")) return nulo;

  const meta = zip.texto("xl/metadata.xml");

  // futureMetadata XLRICHVALUE: bloque -> indice de rich value
  const futuros = [];
  const bloqueFuturo = meta.match(
    /<futureMetadata\b[^>]*name="XLRICHVALUE"[^>]*>([\s\S]*?)<\/futureMetadata>/
  );
  if (bloqueFuturo) {
    for (const m of bloqueFuturo[1].matchAll(/<xlrd:rvb\b[^>]*i="(\d+)"/g)) futuros.push(Number(m[1]));
  }

  // valueMetadata: el vm de la celda (1-based) -> bloque de futureMetadata
  const valores = [];
  const bloqueValor = meta.match(/<valueMetadata\b[^>]*>([\s\S]*?)<\/valueMetadata>/);
  if (bloqueValor) {
    for (const m of bloqueValor[1].matchAll(/<bk>([\s\S]*?)<\/bk>/g)) {
      const rc = m[1].match(/<rc\b[^>]*v="(\d+)"/);
      valores.push(rc ? Number(rc[1]) : -1);
    }
  }

  // rdrichvalue: rich value -> indice en richValueRel. Solo los de tipo
  // `_localImage` (s="0") son fotos; los otros son el array y su contenedor.
  const richValues = [];
  for (const m of zip.texto("xl/richData/rdrichvalue.xml").matchAll(/<rv\b([^>]*)>([\s\S]*?)<\/rv>/g)) {
    const estructura = Number(atributos("<rv " + m[1] + ">").s ?? -1);
    const primera = m[2].match(/<v>([^<]*)<\/v>/);
    richValues.push(estructura === 0 && primera ? Number(primera[1]) : -1);
  }

  // richValueRel -> rId -> archivo
  const ids = [];
  if (zip.tiene("xl/richData/richValueRel.xml")) {
    for (const m of zip.texto("xl/richData/richValueRel.xml").matchAll(/<rel\b[^>]*r:id="([^"]+)"/g)) {
      ids.push(m[1]);
    }
  }
  const archivos = new Map();
  if (zip.tiene("xl/richData/_rels/richValueRel.xml.rels")) {
    for (const m of zip
      .texto("xl/richData/_rels/richValueRel.xml.rels")
      .matchAll(/<Relationship\b[^>]*\/>/g)) {
      const a = atributos(m[0]);
      archivos.set(a.Id, "xl/" + a.Target.replace(/^\.\.\//, ""));
    }
  }

  /** rich value -> archivo de imagen */
  const deRichValue = (rv) => {
    const idxRel = richValues[rv];
    if (idxRel === undefined || idxRel < 0) return null;
    const rId = ids[idxRel];
    return rId ? archivos.get(rId) || null : null;
  };

  // rdarray: la columna FOTO de la tabla, una entrada por fila de datos.
  // Las entradas vacias (<v/>) son las personas sin foto cargada.
  const arreglo = [];
  if (zip.tiene("xl/richData/rdarray.xml")) {
    const bloque = zip.texto("xl/richData/rdarray.xml").match(/<a\b[^>]*>([\s\S]*?)<\/a>/);
    if (bloque) {
      for (const m of bloque[1].matchAll(/<v\s+t="([^"]*)"\s*>([^<]*)<\/v>|<v\s*\/>/g)) {
        arreglo.push(m[1] === "r" ? Number(m[2]) : -1);
      }
    }
  }

  return {
    total: arreglo.filter((v) => v >= 0).length,
    porFila(numero) {
      const i = numero - filaInicial;
      if (i < 0 || i >= arreglo.length) return null;
      return arreglo[i] < 0 ? null : deRichValue(arreglo[i]);
    },
    porVm(vm) {
      if (!vm) return null;
      const bloque = valores[vm - 1];
      if (bloque === undefined || bloque < 0) return null;
      const rv = futuros[bloque];
      return rv === undefined ? null : deRichValue(rv);
    },
  };
}

/* ------------------------------------------------------------------ */
/* Tablas                                                              */
/* ------------------------------------------------------------------ */

/**
 * Las tablas del libro: { nombre, ref, filaCabecera, filaInicial, filas }.
 * `Tabla1` es la de BD AESA, y su primera fila de datos es la que alinea el
 * array de fotos.
 */
export function tablas(zip) {
  const salida = [];
  for (const nombre of zip.nombres()) {
    if (!/^xl\/tables\/table\d+\.xml$/.test(nombre)) continue;
    const xml = zip.texto(nombre);
    const a = atributos(xml.match(/<table\b[^>]*>/)?.[0] || "");
    const ref = a.ref || "";
    const m = /^[A-Z]+(\d+):[A-Z]+(\d+)$/.exec(ref);
    if (!m) continue;
    const cabecera = Number(m[1]);
    const cabeceras = Number(a.headerRowCount ?? 1);
    salida.push({
      nombre: a.displayName || a.name || nombre,
      ref,
      filaCabecera: cabecera,
      filaInicial: cabecera + cabeceras,
      filas: Number(m[2]) - cabecera - cabeceras + 1,
    });
  }
  return salida;
}

export const EXTENSION_MIME = {
  png: "image/png",
  jpg: "image/jpeg",
  jpeg: "image/jpeg",
  gif: "image/gif",
  bmp: "image/bmp",
  emf: "image/x-emf",
};

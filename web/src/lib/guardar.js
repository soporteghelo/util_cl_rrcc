/**
 * Guardado de resultados.
 *
 * Una funcion serverless no puede escribir en el disco del usuario, asi que el
 * navegador arma la estructura de carpetas:
 *
 *   <DNI>/JOMISER/*.pdf
 *   <DNI>/EIN/*.pdf
 *   <DNI>/resumen.txt
 *
 * Dos salidas:
 *   - ZIP  -> funciona en todos lados, incluido movil
 *   - Carpeta real -> File System Access API (Chrome/Edge escritorio),
 *     que es lo mas parecido a "elegir la ruta" de la version de escritorio
 */

import JSZip from "jszip";

export const CARPETA_JOMISER = "JOMISER";
export const CARPETA_EIN = "EIN";

export const soportaCarpeta = () => typeof window.showDirectoryPicker === "function";

export function limpiarNombre(texto, max = 90) {
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

/** Texto del resumen por DNI. */
export function construirResumen(objetivo) {
  const L = [];
  L.push("RESUMEN DE DESCARGA DE CERTIFICADOS");
  L.push("=".repeat(62));
  L.push(`DNI          : ${objetivo.dni}`);
  if (objetivo.original && objetivo.original !== objetivo.dni) {
    L.push(`En el archivo: ${objetivo.original}  (rellenado con ceros a la izquierda)`);
  }
  L.push(`Participante : ${objetivo.participante || "-"}`);
  L.push(`Fecha        : ${new Date().toLocaleString("es-PE")}`);
  L.push("");

  for (const [fuente, titulo] of [
    [CARPETA_JOMISER, "JOMISER"],
    [CARPETA_EIN, "EIN"],
  ]) {
    const items = objetivo.items.filter((i) => i.fuente === titulo);
    L.push(`${titulo} (${items.length} registro(s))`);
    L.push("-".repeat(62));
    if (!items.length) L.push("  (sin registros)");
    for (const it of items) {
      const desc = it.fuente === "EIN" ? `COD ${it.cod} | ${it.curso} | ${it.condicion}` : `${it.fecha} | ${it.curso}`;
      L.push(`  [${it.estado}] ${desc}`);
      if (it.archivo) L.push(`      -> ${fuente}/${it.archivo}`);
      if (it.error) L.push(`      !! ${it.error}`);
    }
    L.push("");
  }

  if (objetivo.avisos?.length) {
    L.push("AVISOS");
    L.push("-".repeat(62));
    for (const a of objetivo.avisos) L.push(`  - ${a}`);
  }
  return L.join("\n") + "\n";
}

/** Nombre de archivo de un certificado ya descargado. */
export function nombreDe(item) {
  if (item.fuente === "JOMISER") {
    return limpiarNombre(`${item.fecha}_${item.curso}`) + ".pdf";
  }
  return limpiarNombre(`${item.cod}_${item.curso}_${String(item.inicio || "").replace(/\//g, "-")}`) + ".pdf";
}

function unico(usados, nombre) {
  if (!usados.has(nombre)) {
    usados.add(nombre);
    return nombre;
  }
  const punto = nombre.lastIndexOf(".");
  const base = punto > 0 ? nombre.slice(0, punto) : nombre;
  const ext = punto > 0 ? nombre.slice(punto) : "";
  let n = 2;
  let candidato;
  do {
    candidato = `${base} (${n++})${ext}`;
  } while (usados.has(candidato));
  usados.add(candidato);
  return candidato;
}

/** Asigna nombre unico a cada PDF dentro de su carpeta. */
export function asignarNombres(objetivos) {
  for (const obj of objetivos) {
    const usados = { [CARPETA_JOMISER]: new Set(), [CARPETA_EIN]: new Set() };
    for (const it of obj.items) {
      if (!it.pdf) continue;
      const carpeta = it.fuente === "JOMISER" ? CARPETA_JOMISER : CARPETA_EIN;
      it.archivo = unico(usados[carpeta], nombreDe(it));
    }
  }
}

/* ------------------------------------------------------------------ */
/* Salida: ZIP                                                         */
/* ------------------------------------------------------------------ */

export async function descargarZip(objetivos, alProgreso) {
  const zip = new JSZip();
  let n = 0;

  for (const obj of objetivos) {
    const raiz = zip.folder(limpiarNombre(obj.dni));
    for (const it of obj.items) {
      if (!it.pdf) continue;
      const carpeta = it.fuente === "JOMISER" ? CARPETA_JOMISER : CARPETA_EIN;
      raiz.folder(carpeta).file(it.archivo, it.pdf);
      n++;
    }
    raiz.file("resumen.txt", construirResumen(obj));
  }

  const blob = await zip.generateAsync(
    { type: "blob", compression: "DEFLATE", compressionOptions: { level: 6 } },
    (meta) => alProgreso?.(meta.percent)
  );

  const sello = new Date().toISOString().slice(0, 16).replace(/[:T]/g, "-");
  const nombre =
    objetivos.length === 1 ? `certificados_${objetivos[0].dni}.zip` : `certificados_${objetivos.length}_dni_${sello}.zip`;

  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url;
  a.download = nombre;
  document.body.appendChild(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 4000);

  return { nombre, archivos: n, bytes: blob.size };
}

/* ------------------------------------------------------------------ */
/* Salida: carpeta real del equipo                                     */
/* ------------------------------------------------------------------ */

/** Abre el explorador para elegir la carpeta. Debe llamarse desde un clic. */
export async function elegirCarpeta() {
  return window.showDirectoryPicker({ mode: "readwrite", id: "certificados-nexa" });
}

async function escribirArchivo(dir, nombre, contenido) {
  const fh = await dir.getFileHandle(nombre, { create: true });
  const w = await fh.createWritable();
  await w.write(contenido);
  await w.close();
}

/**
 * Escribe en la carpeta elegida a medida que llegan los PDF, en vez de
 * acumularlos en memoria hasta el final: en lotes grandes evita quedarse sin
 * memoria y deja lo ya descargado en disco aunque se aborte a la mitad.
 */
export class EscritorCarpeta {
  constructor(raiz) {
    this.raiz = raiz;
    this.dnis = new Map(); // dni -> { dir, sub: Map, usados: Map }
    this.escritos = 0;
  }

  get nombre() {
    return this.raiz.name;
  }

  async _ctx(dni) {
    const clave = limpiarNombre(dni);
    if (!this.dnis.has(clave)) {
      this.dnis.set(clave, {
        dir: await this.raiz.getDirectoryHandle(clave, { create: true }),
        sub: new Map(),
        usados: new Map([
          [CARPETA_JOMISER, new Set()],
          [CARPETA_EIN, new Set()],
        ]),
      });
    }
    return this.dnis.get(clave);
  }

  /** Guarda un certificado. Devuelve el nombre final del archivo. */
  async guardarItem(dni, item) {
    const ctx = await this._ctx(dni);
    const carpeta = item.fuente === "JOMISER" ? CARPETA_JOMISER : CARPETA_EIN;
    if (!ctx.sub.has(carpeta)) {
      ctx.sub.set(carpeta, await ctx.dir.getDirectoryHandle(carpeta, { create: true }));
    }
    const nombre = unico(ctx.usados.get(carpeta), nombreDe(item));
    await escribirArchivo(ctx.sub.get(carpeta), nombre, item.pdf);
    this.escritos++;
    return nombre;
  }

  /** Escribe (o reescribe) el resumen del DNI. */
  async guardarResumen(objetivo) {
    const ctx = await this._ctx(objetivo.dni);
    await escribirArchivo(ctx.dir, "resumen.txt", construirResumen(objetivo));
  }
}

/** Guardado en bloque al final (para lo ya descargado en memoria). */
export async function guardarEnCarpeta(objetivos, raizDada) {
  const raiz = raizDada || (await elegirCarpeta());
  const escritor = new EscritorCarpeta(raiz);

  for (const obj of objetivos) {
    for (const it of obj.items) {
      if (!it.pdf) continue;
      it.archivo = await escritor.guardarItem(obj.dni, it);
    }
    await escritor.guardarResumen(obj);
  }

  return { archivos: escritor.escritos, carpeta: raiz.name };
}

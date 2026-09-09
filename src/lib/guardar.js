/**
 * Guardado de resultados.
 *
 * Dos salidas:
 *   - ZIP  -> PDFs sueltos en la raiz, sin subcarpetas ni resumen.
 *             Funciona en todos los navegadores, incluido movil.
 *   - Carpeta real -> File System Access API (Chrome/Edge escritorio):
 *             una subcarpeta por DNI, para que un lote de varias personas no
 *             acabe como cientos de archivos sueltos.
 */

import JSZip from "jszip";

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

/**
 * Nombre del PDF. `conDni` antepone el documento: hace falta cuando todos los
 * certificados van sueltos en la misma carpeta y varias personas podrian
 * coincidir en curso y fecha.
 */
export function nombreDe(item, dni, conDni = false) {
  // fecha vacia (items de Drive: el nombre ya trae todo) no debe dejar un
  // guion bajo colgando al principio.
  const base = [item.fecha, item.curso].filter(Boolean).join("_");
  return limpiarNombre(conDni ? `${dni}_${base}` : base) + ".pdf";
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
    this.dnis = new Map(); // dni -> { dir, usados }
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
        usados: new Set(),
      });
    }
    return this.dnis.get(clave);
  }

  /** Guarda un certificado en <carpeta>/<DNI>/. Devuelve el nombre final. */
  async guardarItem(dni, item) {
    const ctx = await this._ctx(dni);
    const nombre = unico(ctx.usados, nombreDe(item, dni));
    await escribirArchivo(ctx.dir, nombre, item.pdf);
    this.escritos++;
    return nombre;
  }
}

/** Guardado en bloque al final (para lo que siga en memoria). */
export async function guardarEnCarpeta(objetivos, raizDada) {
  const raiz = raizDada || (await elegirCarpeta());
  const escritor = new EscritorCarpeta(raiz);

  for (const obj of objetivos) {
    for (const it of obj.items) {
      if (!it.pdf) continue;
      it.archivo = await escritor.guardarItem(obj.dni, it);
    }
  }
  return { archivos: escritor.escritos, carpeta: raiz.name };
}

/* ------------------------------------------------------------------ */
/* Salida: ZIP                                                         */
/* ------------------------------------------------------------------ */

/**
 * Nombre del ZIP. Con un solo DNI lleva el nombre del participante tal y como
 * lo devuelve JOMISER, mas el documento (dos personas pueden llamarse igual).
 * Si la consulta no trajo nombre, se cae al documento solo.
 */
export function nombreDelZip(objetivos) {
  if (objetivos.length === 1) {
    const obj = objetivos[0];
    // se limpia el nombre ANTES de pegar el documento: si no, los caracteres
    // no validos se vuelven espacios y queda un "JUAN _71481337"
    const persona = obj.participante ? limpiarNombre(obj.participante, 100) : "";
    return (persona ? `${persona}_${obj.dni}` : `certificados_${obj.dni}`) + ".zip";
  }
  const sello = new Date().toISOString().slice(0, 16).replace(/[:T]/g, "-");
  return `certificados_${objetivos.length}_dni_${sello}.zip`;
}

/** Solo los certificados, sueltos en la raiz del ZIP. */
export async function descargarZip(objetivos, alProgreso) {
  const zip = new JSZip();
  const usados = new Set();
  // con varios DNI se antepone el documento para poder distinguir de quien es
  // cada archivo, ya que van todos juntos sin carpetas
  const variosDnis = objetivos.length > 1;
  let n = 0;

  for (const obj of objetivos) {
    for (const it of obj.items) {
      if (!it.pdf) continue;
      it.archivo = unico(usados, nombreDe(it, obj.dni, variosDnis));
      zip.file(it.archivo, it.pdf);
      n++;
    }
  }

  const blob = await zip.generateAsync(
    { type: "blob", compression: "DEFLATE", compressionOptions: { level: 6 } },
    (meta) => alProgreso?.(meta.percent)
  );

  const nombre = nombreDelZip(objetivos);

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

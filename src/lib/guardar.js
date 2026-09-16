/**
 * Guardado de resultados.
 *
 * Dos salidas:
 *   - ZIP  -> con un solo DNI los PDF van sueltos en la raiz; con varios,
 *             cada uno en su propia subcarpeta "NOMBRE_DNI" para no mezclar
 *             los certificados de decenas de personas. Funciona en todos los
 *             navegadores, incluido movil.
 *   - Carpeta real -> File System Access API (Chrome/Edge escritorio):
 *             una subcarpeta por DNI, para que un lote de varias personas no
 *             acabe como cientos de archivos sueltos.
 */

import JSZip from "jszip";

// Desactivado a proposito: la app siempre entrega ZIP al terminar, sin pedir
// carpeta. showDirectoryPicker() depende de un dialogo nativo del SO que en
// algunos entornos (perfiles de navegador con flags de automatizacion, etc.)
// se autocancela sin avisar, dejando la extraccion sin poder arrancar nunca.
export const soportaCarpeta = () => false;

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

/** Nombre del PDF (sin carpeta): fecha_curso, o solo curso si no hay fecha. */
export function nombreDe(item) {
  // fecha vacia (items de Drive: el nombre ya trae todo) no debe dejar un
  // guion bajo colgando al principio.
  const base = [item.fecha, item.curso].filter(Boolean).join("_");
  return limpiarNombre(base) + ".pdf";
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
    const nombre = unico(ctx.usados, nombreDe(item));
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

// se limpia el nombre ANTES de pegar el documento: si no, los caracteres no
// validos se vuelven espacios y queda un "JUAN _71481337"
const nombrePersona = (obj) => (obj.participante ? limpiarNombre(obj.participante, 100) : "");

/**
 * Nombre del ZIP. Con un solo DNI lleva el nombre del participante tal y como
 * lo devuelve JOMISER, mas el documento (dos personas pueden llamarse igual).
 * Si la consulta no trajo nombre, se cae al documento solo.
 */
export function nombreDelZip(objetivos) {
  if (objetivos.length === 1) {
    const obj = objetivos[0];
    const persona = nombrePersona(obj);
    return (persona ? `${persona}_${obj.dni}` : `certificados_${obj.dni}`) + ".zip";
  }
  const sello = new Date().toISOString().slice(0, 16).replace(/[:T]/g, "-");
  return `certificados_${objetivos.length}_dni_${sello}.zip`;
}

/** Carpeta del dueño de los certificados dentro del ZIP: "NOMBRE_DNI". */
function carpetaDe(obj) {
  const persona = nombrePersona(obj);
  return persona ? `${persona}_${obj.dni}` : obj.dni;
}

/**
 * Los certificados de cada DNI. Con un solo documento van sueltos en la raiz;
 * con varios, cada uno en su propia subcarpeta con el nombre del dueño (el
 * DNI es unico en la lista, asi que la carpeta tambien lo es).
 */
export async function descargarZip(objetivos, alProgreso) {
  const zip = new JSZip();
  const variosDnis = objetivos.length > 1;
  let n = 0;

  for (const obj of objetivos) {
    const usados = new Set();
    const prefijo = variosDnis ? `${carpetaDe(obj)}/` : "";
    for (const it of obj.items) {
      if (!it.pdf) continue;
      it.archivo = prefijo + unico(usados, nombreDe(it));
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

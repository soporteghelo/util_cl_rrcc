/**
 * Coteja el Excel original contra la base que ya vive en Google Sheets, y
 * completa en Drive las fotos que falten. Se corre en local, no en Vercel:
 * el archivo pesa 286 MB.
 *
 *   node scripts/migrar-excel.js "C:/ruta/_1. BASE DE RIESGOS CRITICOS AESA VERSION 1.xlsx" --dry-run
 *
 * **No escribe en la hoja.** La migracion de los datos ya esta hecha; lo que
 * queda util del Excel es (a) comprobar que no falte nadie y (b) las 557
 * fotos incrustadas, que no son faciles de sacar de otra forma.
 *
 * Que hace:
 *   1. Lee la hoja `BD AESA` del .xlsx conservando el orden de columnas.
 *   2. Sube a la carpeta FOTOS de Drive, como `<DNI>.png`, las fotos que no
 *      esten ya ahi.
 *   3. Compara documento a documento con la hoja y lista las diferencias.
 *
 * Opciones:
 *   --dry-run        no toca Drive: solo lee el Excel e informa
 *   --sin-fotos      salta la subida de fotos y va directo al cotejo
 *   --desde N        primera fila de datos del Excel (por defecto, la tabla)
 *   --hasta N        ultima fila
 *   --rehacer-fotos  vuelve a subir las fotos que ya estan en Drive
 *   --hoja "NOMBRE"  otra hoja de origen (por defecto "BD AESA")
 */

import fs from "node:fs";
import path from "node:path";
import { cargarEnv, argumentos } from "./_lib/env.js";
import { Zip, hojas, cadenasCompartidas, filasDeHoja, resolvedorDeFotos, tablas } from "./_lib/xlsx.js";

cargarEnv();

const { opciones, sueltos } = argumentos();
const RUTA = sueltos[0];
const HOJA_ORIGEN = typeof opciones.hoja === "string" ? opciones.hoja : "BD AESA";
const DRY = Boolean(opciones["dry-run"]);
const SIN_FOTOS = Boolean(opciones["sin-fotos"]);
const REHACER = Boolean(opciones["rehacer-fotos"]);

if (!RUTA) {
  console.error('uso: node scripts/migrar-excel.js "<ruta al .xlsx>" [--dry-run] [--sin-fotos]');
  process.exit(1);
}
if (!fs.existsSync(RUTA)) {
  console.error(`no existe el archivo: ${RUTA}`);
  process.exit(1);
}

/* Los modulos de red se importan despues de cargar el .env, porque leen las
   variables de entorno al ejecutarse. */
const { CABECERA, INDICE, CODIGOS_RRCC, colCap, colVenc, colTipo, colEstado } = await import(
  "../shared/rrcc.js"
);
const { aIso, estadoDe, vencimientoDe, aplicarCierre, hoyIso, normalizarDocumento } = await import(
  "../shared/estados.js"
);

/* ------------------------------------------------------------------ */
/* Lectura del Excel                                                   */
/* ------------------------------------------------------------------ */

console.log(`\nleyendo ${path.basename(RUTA)} (${(fs.statSync(RUTA).size / 1048576).toFixed(0)} MB)...`);

const zip = new Zip(RUTA);
const hojasLibro = hojas(zip);
const hoja = hojasLibro.get(HOJA_ORIGEN);
if (!hoja) {
  console.error(`el libro no tiene la hoja "${HOJA_ORIGEN}". Tiene: ${[...hojasLibro.keys()].join(", ")}`);
  process.exit(1);
}

const compartidas = cadenasCompartidas(zip);
const filas = filasDeHoja(zip, hoja.ruta, compartidas);
const porNumero = new Map(filas.map((f) => [f.numero, f]));

const tabla = tablas(zip).find((t) => t.filas > 50) || null;
const filaInicial = Number(opciones.desde) || tabla?.filaInicial || 4;
const filaFinal = Number(opciones.hasta) || (tabla ? tabla.filaInicial + tabla.filas - 1 : Math.max(...porNumero.keys()));
const fotos = resolvedorDeFotos(zip, { filaInicial });

console.log(`hoja "${HOJA_ORIGEN}": filas de datos ${filaInicial}..${filaFinal}`);
console.log(`fotos incrustadas: ${fotos.total}`);

/* ------------------------------------------------------------------ */
/* Excel -> fila de PERSONAL                                           */
/* ------------------------------------------------------------------ */

/** Columnas que en el Excel son seriales y aca pasan a texto ISO. */
const COLUMNAS_FECHA = new Set([
  INDICE["F. Ex. Medico"],
  INDICE["F. Vencimiento"],
  INDICE["FECHA MINIMA"],
  ...CODIGOS_RRCC.flatMap((c) => [colCap(c), colVenc(c)]),
]);

const HOY = hoyIso();

function aFilaPersonal(fila) {
  const salida = CABECERA.map(() => "");
  // A..CP del Excel caen 1:1 en la hoja de personal.
  for (let i = 0; i < Math.min(fila.celdas.length, CABECERA.length); i++) {
    const celda = fila.celdas[i];
    if (!celda || celda.valor === "") continue;
    if (celda.valor === "#VALUE!" || celda.valor === "#N/A" || celda.valor === "#REF!") continue;
    salida[i] = COLUMNAS_FECHA.has(i) ? aIso(celda.valor) : celda.valor;
  }

  const dni = String(salida[INDICE["DNI"]] || "").replace(/\D/g, "");
  if (dni) salida[INDICE["DNI"]] = dni.length < 8 ? dni.padStart(8, "0") : dni;

  // La columna FOTO no lleva la imagen ni un id: lleva la ruta dentro de la
  // carpeta RRCC de Drive, que es como ya esta armada la hoja.
  salida[INDICE["FOTO"]] = salida[INDICE["DNI"]] ? `FOTOS/${salida[INDICE["DNI"]]}.png` : "";

  // Los estados y vencimientos cacheados del .xlsx son de la ultima apertura:
  // se recalculan a la fecha de hoy con las mismas reglas del Excel.
  for (const codigo of CODIGOS_RRCC) {
    const cap = aIso(salida[colCap(codigo)]);
    salida[colCap(codigo)] = cap;
    salida[colVenc(codigo)] = vencimientoDe(codigo, cap, null);
    salida[colEstado(codigo)] = estadoDe(cap, HOY);
    const tipo = String(salida[colTipo(codigo)] || "").trim().toUpperCase();
    salida[colTipo(codigo)] = tipo === "A" || tipo === "C" ? tipo : "";
  }
  aplicarCierre(salida, HOY);
  return salida;
}

const registros = [];
const sinDni = [];
const dnisVistos = new Map();
const duplicados = [];

for (let n = filaInicial; n <= filaFinal; n++) {
  const fila = porNumero.get(n);
  if (!fila) continue;
  const dniCrudo = String(fila.celdas[INDICE["DNI"]]?.valor || "").replace(/\D/g, "");
  if (!dniCrudo) {
    if (fila.celdas[INDICE["Apellidos"]]?.valor) sinDni.push(n);
    continue;
  }
  const valores = aFilaPersonal(fila);
  const dni = valores[INDICE["DNI"]];
  if (dnisVistos.has(dni)) duplicados.push({ dni, filas: [dnisVistos.get(dni), n] });
  else dnisVistos.set(dni, n);

  registros.push({ excel: n, dni, valores, rutaFoto: fotos.porFila(n) });
}

console.log(`\npersonas leidas: ${registros.length}`);
console.log(`  con foto:     ${registros.filter((r) => r.rutaFoto).length}`);
console.log(`  sin foto:     ${registros.filter((r) => !r.rutaFoto).length}`);
if (sinDni.length) console.log(`  filas con nombre pero sin DNI: ${sinDni.length} (${sinDni.slice(0, 8).join(", ")}...)`);
if (duplicados.length) {
  console.log(`  DNI repetidos: ${duplicados.length}`);
  for (const d of duplicados.slice(0, 10)) console.log(`    ${d.dni} en filas ${d.filas.join(" y ")}`);
}

if (DRY) {
  const ejemplo = registros[0];
  console.log(`\n--dry-run: no se toca nada. Ejemplo (fila ${ejemplo.excel}):`);
  for (const col of ["Codigo", "Apellidos", "Nombres", "DNI", "EMPRESA", "Cargo Planilla", "F. Ex. Medico", "ESTADO_FINAL"]) {
    console.log(`  ${col.padEnd(16)} ${ejemplo.valores[INDICE[col]]}`);
  }
  console.log(`  AE  cap=${ejemplo.valores[colCap("AE")]} venc=${ejemplo.valores[colVenc("AE")]} tipo=${ejemplo.valores[colTipo("AE")]} estado=${ejemplo.valores[colEstado("AE")]}`);
  console.log(`  foto -> ${ejemplo.rutaFoto || "(sin foto)"}`);
  zip.cerrar();
  process.exit(0);
}

/* ------------------------------------------------------------------ */
/* Subida de fotos a Drive                                             */
/* ------------------------------------------------------------------ */

const { subirArchivo, listarCarpeta, carpetaFotos } = await import("../api/_lib/drive-escritura.js");
const { hayCuentaDeServicio } = await import("../api/_lib/google.js");

if (!hayCuentaDeServicio()) {
  console.error("\nfaltan GOOGLE_SA_EMAIL y GOOGLE_SA_PRIVATE_KEY en .env (ver README)");
  process.exit(1);
}

if (!SIN_FOTOS) {
  const carpeta = carpetaFotos();
  if (!carpeta) {
    console.error("\nfalta DRIVE_FOTOS_FOLDER_ID en .env");
    process.exit(1);
  }

  console.log(`\nsubiendo fotos a Drive...`);
  // Las fotos que ya estan se indexan por DOCUMENTO normalizado, no por
  // nombre: en la carpeta conviven "4075286.png" y "04065624.png" porque
  // quien las exporto perdio el cero inicial en unas si y en otras no.
  const existentes = new Map();
  for (const f of await listarCarpeta(carpeta)) {
    existentes.set(normalizarDocumento(f.name.replace(/\.[^.]+$/, "")), f.name);
  }
  console.log(`  ya habia ${existentes.size} foto(s) en la carpeta`);

  let subidas = 0;
  let reutilizadas = 0;
  let fallos = 0;

  for (const [i, r] of registros.entries()) {
    if (!r.rutaFoto) continue;
    const extension = r.rutaFoto.split(".").pop().toLowerCase();
    const nombre = `${r.dni}.${extension}`;

    if (!REHACER && existentes.has(r.dni)) {
      reutilizadas++;
      continue;
    }

    try {
      await subirArchivo({
        nombre,
        mime: extension === "png" ? "image/png" : "image/jpeg",
        datos: zip.leer(r.rutaFoto),
        carpetaId: carpeta,
      });
      subidas++;
    } catch (e) {
      fallos++;
      console.log(`  ! ${r.dni}: ${e.message}`);
    }

    if ((i + 1) % 25 === 0) {
      process.stdout.write(`\r  ${i + 1}/${registros.length} · ${subidas} subida(s), ${reutilizadas} reutilizada(s)   `);
    }
  }
  console.log(`\n  fotos: ${subidas} subida(s), ${reutilizadas} reutilizada(s), ${fallos} fallo(s)`);
}

zip.cerrar();

/* ------------------------------------------------------------------ */
/* Cotejo contra la hoja                                               */
/* ------------------------------------------------------------------ */

const { HOJAS, indicePorDni, hayHoja, filaDatos } = await import("../api/_lib/sheets.js");

if (!hayHoja()) {
  console.error("\nfalta SHEET_ID en .env: no se puede cotejar contra la hoja");
  process.exit(1);
}

console.log(`\ncotejando con "${HOJAS.personal}" (datos desde la fila ${filaDatos()})...`);
const enLaHoja = await indicePorDni();
const faltan = registros.filter((r) => !enLaHoja.has(r.dni));
const sobran = [...enLaHoja.keys()].filter((dni) => !registros.some((r) => r.dni === dni));

console.log(`  en el Excel: ${registros.length}`);
console.log(`  en la hoja:  ${enLaHoja.size}`);
console.log(`  en el Excel pero NO en la hoja: ${faltan.length}`);
for (const r of faltan.slice(0, 20)) {
  console.log(`    ${r.dni}  ${r.valores[INDICE["Apellidos"]]} ${r.valores[INDICE["Nombres"]]} (fila ${r.excel})`);
}
if (faltan.length > 20) console.log(`    ... y ${faltan.length - 20} mas`);
console.log(`  en la hoja pero NO en el Excel: ${sobran.length}`);
if (sobran.length) console.log(`    ${sobran.slice(0, 20).join(", ")}${sobran.length > 20 ? " ..." : ""}`);

console.log(`
listo. Este script no escribe en la hoja: la base ya esta migrada.`);
console.log(`Para reparar diferencias, usa la app (RENOVACION para las que existen,`);
console.log(`NUEVO PERSONAL para las que falten).`);

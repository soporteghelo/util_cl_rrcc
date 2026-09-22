/**
 * Catalogo de Riesgos Criticos y layout de la hoja de personal.
 *
 * Modulo PURO (sin Node ni DOM): lo importan tanto las funciones de `api/`
 * como el navegador, para que las reglas vivan en un solo sitio.
 *
 * El orden de RRCC y de columnas es EL MISMO que el de la hoja `BD AESA` del
 * Excel original. No es capricho: la hoja FOTOCHEK resuelve todo con
 * VLOOKUP por posicion sobre el rango C:CO, asi que mover una columna
 * rompe el fotocheck. La unica diferencia es la columna D, que en el Excel
 * lleva la foto incrustada y aca lleva su ID de Drive.
 */

/**
 * Los 18 riesgos criticos, en el orden del Excel.
 *
 * - `nombre`  = rotulo de la fila 2 de BD AESA (encabezado del grupo).
 * - `rotulo`  = etiqueta corta impresa en el fotocheck.
 * - `vigencia`= de donde sale la fecha de vencimiento:
 *      "CAP365" -> capacitacion + 365 dias (regla general)
 *      "CERT"   -> la fecha que traiga el certificado (ES y HM, emisor EIN)
 */
export const RRCC = [
  { codigo: "AE",  nombre: "BLOQUEO Y AISLAMIENTO DE ENERGIAS", rotulo: "Bloq. Energias",        vigencia: "CAP365" },
  { codigo: "IE",  nombre: "INSTALACIONES ELECTRICAS",          rotulo: "Instalaciones Electricas", vigencia: "CAP365" },
  { codigo: "SQ",  nombre: "SUSTANCIAS QUIMICAS PELIGROSAS",    rotulo: "Sust. Quim. Pelig.",     vigencia: "CAP365" },
  { codigo: "PM",  nombre: "PROTECCION DE MAQUINAS",            rotulo: "Protec. De Maq.",        vigencia: "CAP365" },
  { codigo: "TA",  nombre: "TRABAJO EN ALTURA",                 rotulo: "Trabajo en Altura",      vigencia: "CAP365" },
  { codigo: "CS",  nombre: "CARGAS SUSPENDIDAS",                rotulo: "Cargas Suspendidas",     vigencia: "CAP365" },
  { codigo: "SP",  nombre: "SISTEMAS PRESURIZADOS",             rotulo: "Sistemas presurizados",  vigencia: "CAP365" },
  { codigo: "ES",  nombre: "EXCAVACIONES SUBTERRANEAS",         rotulo: "Excavación Subterránea", vigencia: "CERT" },
  { codigo: "HM",  nombre: "HERRAMIENTAS MANUALES",             rotulo: "Herramientas Manuales",  vigencia: "CERT" },
  { codigo: "OC",  nombre: "EXCAVACION EN OBRAS CIVILES",       rotulo: "Exc. Obras Civiles",     vigencia: "CAP365" },
  { codigo: "EC",  nombre: "ESPACIOS CONFINADOS",               rotulo: "Espacio Confinado",      vigencia: "CAP365" },
  { codigo: "VEM", nombre: "VEHICULOS Y EQUIPOS MOVILES",       rotulo: "Veh. y Equi. Móviles",   vigencia: "CAP365" },
  { codigo: "AP",  nombre: "ANIMALES PONZONOSOS",               rotulo: "Animales Ponzoñosos",    vigencia: "CAP365" },
  { codigo: "HP",  nombre: "HERRAMIENTAS DE PODER",             rotulo: "Herramientas de Poder",  vigencia: "CAP365" },
  { codigo: "TC",  nombre: "TRABAJOS EN CALIENTE",              rotulo: "Trabajo en Caliente",    vigencia: "CAP365" },
  { codigo: "OB",  nombre: "OFICIAL DE BLOQUEO",                rotulo: "Oficial de Bloqueo",     vigencia: "CAP365" },
  { codigo: "MD",  nombre: "MONTAJE Y DESMONTAJE",              rotulo: "Montaje y Desmontaje",   vigencia: "CAP365" },
  { codigo: "RIG", nombre: "RIGGER",                            rotulo: "Rigger",                 vigencia: "CAP365" },
];

export const CODIGOS_RRCC = RRCC.map((r) => r.codigo);

export const porCodigo = (codigo) => RRCC.find((r) => r.codigo === codigo) || null;

/* ------------------------------------------------------------------ */
/* Layout de la hoja de personal (`BD AESA`)                           */
/* ------------------------------------------------------------------ */

/** Columnas de datos, antes del bloque de riesgos (A..O del Excel). */
export const COLUMNAS_DATOS = [
  "Columna1",        // A  espejo del DNI (el Excel lo usa para sus BUSCARV)
  "Item",            // B
  "Codigo",          // C  AE001, AE002...  <- clave del fotocheck
  "FOTO",            // D  ruta "FOTOS/<DNI>.png" dentro de la carpeta RRCC
  "Apellidos",       // E
  "Nombres",         // F
  "DNI",             // G
  "EMPRESA",         // H
  "Guardia",         // I
  "Cargo Planilla",  // J
  "COMENTARIO",      // K
  "Area Planilla",   // L
  "F. Ex. Medico",   // M
  "F. Vencimiento",  // N
  "USO DE LENTES",   // O
];

/** Columnas de cierre del Excel, despues del bloque de riesgos (CJ..CP). */
export const COLUMNAS_CIERRE = [
  "ANEXO 04",
  "ANEXO 05",
  "FECHA MINIMA",
  "DIAS",
  "ESTADO_FINAL",
  "FullName",
  "_EstaTE",
];

/**
 * Columnas nuevas, siempre AL FINAL: agregarlas en medio correria el bloque
 * de riesgos y rompería los VLOOKUP posicionales del fotocheck.
 */
export const COLUMNAS_EXTRA = [
  "FOTOCHECK_ANTIGUO_DRIVE_ID",
  "CARPETA_DRIVE_ID",
  "RESTRICCIONES_EMO",
  "ACTUALIZADO",
];

/** Las 4 columnas que ocupa cada riesgo critico. */
export const CAMPOS_RRCC = ["Fecha de capacitacion", "Fecha de vencimiento", "TIPO", "ESTADO"];

/** Cabecera completa de la hoja de personal, en orden. */
export const CABECERA = [
  ...COLUMNAS_DATOS,
  ...RRCC.flatMap((r) => CAMPOS_RRCC.map((c) => `${c}_${r.codigo}`)),
  ...COLUMNAS_CIERRE,
  ...COLUMNAS_EXTRA,
];

/** Indice (0-based) de cada nombre de columna. */
export const INDICE = Object.fromEntries(CABECERA.map((n, i) => [n, i]));

/** Primera columna del bloque de un riesgo critico. */
export function baseDe(codigo) {
  const i = CODIGOS_RRCC.indexOf(codigo);
  if (i < 0) return -1;
  return COLUMNAS_DATOS.length + i * 4;
}

export const colCap = (codigo) => baseDe(codigo);
export const colVenc = (codigo) => baseDe(codigo) + 1;
export const colTipo = (codigo) => baseDe(codigo) + 2;
export const colEstado = (codigo) => baseDe(codigo) + 3;

/** "A" -> 0, "AA" -> 26. Para armar rangos A1 de la API de Sheets. */
export function letraColumna(indice) {
  let n = indice + 1;
  let s = "";
  while (n > 0) {
    const r = (n - 1) % 26;
    s = String.fromCharCode(65 + r) + s;
    n = Math.floor((n - 1) / 26);
  }
  return s;
}

/** Ultima columna del layout, en notacion A1. */
export const ULTIMA_COLUMNA = letraColumna(CABECERA.length - 1);

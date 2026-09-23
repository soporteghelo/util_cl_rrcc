/**
 * Lectura y escritura de .xlsx / .csv / .txt en el navegador (sin backend).
 *
 * Un .xlsx es un ZIP con XML dentro, asi que se abre con JSZip y se parsea con
 * DOMParser (y se escribe igual, ver `armarXlsx`). No hace falta ninguna
 * libreria de Excel.
 *
 * Lo importante es distinguir si la celda venia como TEXTO o como NUMERO:
 * si venia como numero, Excel ya se comio los ceros de la izquierda y hay que
 * rellenar. Se informa al usuario de cada relleno.
 */

import JSZip from "jszip";
import { aIso, isoASerial } from "../../shared/estados.js";

const CABECERA_DNI = /\b(dni|documento|nro?\.?\s*doc|n[uú]m\.?\s*doc|doc\.?\s*ident|c[eé]dula|identidad|ndocumento)\b/i;

/** Una celda puede tener 6-12 digitos para considerarse documento. */
const pareceDocumento = (t) => /^\d{6,12}$/.test(String(t).replace(/\D/g, "")) && String(t).replace(/\D/g, "").length >= 6;

/* ------------------------------------------------------------------ */
/* XLSX                                                                */
/* ------------------------------------------------------------------ */

function columnaDeRef(ref) {
  const m = /^([A-Z]+)/.exec(ref || "");
  if (!m) return 0;
  let n = 0;
  for (const ch of m[1]) n = n * 26 + (ch.charCodeAt(0) - 64);
  return n - 1;
}

async function leerXlsx(archivo) {
  const zip = await JSZip.loadAsync(archivo);
  const parser = new DOMParser();

  // cadenas compartidas: aqui viven los valores de texto (con sus ceros)
  const compartidas = [];
  const ssFile = zip.file("xl/sharedStrings.xml");
  if (ssFile) {
    const doc = parser.parseFromString(await ssFile.async("string"), "application/xml");
    for (const si of doc.getElementsByTagName("si")) {
      // un <si> puede tener varios <t> (texto con formato mixto)
      const ts = si.getElementsByTagName("t");
      let s = "";
      for (const t of ts) s += t.textContent;
      compartidas.push(s);
    }
  }

  const hojas = Object.keys(zip.files)
    .filter((n) => /^xl\/worksheets\/sheet\d+\.xml$/.test(n))
    .sort();

  const filas = [];
  for (const nombre of hojas) {
    const doc = parser.parseFromString(await zip.file(nombre).async("string"), "application/xml");
    for (const fila of doc.getElementsByTagName("row")) {
      const celdas = [];
      let secuencial = 0;
      for (const c of fila.getElementsByTagName("c")) {
        const tipo = c.getAttribute("t"); // s | str | inlineStr | b | e | (numero)
        // Excel siempre escribe r="B2"; otros generadores lo omiten y ahi hay
        // que contar por posicion o todas las celdas caerian en la columna 0.
        const ref = c.getAttribute("r");
        const col = ref ? columnaDeRef(ref) : secuencial;
        secuencial = col + 1;
        let valor = "";
        let esTexto = false;

        if (tipo === "inlineStr") {
          const is = c.getElementsByTagName("t");
          for (const t of is) valor += t.textContent;
          esTexto = true;
        } else {
          const v = c.getElementsByTagName("v")[0];
          valor = v ? v.textContent : "";
          if (tipo === "s") {
            valor = compartidas[Number(valor)] ?? "";
            esTexto = true;
          } else if (tipo === "str") {
            esTexto = true;
          }
        }
        if (valor !== "") celdas[col] = { valor: String(valor).trim(), esTexto };
      }
      if (celdas.length) filas.push(celdas);
    }
  }
  return filas;
}

/* ------------------------------------------------------------------ */
/* CSV / TXT                                                           */
/* ------------------------------------------------------------------ */

async function leerTexto(archivo) {
  const texto = await archivo.text();
  const lineas = texto.split(/\r?\n/).filter((l) => l.trim());
  if (!lineas.length) return [];

  // delimitador mas frecuente en la primera linea
  const cabecera = lineas[0];
  const candidatos = [";", ",", "\t", "|"];
  let delim = candidatos.reduce(
    (mejor, d) => (cabecera.split(d).length > cabecera.split(mejor).length ? d : mejor),
    ";"
  );
  if (cabecera.split(delim).length < 2) delim = null;

  return lineas.map((linea) => {
    const partes = delim ? linea.split(delim) : [linea];
    // en texto plano los ceros SI se conservan: todo se trata como texto
    return partes.map((p) => ({ valor: p.trim().replace(/^"|"$/g, ""), esTexto: true }));
  });
}

/* ------------------------------------------------------------------ */
/* Seleccion de la columna de documentos                               */
/* ------------------------------------------------------------------ */

function elegirColumna(filas) {
  // 1) cabecera explicita en las primeras filas
  for (let f = 0; f < Math.min(filas.length, 12); f++) {
    const fila = filas[f] || [];
    for (let c = 0; c < fila.length; c++) {
      const celda = fila[c];
      if (celda && CABECERA_DNI.test(celda.valor)) {
        return { columna: c, desdeFila: f + 1, motivo: `columna con cabecera "${celda.valor}"` };
      }
    }
  }

  // 2) la columna con mas valores que parezcan documento
  const puntajes = new Map();
  for (const fila of filas) {
    for (let c = 0; c < (fila?.length || 0); c++) {
      if (fila[c] && pareceDocumento(fila[c].valor)) {
        puntajes.set(c, (puntajes.get(c) || 0) + 1);
      }
    }
  }
  if (puntajes.size) {
    const [columna, n] = [...puntajes].sort((a, b) => b[1] - a[1])[0];
    return { columna, desdeFila: 0, motivo: `columna ${columna + 1} (${n} valores con forma de documento)` };
  }

  return null;
}

/* ------------------------------------------------------------------ */
/* API publica                                                         */
/* ------------------------------------------------------------------ */

/**
 * Devuelve { valores: string[], detalle: string, numericas: number }
 * `numericas` = cuantas celdas venian como numero (donde Excel pudo comerse
 * los ceros). El llamador lo usa para avisar al usuario.
 */
export async function extraerDocumentos(archivo) {
  const nombre = archivo.name.toLowerCase();

  if (nombre.endsWith(".xls")) {
    throw new Error(
      "El formato .xls (Excel 97-2003) no se puede leer aqui. Abrelo en Excel y usa Archivo > Guardar como > .xlsx o .csv"
    );
  }

  let filas;
  if (nombre.endsWith(".xlsx") || nombre.endsWith(".xlsm")) {
    filas = await leerXlsx(archivo);
  } else {
    filas = await leerTexto(archivo);
  }

  if (!filas.length) throw new Error("El archivo esta vacio o no se pudo leer");

  const eleccion = elegirColumna(filas);
  const valores = [];
  let numericas = 0;

  if (eleccion) {
    for (let f = eleccion.desdeFila; f < filas.length; f++) {
      const celda = (filas[f] || [])[eleccion.columna];
      if (!celda || !celda.valor) continue;
      if (!/\d/.test(celda.valor)) continue; // salta subtitulos o texto suelto
      valores.push(celda.valor);
      if (!celda.esTexto) numericas++;
    }
  } else {
    // sin columna clara: se recogen todas las celdas con forma de documento
    for (const fila of filas) {
      for (const celda of fila || []) {
        if (celda && pareceDocumento(celda.valor)) {
          valores.push(celda.valor);
          if (!celda.esTexto) numericas++;
        }
      }
    }
  }

  return {
    valores,
    numericas,
    detalle: eleccion ? eleccion.motivo : "todas las celdas con forma de documento",
  };
}

/* ------------------------------------------------------------------ */
/* Escritura de XLSX                                                   */
/* ------------------------------------------------------------------ */

/**
 * Un .xlsx tambien se escribe a mano con JSZip, igual que el .docx de
 * `docx.js`: son cuatro XML dentro de un ZIP, y evita sumar una libreria de
 * varios MB solo para volcar una tabla.
 *
 * Los valores van como `inlineStr` (el texto vive en la propia celda) en vez
 * de la tabla de cadenas compartidas: ocupa algo mas, pero ahorra la mitad
 * del formato y mantiene los DNI como TEXTO, que es lo unico innegociable
 * aca (como numero, Excel se come el cero de la izquierda y "07481337"
 * vuelve convertido en 7481337).
 */

export const MIME_XLSX = "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet";

const NS_HOJA = "http://schemas.openxmlformats.org/spreadsheetml/2006/main";
const NS_REL = "http://schemas.openxmlformats.org/officeDocument/2006/relationships";

/** Estilos declarados en `estilos()`, por posicion dentro de <cellXfs>. */
const ESTILO = { NORMAL: 0, CABECERA: 1, FECHA: 2 };

function xml(valor) {
  return String(valor === null || valor === undefined ? "" : valor)
    .replace(/[\u0000-\u0008\u000B\u000C\u000E-\u001F]/g, "") // XML 1.0 no admite caracteres de control
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}

/** 0 -> "A", 25 -> "Z", 26 -> "AA" (la vuelta de `columnaDeRef`). */
function refDeColumna(n) {
  let s = "";
  for (let i = n + 1; i > 0; i = Math.floor((i - 1) / 26)) {
    s = String.fromCharCode(65 + ((i - 1) % 26)) + s;
  }
  return s;
}

/**
 * Una celda. `tipo`:
 *  - "fecha"  -> serial de Excel con formato dd/mm/yyyy, para poder ordenar
 *                y filtrar por fecha (si no se entiende, cae a texto)
 *  - "numero" -> numero de verdad
 *  - resto    -> texto, que es lo que necesitan el DNI y los codigos
 */
function celda(ref, valor, tipo) {
  if (valor === null || valor === undefined || valor === "") return "";

  if (tipo === "fecha") {
    const serial = isoASerial(aIso(valor));
    if (serial !== "") return `<c r="${ref}" s="${ESTILO.FECHA}"><v>${serial}</v></c>`;
  } else if (tipo === "numero" && Number.isFinite(Number(valor))) {
    return `<c r="${ref}"><v>${Number(valor)}</v></c>`;
  }

  return `<c r="${ref}" t="inlineStr"><is><t xml:space="preserve">${xml(valor)}</t></is></c>`;
}

function hojaXml(hoja) {
  const columnas = hoja.columnas || [];
  const filas = hoja.filas || [];
  const ultima = refDeColumna(Math.max(columnas.length - 1, 0));
  const alto = filas.length + 1;

  const anchos = columnas
    .map((c, i) => `<col min="${i + 1}" max="${i + 1}" width="${Number(c.ancho) || 14}" customWidth="1"/>`)
    .join("");

  const cabecera =
    `<row r="1">` +
    columnas
      .map(
        (c, i) =>
          `<c r="${refDeColumna(i)}1" t="inlineStr" s="${ESTILO.CABECERA}"><is><t>${xml(c.titulo)}</t></is></c>`
      )
      .join("") +
    `</row>`;

  const cuerpo = filas
    .map((fila, f) => {
      const r = f + 2;
      const celdas = columnas.map((c, i) => celda(refDeColumna(i) + r, (fila || [])[i], c.tipo)).join("");
      return `<row r="${r}">${celdas}</row>`;
    })
    .join("");

  // El orden de los elementos NO es libre: el esquema pide
  // dimension -> sheetViews -> sheetFormatPr -> cols -> sheetData -> autoFilter,
  // y Excel rechaza el libro entero ("contenido ilegible") si se altera.
  return (
    '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>' +
    `<worksheet xmlns="${NS_HOJA}">` +
    `<dimension ref="A1:${ultima}${alto}"/>` +
    '<sheetViews><sheetView workbookViewId="0">' +
    // la cabecera se queda fija al bajar por la lista
    '<pane ySplit="1" topLeftCell="A2" activePane="bottomLeft" state="frozen"/>' +
    '<selection pane="bottomLeft" activeCell="A2" sqref="A2"/>' +
    "</sheetView></sheetViews>" +
    '<sheetFormatPr defaultRowHeight="15"/>' +
    (anchos ? `<cols>${anchos}</cols>` : "") +
    `<sheetData>${cabecera}${cuerpo}</sheetData>` +
    `<autoFilter ref="A1:${ultima}${alto}"/>` +
    "</worksheet>"
  );
}

function estilos() {
  return (
    '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>' +
    `<styleSheet xmlns="${NS_HOJA}">` +
    '<numFmts count="1"><numFmt numFmtId="164" formatCode="dd/mm/yyyy"/></numFmts>' +
    '<fonts count="2">' +
    '<font><sz val="11"/><name val="Calibri"/></font>' +
    '<font><b/><sz val="11"/><name val="Calibri"/></font>' +
    "</fonts>" +
    // Excel da por hechos estos dos rellenos: sin ellos no abre el libro
    '<fills count="2"><fill><patternFill patternType="none"/></fill><fill><patternFill patternType="gray125"/></fill></fills>' +
    '<borders count="1"><border><left/><right/><top/><bottom/><diagonal/></border></borders>' +
    '<cellStyleXfs count="1"><xf numFmtId="0" fontId="0" fillId="0" borderId="0"/></cellStyleXfs>' +
    '<cellXfs count="3">' +
    '<xf numFmtId="0" fontId="0" fillId="0" borderId="0" xfId="0"/>' +
    '<xf numFmtId="0" fontId="1" fillId="0" borderId="0" xfId="0" applyFont="1"/>' +
    '<xf numFmtId="164" fontId="0" fillId="0" borderId="0" xfId="0" applyNumberFormat="1"/>' +
    "</cellXfs>" +
    '<cellStyles count="1"><cellStyle name="Normal" xfId="0" builtinId="0"/></cellStyles>' +
    "</styleSheet>"
  );
}

/** Excel no admite \ / ? * [ ] : en el nombre de una hoja, ni mas de 31 caracteres. */
function nombreDeHoja(nombre, usados) {
  const base = String(nombre || "Hoja").replace(/[\\/?*[\]:]/g, " ").trim().slice(0, 31) || "Hoja";
  let final = base;
  for (let n = 2; usados.has(final.toUpperCase()); n++) {
    const sufijo = ` (${n})`;
    final = base.slice(0, 31 - sufijo.length) + sufijo;
  }
  usados.add(final.toUpperCase());
  return final;
}

/**
 * Arma un .xlsx y lo devuelve como Blob (o como pida `tipo`, ver JSZip).
 *
 * `hojas` = [{ nombre, columnas: [{ titulo, ancho, tipo }], filas: [[...]] }],
 * y cada fila es un array con un valor por columna, en ese mismo orden.
 */
export async function armarXlsx(hojas, tipo = "blob") {
  const lista = (hojas || []).filter(Boolean);
  if (!lista.length) throw new Error("el Excel necesita al menos una hoja");

  const usados = new Set();
  const nombres = lista.map((h) => nombreDeHoja(h.nombre, usados));

  const zip = new JSZip();

  zip.file(
    "[Content_Types].xml",
    '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>' +
      '<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types">' +
      '<Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/>' +
      '<Default Extension="xml" ContentType="application/xml"/>' +
      `<Override PartName="/xl/workbook.xml" ContentType="${MIME_XLSX}.main+xml"/>` +
      lista
        .map(
          (_, i) =>
            `<Override PartName="/xl/worksheets/sheet${i + 1}.xml" ` +
            'ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.worksheet+xml"/>'
        )
        .join("") +
      '<Override PartName="/xl/styles.xml" ' +
      'ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.styles+xml"/>' +
      "</Types>"
  );

  zip.file(
    "_rels/.rels",
    '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>' +
      '<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">' +
      `<Relationship Id="rId1" Type="${NS_REL}/officeDocument" Target="xl/workbook.xml"/>` +
      "</Relationships>"
  );

  zip.file(
    "xl/workbook.xml",
    '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>' +
      `<workbook xmlns="${NS_HOJA}" xmlns:r="${NS_REL}"><sheets>` +
      nombres.map((n, i) => `<sheet name="${xml(n)}" sheetId="${i + 1}" r:id="rId${i + 1}"/>`).join("") +
      "</sheets></workbook>"
  );

  zip.file(
    "xl/_rels/workbook.xml.rels",
    '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>' +
      '<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">' +
      nombres
        .map(
          (_, i) =>
            `<Relationship Id="rId${i + 1}" Type="${NS_REL}/worksheet" Target="worksheets/sheet${i + 1}.xml"/>`
        )
        .join("") +
      `<Relationship Id="rId${lista.length + 1}" Type="${NS_REL}/styles" Target="styles.xml"/>` +
      "</Relationships>"
  );

  zip.file("xl/styles.xml", estilos());
  lista.forEach((hoja, i) => zip.file(`xl/worksheets/sheet${i + 1}.xml`, hojaXml(hoja)));

  return zip.generateAsync({ type: tipo, mimeType: MIME_XLSX, compression: "DEFLATE" });
}

/**
 * Lectura de .xlsx / .csv / .txt en el navegador (sin backend).
 *
 * Un .xlsx es un ZIP con XML dentro, asi que se abre con JSZip y se parsea con
 * DOMParser. No hace falta ninguna libreria de Excel.
 *
 * Lo importante es distinguir si la celda venia como TEXTO o como NUMERO:
 * si venia como numero, Excel ya se comio los ceros de la izquierda y hay que
 * rellenar. Se informa al usuario de cada relleno.
 */

import JSZip from "jszip";

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

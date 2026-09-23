/**
 * Generador de PDF para informes de texto (una hoja A4 por pagina, cabecera
 * repetida y numeracion).
 *
 * Se escribe a mano, igual que el .docx de `docx.js` y el .xlsx de
 * `excel.js`: un PDF es una lista de objetos numerados mas una tabla de
 * posiciones al final, y aqui solo hace falta texto, lineas y recuadros. Una
 * libreria tipo jsPDF pesa varios cientos de KB y no aporta nada mas para
 * este informe.
 *
 * Se usa Helvetica (una de las 14 fuentes que TODO lector de PDF trae) con
 * codificacion WinAnsi, que cubre el castellano entero: acentos, Ñ y ¿ ¡.
 * Al no incrustar fuente, el archivo pesa unos pocos KB.
 *
 * El contenido va SIN comprimir a proposito: son informes cortos y asi el
 * archivo se puede abrir con un editor de texto para comprobar que dice lo
 * que tiene que decir.
 */

/** A4 vertical, en puntos (1 pt = 1/72"). */
const PAGINA = { ancho: 595.28, alto: 841.89 };
const MARGEN = { izq: 40, der: 40, arriba: 44, abajo: 44 };
const ANCHO_UTIL = PAGINA.ancho - MARGEN.izq - MARGEN.der;

/** Alto de cada tipo de parte, para saber cuando se acaba la hoja. */
const ALTO = { titulo: 16, cabecera: 25, nota: 12, grupo: 15, item: 13, regla: 10 };

/** Paleta del informe. Los colores van en 0..1, como los quiere el PDF. */
export const COLOR = {
  tinta: [0.09, 0.09, 0.11],
  gris: [0.42, 0.42, 0.45],
  rojo: [0.66, 0.09, 0.16], // vencido / autorizaciones
  ambar: [0.58, 0.38, 0.02], // capacitaciones
  banda: [0.925, 0.925, 0.935], // fondo de la cabecera de cada persona
  cebra: [0.973, 0.973, 0.978], // fondo alterno de las filas
  linea: [0.78, 0.78, 0.8],
};

/**
 * Anchos de Helvetica (milesimas de em), para alinear a la derecha y recortar
 * lo que no entra. Los digitos miden 556 tanto en la normal como en la
 * negrita, que es lo que mas importa aqui (DNI y fechas quedan cuadrados).
 */
const ANCHO = {
  " ": 278, "!": 278, '"': 355, "#": 556, $: 556, "%": 889, "&": 667, "'": 191,
  "(": 333, ")": 333, "*": 389, "+": 584, ",": 278, "-": 333, ".": 278, "/": 278,
  ":": 278, ";": 278, "<": 584, "=": 584, ">": 584, "?": 556, "@": 1015,
  A: 667, B: 667, C: 722, D: 722, E: 667, F: 611, G: 778, H: 722, I: 278, J: 500,
  K: 667, L: 556, M: 833, N: 722, O: 778, P: 667, Q: 778, R: 722, S: 667, T: 611,
  U: 722, V: 667, W: 944, X: 667, Y: 667, Z: 611,
  "[": 278, "\\": 278, "]": 278, "^": 469, _: 556, "`": 333,
  a: 556, b: 556, c: 500, d: 556, e: 556, f: 278, g: 556, h: 556, i: 222, j: 222,
  k: 500, l: 222, m: 833, n: 556, o: 556, p: 556, q: 556, r: 333, s: 500, t: 278,
  u: 556, v: 500, w: 722, x: 500, y: 500, z: 500,
  "{": 334, "|": 260, "}": 334, "~": 584,
};

function anchoDeCaracter(ch) {
  const w = ANCHO[ch];
  if (w !== undefined) return w;
  const c = ch.charCodeAt(0);
  if (c >= 0x30 && c <= 0x39) return 556; // digitos
  if (c === 0xb7) return 333; // ·
  if (c >= 0xc0 && c <= 0xde) return 700; // mayusculas acentuadas (A-grave .. THORN)
  return 556;
}

/** Ancho de un texto en puntos. La negrita de Helvetica es ~6% mas ancha. */
export function anchoTexto(texto, tam, negrita) {
  let m = 0;
  for (const ch of String(texto || "")) m += anchoDeCaracter(ch);
  return (m / 1000) * tam * (negrita ? 1.06 : 1);
}

/** Recorta con puntos suspensivos lo que no entre en `ancho`. */
export function recortar(texto, tam, ancho, negrita) {
  const t = String(texto || "");
  if (anchoTexto(t, tam, negrita) <= ancho) return t;
  let corte = t;
  while (corte.length > 1 && anchoTexto(corte + "…", tam, negrita) > ancho) {
    corte = corte.slice(0, -1);
  }
  return corte + "…";
}

/**
 * Texto -> bytes WinAnsi (cp1252) ya escapados para un literal `(...)`.
 *
 * Latin-1 y WinAnsi coinciden salvo en 0x80-0x9F, donde WinAnsi mete las
 * comillas tipograficas, la raya y los puntos suspensivos: son justo los
 * caracteres que se cuelan al copiar textos de Word, asi que se traducen en
 * vez de perderse. Lo que no existe en la tabla pasa a "?" antes que romper
 * el archivo.
 */
const ESPECIALES = {
  "€": 0x80, "‚": 0x82, "ƒ": 0x83, "„": 0x84, "…": 0x85,
  "†": 0x86, "‡": 0x87, "ˆ": 0x88, "‰": 0x89, "Š": 0x8a,
  "‹": 0x8b, "Œ": 0x8c, "Ž": 0x8e, "‘": 0x91, "’": 0x92,
  "“": 0x93, "”": 0x94, "•": 0x95, "–": 0x96, "—": 0x97,
  "˜": 0x98, "™": 0x99, "š": 0x9a, "›": 0x9b, "œ": 0x9c,
  "ž": 0x9e, "Ÿ": 0x9f,
};

function literal(texto) {
  let s = "";
  for (const ch of String(texto || "")) {
    const c = ESPECIALES[ch] ?? ch.charCodeAt(0);
    if (c > 255) {
      s += "?";
      continue;
    }
    const b = String.fromCharCode(c);
    s += b === "(" || b === ")" || b === "\\" ? "\\" + b : b;
  }
  return `(${s})`;
}

/* ------------------------------------------------------------------ */
/* Dibujo                                                              */
/* ------------------------------------------------------------------ */

const FUENTE = { normal: "/F1", negrita: "/F2" };

/** Un color puede venir como [r,g,b] o como un gris suelto. */
function tinta(color) {
  const c = Array.isArray(color) ? color : [color ?? 0, color ?? 0, color ?? 0];
  return c.map((v) => Number(v).toFixed(3)).join(" ");
}

function opTexto(texto, x, y, tam, { negrita, color } = {}) {
  return (
    `${tinta(color ?? COLOR.tinta)} rg BT ${negrita ? FUENTE.negrita : FUENTE.normal} ${tam} Tf ` +
    `1 0 0 1 ${x.toFixed(2)} ${y.toFixed(2)} Tm ${literal(texto)} Tj ET`
  );
}

const opLinea = (x1, y1, x2, y2, color = COLOR.linea, grosor = 0.6) =>
  `${tinta(color)} RG ${grosor} w ${x1.toFixed(2)} ${y1.toFixed(2)} m ${x2.toFixed(2)} ${y2.toFixed(2)} l S`;

const opRecuadro = (x, y, ancho, alto, color = COLOR.banda) =>
  `${tinta(color)} rg ${x.toFixed(2)} ${y.toFixed(2)} ${ancho.toFixed(2)} ${alto.toFixed(2)} re f`;

/* ------------------------------------------------------------------ */
/* API publica                                                         */
/* ------------------------------------------------------------------ */

/**
 * Arma el PDF y lo devuelve como Blob.
 *
 * - `titulo` / `subtitulo`: cabecera, se repite en todas las hojas.
 * - `bloques`: lista de bloques; cada bloque es una lista de partes y se
 *   intenta NO partirlo entre dos hojas (una persona con sus vencimientos
 *   debajo). Si un bloque no cabe ni en una hoja entera, fluye y se parte.
 *
 * Partes admitidas:
 *   { tipo: "titulo",   texto }
 *   { tipo: "cabecera", texto, derecha, indice, color }  nombre sobre banda
 *   { tipo: "nota",     texto }                          renglon gris pequeño
 *   { tipo: "grupo",    texto, color }                   subtitulo de grupo
 *   { tipo: "item",     cols: [{ texto, x, ancho, negrita, color }], fondo }
 *   { tipo: "regla" }
 *   { tipo: "espacio",  alto }
 */
export async function armarPdf({ titulo = "", subtitulo = "", bloques = [] } = {}) {
  const paginas = [];
  let ops = null;
  let y = 0;

  function nuevaPagina() {
    ops = [];
    paginas.push(ops);
    y = PAGINA.alto - MARGEN.arriba;
    if (titulo) {
      ops.push(opTexto(recortar(titulo, 15, ANCHO_UTIL, true), MARGEN.izq, y - 12, 15, { negrita: true }));
      y -= 17;
    }
    if (subtitulo) {
      ops.push(opTexto(recortar(subtitulo, 8.5, ANCHO_UTIL), MARGEN.izq, y - 8, 8.5, { color: COLOR.gris }));
      y -= 12;
    }
    // regla gruesa en rojo: el informe va de vencimientos, y ademas separa
    // la cabecera del listado de un vistazo
    ops.push(opLinea(MARGEN.izq, y, PAGINA.ancho - MARGEN.der, y, COLOR.rojo, 1.6));
    y -= 14;
  }

  /** Alto que ocupa un bloque, para decidir si cabe en lo que queda de hoja. */
  const altoDe = (partes) =>
    partes.reduce((n, p) => n + (p.tipo === "espacio" ? Number(p.alto) || 0 : ALTO[p.tipo] || 0), 0);

  function dibujar(parte) {
    switch (parte.tipo) {
      case "titulo":
        ops.push(opTexto(recortar(parte.texto, 11.5, ANCHO_UTIL, true), MARGEN.izq, y - 11, 11.5, { negrita: true }));
        break;

      case "cabecera": {
        // banda gris de lado a lado con una pestaña de color a la izquierda:
        // es lo que hace que cada persona se vea de lejos al pasar la hoja
        const alto = ALTO.cabecera - 5;
        ops.push(opRecuadro(MARGEN.izq, y - alto, ANCHO_UTIL, alto));
        ops.push(opRecuadro(MARGEN.izq, y - alto, 3.5, alto, parte.color || COLOR.rojo));

        let x = MARGEN.izq + 10;
        if (parte.indice) {
          const n = `${parte.indice}.`;
          ops.push(opTexto(n, x, y - alto + 5.5, 11, { negrita: true, color: COLOR.gris }));
          x += Math.max(anchoTexto(n, 11, true) + 6, 22);
        }
        const anchoDerecha = parte.derecha ? anchoTexto(parte.derecha, 9.5, true) : 0;
        const hueco = PAGINA.ancho - MARGEN.der - x - (anchoDerecha ? anchoDerecha + 14 : 0);
        ops.push(opTexto(recortar(parte.texto, 13, hueco, true), x, y - alto + 5.5, 13, { negrita: true }));
        if (parte.derecha) {
          ops.push(
            opTexto(parte.derecha, PAGINA.ancho - MARGEN.der - anchoDerecha - 6, y - alto + 5.5, 9.5, {
              negrita: true,
              color: COLOR.gris,
            })
          );
        }
        break;
      }

      case "nota":
        ops.push(opTexto(recortar(parte.texto, 8.5, ANCHO_UTIL - 12, false), MARGEN.izq + 12, y - 9, 8.5, { color: COLOR.gris }));
        break;

      case "grupo": {
        const color = parte.color || COLOR.rojo;
        ops.push(opRecuadro(MARGEN.izq + 12, y - 11.5, 7, 7, color));
        ops.push(
          opTexto(recortar(parte.texto, 8.5, ANCHO_UTIL - 34, true), MARGEN.izq + 24, y - 11, 8.5, {
            negrita: true,
            color,
          })
        );
        break;
      }

      case "item": {
        if (parte.fondo) ops.push(opRecuadro(MARGEN.izq + 12, y - 12.5, ANCHO_UTIL - 12, 12.5, COLOR.cebra));
        for (const col of parte.cols || []) {
          const x = MARGEN.izq + (Number(col.x) || 0);
          const ancho = Number(col.ancho) || PAGINA.ancho - MARGEN.der - x;
          ops.push(
            opTexto(recortar(col.texto, 9, ancho, col.negrita), x, y - 9.5, 9, {
              negrita: col.negrita,
              color: col.color,
            })
          );
        }
        break;
      }

      case "regla":
        ops.push(opLinea(MARGEN.izq, y - 5, PAGINA.ancho - MARGEN.der, y - 5));
        break;

      default:
        break; // "espacio" solo consume alto
    }
    y -= parte.tipo === "espacio" ? Number(parte.alto) || 0 : ALTO[parte.tipo] || 0;
  }

  nuevaPagina();
  for (const bloque of bloques) {
    const partes = Array.isArray(bloque) ? bloque : bloque?.partes || [];
    if (!partes.length) continue;
    const alto = altoDe(partes);
    const util = PAGINA.alto - MARGEN.arriba - MARGEN.abajo - 40;
    // si no cabe en lo que queda, a hoja nueva; si no cabe ni en una hoja
    // entera (alguien con muchos vencimientos), se deja fluir y se parte
    if (y - alto < MARGEN.abajo && alto <= util) nuevaPagina();
    for (const parte of partes) {
      // un titulo de grupo nunca se queda solo al pie: se lleva su primera fila
      const necesita = (ALTO[parte.tipo] || 0) + (parte.tipo === "grupo" ? ALTO.item : 0);
      if (y - necesita < MARGEN.abajo) nuevaPagina();
      dibujar(parte);
    }
  }

  // pie con la numeracion, ya sabiendo cuantas hojas salieron
  paginas.forEach((pagina, i) => {
    const texto = `Página ${i + 1} de ${paginas.length}`;
    const x = PAGINA.ancho - MARGEN.der - anchoTexto(texto, 8);
    pagina.push(opLinea(MARGEN.izq, MARGEN.abajo - 6, PAGINA.ancho - MARGEN.der, MARGEN.abajo - 6));
    pagina.push(opTexto(texto, x, MARGEN.abajo - 16, 8, { color: COLOR.gris }));
    if (titulo) pagina.push(opTexto(recortar(titulo, 8, 320), MARGEN.izq, MARGEN.abajo - 16, 8, { color: COLOR.gris }));
  });

  return new Blob([serializar(paginas)], { type: "application/pdf" });
}

/** Los objetos del PDF, la tabla de posiciones (xref) y el remate. */
function serializar(paginas) {
  const objetos = [];
  const nObjetos = 4 + paginas.length * 2; // catalogo, paginas, 2 fuentes, y hoja+contenido por pagina
  const idPagina = (i) => 5 + i * 2;
  const idContenido = (i) => 6 + i * 2;

  objetos[1] = "<< /Type /Catalog /Pages 2 0 R >>";
  objetos[2] =
    "<< /Type /Pages /Count " + paginas.length +
    " /Kids [" + paginas.map((_, i) => `${idPagina(i)} 0 R`).join(" ") + "] >>";
  objetos[3] = "<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica /Encoding /WinAnsiEncoding >>";
  objetos[4] = "<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica-Bold /Encoding /WinAnsiEncoding >>";

  paginas.forEach((ops, i) => {
    const flujo = ops.join("\n");
    objetos[idPagina(i)] =
      "<< /Type /Page /Parent 2 0 R " +
      `/MediaBox [0 0 ${PAGINA.ancho.toFixed(2)} ${PAGINA.alto.toFixed(2)}] ` +
      "/Resources << /Font << /F1 3 0 R /F2 4 0 R >> >> " +
      `/Contents ${idContenido(i)} 0 R >>`;
    objetos[idContenido(i)] = `<< /Length ${flujo.length} >>\nstream\n${flujo}\nendstream`;
  });

  let salida = "%PDF-1.4\n%\xE2\xE3\xCF\xD3\n"; // el comentario binario marca el archivo como no-texto
  const posiciones = [];
  for (let n = 1; n <= nObjetos; n++) {
    posiciones[n] = salida.length;
    salida += `${n} 0 obj\n${objetos[n]}\nendobj\n`;
  }

  const inicioXref = salida.length;
  salida += `xref\n0 ${nObjetos + 1}\n0000000000 65535 f \n`;
  for (let n = 1; n <= nObjetos; n++) {
    salida += String(posiciones[n]).padStart(10, "0") + " 00000 n \n";
  }
  salida += `trailer\n<< /Size ${nObjetos + 1} /Root 1 0 R >>\nstartxref\n${inicioXref}\n%%EOF\n`;

  // cada caracter de `salida` es ya un byte (todo paso por `literal`)
  return Uint8Array.from(salida, (ch) => ch.charCodeAt(0) & 0xff);
}

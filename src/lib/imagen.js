/**
 * Tablas de informe como imagen PNG.
 *
 * Es la misma tabla que se ve en pantalla —mismas columnas, mismo orden,
 * mismas pastillas de colores— pero dibujada sobre fondo claro y con TODAS
 * las filas, no solo las que caben en el scroll: la idea es poder pegarla en
 * un WhatsApp o en un correo sin que el receptor tenga que abrir nada.
 *
 * Se dibuja en un `<canvas>`, igual que el fotocheck en `fotocheck.js`, en vez
 * de fotografiar el DOM con una libreria tipo html2canvas: esa pesa varios
 * cientos de KB, nunca sale identica a lo que se ve y de todas formas habria
 * que desmontar el scroll y el tema oscuro para que la imagen sirviera. Aqui
 * se decide el pixel exacto de todo.
 *
 * Los colores son los del informe impreso (`@media print` en style.css), no
 * los de la pantalla: sobre blanco, el rojo y el ambar oscuros se leen bien y
 * sobreviven a una impresion.
 */

/** El mismo tipo de letra de la app; si no esta instalada cae al monoespaciado del sistema. */
const LETRA = '"JetBrains Mono", ui-monospace, "Cascadia Code", "Courier New", monospace';

/** Paleta sobre blanco. Coincide con la del PDF y la de la impresion. */
export const TINTA = {
  fondo: "#ffffff",
  papel: "#f4f5f7", // bandas y tarjetas
  tinta: "#17171b",
  gris: "#6b6b73",
  linea: "#d6d6dc",
  cebra: "#fafafb",
  rojo: "#a3122a",
  ambar: "#a66a00",
  verde: "#0a7a3c",
  acento: "#0e7490", // el cian de la app, oscurecido para que se lea sobre blanco
};

/**
 * Se dibuja al doble de resolucion y se declara el tamano logico por CSS: en
 * una pantalla normal ya se ve nitida, y al ampliarla o imprimirla no se
 * deshace.
 */
const ESCALA = 2;

const RELLENO = 28; // margen exterior del lienzo
const ALTO_FILA = 30;
const ALTO_CABECERA = 34;

/** Recorta con puntos suspensivos lo que no entra en `ancho` pixeles. */
function recortar(ctx, texto, ancho) {
  const t = String(texto ?? "");
  if (ctx.measureText(t).width <= ancho) return t;
  let corte = t;
  while (corte.length > 1 && ctx.measureText(corte + "…").width > ancho) {
    corte = corte.slice(0, -1);
  }
  return corte + "…";
}

/** Rectangulo con las esquinas redondeadas (las pastillas y las tarjetas). */
function caja(ctx, x, y, ancho, alto, radio) {
  ctx.beginPath();
  if (ctx.roundRect) ctx.roundRect(x, y, ancho, alto, radio);
  else ctx.rect(x, y, ancho, alto); // navegador viejo: sale con esquinas rectas
  return ctx;
}

/** Una pastilla con borde de color, como las de VENCIDOS / POR VENCER. */
function pastilla(ctx, texto, centroX, centroY, color) {
  ctx.font = `700 11px ${LETRA}`;
  const t = String(texto);
  const ancho = Math.max(26, ctx.measureText(t).width + 16);
  const alto = 18;
  const x = centroX - ancho / 2;
  const y = centroY - alto / 2;

  caja(ctx, x, y, ancho, alto, 9);
  ctx.strokeStyle = color;
  ctx.lineWidth = 1;
  ctx.stroke();

  ctx.fillStyle = color;
  ctx.textAlign = "center";
  ctx.fillText(t, centroX, centroY + 4);
}

/**
 * Dibuja la tabla y devuelve el PNG como Blob.
 *
 *   titulo     encabezado grande
 *   subtitulo  linea gris bajo el titulo (fecha, filtro aplicado...)
 *   tarjetas   [{ numero, rotulo, color }] el panel de totales de arriba
 *   columnas   [{ titulo, ancho, alinear, valor(fila), pastilla }]
 *              `ancho` es proporcional: se reparte el ancho util entre todas
 *   filas      los datos, ya filtrados y ordenados como se ven en pantalla
 *   pie        linea final (de donde salen los datos, cuando se genero)
 */
export async function armarPngTabla({ titulo, subtitulo = "", tarjetas = [], columnas, filas, pie = "" }) {
  if (!columnas?.length) throw new Error("la imagen necesita columnas");

  const anchoTabla = columnas.reduce((n, c) => n + c.ancho, 0);
  const ancho = anchoTabla + RELLENO * 2;

  const altoTarjetas = tarjetas.length ? 74 : 0;
  const altoTitulo = subtitulo ? 56 : 38;
  const altoPie = pie ? 26 : 0;
  const alto = RELLENO * 2 + altoTitulo + altoTarjetas + ALTO_CABECERA + filas.length * ALTO_FILA + altoPie;

  // Chrome no crea lienzos de mas de ~32.700 px de lado; por encima devuelve
  // uno en blanco sin avisar, que es peor que un error claro.
  const LIMITE = 30000;
  if (alto * ESCALA > LIMITE) {
    throw new Error(
      `son ${filas.length} filas y la imagen saldria de ${Math.round(alto)} px: filtra un poco (o usa el Excel) para que quepa`
    );
  }

  const lienzo = document.createElement("canvas");
  lienzo.width = Math.ceil(ancho * ESCALA);
  lienzo.height = Math.ceil(alto * ESCALA);
  const ctx = lienzo.getContext("2d");
  ctx.scale(ESCALA, ESCALA);
  ctx.textBaseline = "alphabetic";

  ctx.fillStyle = TINTA.fondo;
  ctx.fillRect(0, 0, ancho, alto);

  let y = RELLENO;

  /* ---------------- titulo ---------------- */

  ctx.textAlign = "left";
  ctx.fillStyle = TINTA.tinta;
  ctx.font = `700 19px ${LETRA}`;
  ctx.fillText(titulo, RELLENO, y + 16);
  y += 24;

  if (subtitulo) {
    ctx.fillStyle = TINTA.gris;
    ctx.font = `400 11px ${LETRA}`;
    ctx.fillText(subtitulo, RELLENO, y + 12);
    y += 20;
  }
  y += 14;

  /* ---------------- tarjetas de totales ---------------- */

  if (tarjetas.length) {
    const hueco = 10;
    const anchoTarjeta = (anchoTabla - hueco * (tarjetas.length - 1)) / tarjetas.length;
    tarjetas.forEach((t, i) => {
      const x = RELLENO + i * (anchoTarjeta + hueco);
      const color = t.color || TINTA.tinta;

      caja(ctx, x, y, anchoTarjeta, 58, 4);
      ctx.fillStyle = TINTA.papel;
      ctx.fill();
      ctx.strokeStyle = TINTA.linea;
      ctx.lineWidth = 1;
      ctx.stroke();

      // la pestana de color de la izquierda, igual que en pantalla
      ctx.fillStyle = color;
      ctx.fillRect(x, y, 3, 58);

      ctx.textAlign = "left";
      ctx.fillStyle = color;
      ctx.font = `700 24px ${LETRA}`;
      ctx.fillText(String(t.numero), x + 14, y + 30);

      ctx.fillStyle = TINTA.gris;
      ctx.font = `500 9.5px ${LETRA}`;
      ctx.fillText(String(t.rotulo).toUpperCase(), x + 14, y + 47);
    });
    y += altoTarjetas;
  }

  /* ---------------- cabecera de la tabla ---------------- */

  ctx.fillStyle = TINTA.papel;
  ctx.fillRect(RELLENO, y, anchoTabla, ALTO_CABECERA);

  ctx.font = `700 10px ${LETRA}`;
  let x = RELLENO;
  for (const col of columnas) {
    ctx.fillStyle = TINTA.acento;
    ctx.textAlign = col.alinear || "left";
    const centro = col.alinear === "center" ? x + col.ancho / 2 : col.alinear === "right" ? x + col.ancho - 10 : x + 10;
    ctx.fillText(recortar(ctx, String(col.titulo).toUpperCase(), col.ancho - 20), centro, y + 21);
    x += col.ancho;
  }

  ctx.strokeStyle = TINTA.linea;
  ctx.lineWidth = 1;
  ctx.beginPath();
  ctx.moveTo(RELLENO, y + ALTO_CABECERA - 0.5);
  ctx.lineTo(RELLENO + anchoTabla, y + ALTO_CABECERA - 0.5);
  ctx.stroke();
  y += ALTO_CABECERA;

  /* ---------------- filas ---------------- */

  filas.forEach((fila, i) => {
    if (i % 2) {
      ctx.fillStyle = TINTA.cebra;
      ctx.fillRect(RELLENO, y, anchoTabla, ALTO_FILA);
    }

    let x = RELLENO;
    for (const col of columnas) {
      const valor = col.valor(fila, i);
      const medio = y + ALTO_FILA / 2;

      if (col.pastilla) {
        pastilla(ctx, valor, x + col.ancho / 2, medio, col.pastilla(fila, valor) || TINTA.gris);
      } else {
        ctx.font = `${col.negrita ? 700 : 400} 11.5px ${LETRA}`;
        ctx.fillStyle = col.color?.(fila, valor) || TINTA.tinta;
        ctx.textAlign = col.alinear || "left";
        const centro =
          col.alinear === "center" ? x + col.ancho / 2 : col.alinear === "right" ? x + col.ancho - 10 : x + 10;
        ctx.fillText(recortar(ctx, valor, col.ancho - 20), centro, medio + 4);
      }
      x += col.ancho;
    }

    ctx.strokeStyle = TINTA.linea;
    ctx.lineWidth = 0.5;
    ctx.beginPath();
    ctx.moveTo(RELLENO, y + ALTO_FILA - 0.25);
    ctx.lineTo(RELLENO + anchoTabla, y + ALTO_FILA - 0.25);
    ctx.stroke();

    y += ALTO_FILA;
  });

  /* ---------------- pie ---------------- */

  if (pie) {
    ctx.textAlign = "left";
    ctx.fillStyle = TINTA.gris;
    ctx.font = `400 9.5px ${LETRA}`;
    ctx.fillText(pie, RELLENO, y + 17);
  }

  return new Promise((listo, falla) => {
    lienzo.toBlob((blob) => (blob ? listo(blob) : falla(new Error("el navegador no pudo generar el PNG"))), "image/png");
  });
}

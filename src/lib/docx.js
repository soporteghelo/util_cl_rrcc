/**
 * Genera el Word de autorizacion: arriba el fotocheck nuevo (10 cm de ancho
 * x 8 cm de alto) y debajo la foto del fotocheck antiguo.
 *
 * Se arma el OOXML a mano con JSZip (que ya esta en el proyecto para los ZIP)
 * en vez de sumar la libreria `docx`: un .docx es un ZIP con cuatro XML, y de
 * esos cuatro aca solo cambia el que lleva las dos imagenes. Evita una
 * dependencia de varios MB para producir un documento de dos parrafos.
 *
 * Las medidas van en EMU (English Metric Units), que es como mide OOXML:
 * 360000 EMU = 1 cm. Se fijan explicitamente en `wp:extent` y en `a:ext`
 * porque Word usa el primero para el hueco en la pagina y el segundo para el
 * dibujo; si no coinciden, la imagen sale recortada.
 */

import JSZip from "jszip";

export const EMU_POR_CM = 360000;
export const cmAEmu = (cm) => Math.round(cm * EMU_POR_CM);

const NS =
  'xmlns:wpc="http://schemas.microsoft.com/office/word/2010/wordprocessingCanvas" ' +
  'xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships" ' +
  'xmlns:m="http://schemas.openxmlformats.org/officeDocument/2006/math" ' +
  'xmlns:wp="http://schemas.openxmlformats.org/drawingml/2006/wordprocessingDrawing" ' +
  'xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main" ' +
  'xmlns:a="http://schemas.openxmlformats.org/drawingml/2006/main" ' +
  'xmlns:pic="http://schemas.openxmlformats.org/drawingml/2006/picture"';

const MIME_EXT = {
  "image/png": "png",
  "image/jpeg": "jpeg",
  "image/jpg": "jpeg",
  "image/gif": "gif",
  "image/bmp": "bmp",
};

/* ------------------------------------------------------------------ */
/* Piezas del documento                                                */
/* ------------------------------------------------------------------ */

function parrafoImagen(idRel, idDoc, nombre, anchoEmu, altoEmu) {
  return (
    "<w:p><w:r><w:drawing>" +
    '<wp:inline distT="0" distB="0" distL="0" distR="0">' +
    `<wp:extent cx="${anchoEmu}" cy="${altoEmu}"/>` +
    '<wp:effectExtent l="0" t="0" r="0" b="0"/>' +
    `<wp:docPr id="${idDoc}" name="${escapar(nombre)}"/>` +
    '<wp:cNvGraphicFramePr><a:graphicFrameLocks noChangeAspect="1"/></wp:cNvGraphicFramePr>' +
    '<a:graphic><a:graphicData uri="http://schemas.openxmlformats.org/drawingml/2006/picture">' +
    "<pic:pic>" +
    `<pic:nvPicPr><pic:cNvPr id="${idDoc}" name="${escapar(nombre)}"/><pic:cNvPicPr/></pic:nvPicPr>` +
    `<pic:blipFill><a:blip r:embed="${idRel}"/><a:stretch><a:fillRect/></a:stretch></pic:blipFill>` +
    "<pic:spPr>" +
    `<a:xfrm><a:off x="0" y="0"/><a:ext cx="${anchoEmu}" cy="${altoEmu}"/></a:xfrm>` +
    '<a:prstGeom prst="rect"><a:avLst/></a:prstGeom>' +
    "</pic:spPr>" +
    "</pic:pic>" +
    "</a:graphicData></a:graphic>" +
    "</wp:inline>" +
    "</w:drawing></w:r></w:p>"
  );
}

const escapar = (t) =>
  String(t ?? "")
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");

function documento(cuerpo) {
  return (
    '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>' +
    `<w:document ${NS}><w:body>` +
    cuerpo +
    // A4 vertical con margenes de 2 cm (1134 twips)
    '<w:sectPr><w:pgSz w:w="11906" w:h="16838"/>' +
    '<w:pgMar w:top="1134" w:right="1134" w:bottom="1134" w:left="1134" w:header="709" w:footer="709" w:gutter="0"/>' +
    "</w:sectPr></w:body></w:document>"
  );
}

function contentTypes(extensiones) {
  const defaults = ["rels", ...extensiones]
    .filter((v, i, a) => a.indexOf(v) === i)
    .map((ext) =>
      ext === "rels"
        ? '<Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/>'
        : `<Default Extension="${ext}" ContentType="image/${ext === "jpeg" ? "jpeg" : ext}"/>`
    )
    .join("");
  return (
    '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>' +
    '<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types">' +
    defaults +
    '<Default Extension="xml" ContentType="application/xml"/>' +
    '<Override PartName="/word/document.xml" ' +
    'ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.document.main+xml"/>' +
    "</Types>"
  );
}

/* ------------------------------------------------------------------ */
/* API publica                                                         */
/* ------------------------------------------------------------------ */

/**
 * `imagenes` = [{ datos, mime, anchoCm, altoCm, nombre }] en el orden en que
 * van en el documento. Devuelve un Blob listo para descargar o subir a Drive.
 */
export async function armarDocx(imagenes, tipo = "blob") {
  const zip = new JSZip();
  const utiles = imagenes.filter((i) => i && i.datos);
  if (!utiles.length) throw new Error("el Word necesita al menos una imagen");

  const rels = [];
  const extensiones = [];
  let cuerpo = "<w:p/>";

  for (let i = 0; i < utiles.length; i++) {
    const img = utiles[i];
    const ext = MIME_EXT[String(img.mime || "").toLowerCase()] || "png";
    const archivo = `image${i + 1}.${ext}`;
    const idRel = `rId${i + 10}`;

    zip.file(`word/media/${archivo}`, img.datos);
    rels.push(
      `<Relationship Id="${idRel}" ` +
        'Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/image" ' +
        `Target="media/${archivo}"/>`
    );
    extensiones.push(ext);

    cuerpo +=
      parrafoImagen(idRel, i + 1, img.nombre || archivo, cmAEmu(img.anchoCm), cmAEmu(img.altoCm)) + "<w:p/>";
  }

  zip.file("[Content_Types].xml", contentTypes(extensiones));
  zip.file(
    "_rels/.rels",
    '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>' +
      '<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">' +
      '<Relationship Id="rId1" ' +
      'Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" ' +
      'Target="word/document.xml"/>' +
      "</Relationships>"
  );
  zip.file("word/document.xml", documento(cuerpo));
  zip.file(
    "word/_rels/document.xml.rels",
    '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>' +
      '<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">' +
      rels.join("") +
      "</Relationships>"
  );

  return zip.generateAsync({
    type: tipo,
    mimeType: "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
    compression: "DEFLATE",
  });
}

/**
 * El Word de autorizacion de una persona.
 *
 * - `fotocheck`: PNG del fotocheck nuevo. Va SIEMPRE a 10 x 8 cm, que es el
 *   tamano que hoy tienen los documentos oficiales.
 * - `antiguo`: foto del fotocheck viejo. Se respeta su proporcion, limitando
 *   el ancho (por defecto 11.5 cm, lo que miden los documentos actuales).
 */
export async function armarAutorizacion({ fotocheck, antiguo = null, medidas = {}, tipo = "blob" }) {
  const anchoFc = Number(medidas.fotocheckAnchoCm ?? 10);
  const altoFc = Number(medidas.fotocheckAltoCm ?? 8);
  const anchoMax = Number(medidas.antiguoAnchoCm ?? 11.5);

  const imagenes = [
    {
      datos: fotocheck.datos,
      mime: fotocheck.mime || "image/png",
      anchoCm: anchoFc,
      altoCm: altoFc,
      nombre: "Fotocheck nuevo",
    },
  ];

  if (antiguo?.datos) {
    const proporcion = antiguo.alto && antiguo.ancho ? antiguo.alto / antiguo.ancho : 0.59;
    imagenes.push({
      datos: antiguo.datos,
      mime: antiguo.mime || "image/jpeg",
      anchoCm: anchoMax,
      altoCm: Number((anchoMax * proporcion).toFixed(2)),
      nombre: "Fotocheck antiguo",
    });
  }

  return armarDocx(imagenes, tipo);
}

/** Mide un PNG/JPEG sin decodificarlo del todo (para respetar su proporcion). */
export function medirImagen(blobOUrl) {
  return new Promise((resolver) => {
    const img = new Image();
    const url = typeof blobOUrl === "string" ? blobOUrl : URL.createObjectURL(blobOUrl);
    img.onload = () => {
      resolver({ ancho: img.naturalWidth, alto: img.naturalHeight });
      if (typeof blobOUrl !== "string") URL.revokeObjectURL(url);
    };
    img.onerror = () => {
      resolver({ ancho: 0, alto: 0 });
      if (typeof blobOUrl !== "string") URL.revokeObjectURL(url);
    };
    img.src = url;
  });
}

/**
 * Fuente Drive: carpeta publica fija con un PDF por persona, nombrado
 * "<DNI>_<APELLIDOS NOMBRES>.pdf". Sin DRIVE_API_KEY/DRIVE_FOLDER_ID esta
 * fuente queda desactivada en silencio (permite desplegar sin Drive).
 *
 * Buscar (files.list) usa la API oficial con API key: la carpeta puede tener
 * cientos de archivos y raspar la pagina publica solo trae los primeros 50.
 * Descargar (alt=media) no necesita API key: basta con que el archivo sea
 * publico.
 */

import { pedir, esPdf } from "./nexa.js";

const DRIVE_API = "https://www.googleapis.com/drive/v3";

function configurado() {
  const apiKey = process.env.DRIVE_API_KEY;
  const folderId = process.env.DRIVE_FOLDER_ID;
  return apiKey && folderId ? { apiKey, folderId } : null;
}

export async function driveBuscar(dni) {
  const cfg = configurado();
  if (!cfg) return { items: [], aviso: null };

  const q = `'${cfg.folderId}' in parents and trashed = false and name contains '${dni}'`;
  const url =
    `${DRIVE_API}/files?q=${encodeURIComponent(q)}` +
    `&fields=${encodeURIComponent("files(id,name)")}` +
    `&pageSize=25&key=${cfg.apiKey}`;

  const { buffer, res } = await pedir(url);
  if (res.status !== 200) {
    let detalle = `HTTP ${res.status}`;
    try {
      detalle = JSON.parse(buffer.toString("utf8"))?.error?.message || detalle;
    } catch {
      /* cuerpo no-json */
    }
    throw new Error(`Drive: ${detalle}`);
  }

  const datos = JSON.parse(buffer.toString("utf8"));

  // "contains" es coincidencia por subcadena, no por prefijo: un DNI mas
  // corto matchearia uno mas largo que lo contenga (mismo problema de
  // coincidencia parcial que EIN, documentado en el README). Por eso se
  // exige que el nombre arranque EXACTO con el DNI buscado.
  const encontrado = (datos.files || []).find((f) => f.name.startsWith(dni));

  if (!encontrado) {
    return {
      items: [
        {
          id: null,
          empresa: "",
          curso: "Certificado (Drive)",
          fecha: "",
          estado: "SIN CERTIFICADO",
          descargable: false,
          origen: "DRIVE",
        },
      ],
      aviso: `Drive: sin certificado para ${dni}`,
    };
  }

  return {
    items: [
      {
        id: encontrado.id,
        empresa: "",
        curso: encontrado.name.replace(/\.pdf$/i, ""),
        fecha: "",
        estado: "DISPONIBLE",
        descargable: true,
        origen: "DRIVE",
      },
    ],
    aviso: null,
  };
}

export async function driveDescargar(id) {
  if (!id) throw new Error("id de Drive invalido");
  const url = `https://drive.google.com/uc?export=download&id=${encodeURIComponent(id)}`;
  const { buffer, res } = await pedir(url, { timeout: 60000 });
  if (!esPdf(buffer)) throw new Error(`Drive: respuesta no-PDF (HTTP ${res.status})`);
  return buffer;
}

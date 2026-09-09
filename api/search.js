/**
 * POST /api/search
 * Body: { dni }
 *
 * Devuelve el inventario de certificados de un DNI en JOMISER.
 * No descarga nada: eso lo pide el navegador uno por uno a /api/download.
 */

import { jomiserBuscar, normalizarDni } from "./_lib/nexa.js";

export default async function handler(req, res) {
  if (req.method !== "POST") {
    res.status(405).json({ error: "Usa POST" });
    return;
  }

  try {
    const body = typeof req.body === "string" ? JSON.parse(req.body) : req.body || {};
    const norm = normalizarDni(body.dni);
    if (!norm) {
      res.status(400).json({ error: "DNI invalido" });
      return;
    }

    const salida = {
      dni: norm.dni,
      original: norm.original,
      relleno: norm.relleno,
      participante: "",
      items: [],
      error: null,
      aviso: null,
    };

    try {
      const r = await jomiserBuscar(norm.dni);
      salida.participante = r.participante;
      salida.items = r.items;
      salida.aviso = r.aviso;
    } catch (e) {
      salida.error = e.message;
    }

    salida.total = salida.items.filter((i) => i.descargable).length;
    res.status(200).json(salida);
  } catch (e) {
    res.status(500).json({ error: e?.message || String(e) });
  }
}

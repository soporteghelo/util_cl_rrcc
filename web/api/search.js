/**
 * POST /api/search
 * Body: { dni, jomiser?, ein?, usuario?, password?, cookies? }
 *
 * Devuelve el inventario de certificados de un DNI en ambas plataformas.
 * No descarga nada: eso lo pide el navegador uno por uno a /api/download.
 */

import { Jar, einBuscar, einLogin, jomiserBuscar, normalizarDni } from "./_lib/nexa.js";

const EIN_USUARIO = process.env.EIN_USUARIO || "MROBLESV";
const EIN_PASSWORD = process.env.EIN_PASSWORD || "123456";

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
    const dni = norm.dni;
    const usarJomiser = body.jomiser !== false;
    const usarEin = body.ein !== false;

    const salida = {
      dni,
      original: norm.original,
      relleno: norm.relleno,
      participante: "",
      jomiser: { items: [], error: null, aviso: null },
      ein: { items: [], error: null, aviso: null },
      cookies: null,
    };

    const tareas = [];

    if (usarJomiser) {
      tareas.push(
        jomiserBuscar(dni)
          .then((r) => {
            salida.jomiser.items = r.items;
            salida.jomiser.aviso = r.aviso;
            if (r.participante) salida.participante = salida.participante || r.participante;
          })
          .catch((e) => {
            salida.jomiser.error = e.message;
          })
      );
    }

    if (usarEin) {
      tareas.push(
        (async () => {
          const usuario = body.usuario || EIN_USUARIO;
          const password = body.password || EIN_PASSWORD;
          let jar = new Jar(body.cookies || "");
          try {
            if (jar.vacio) jar = await einLogin(usuario, password);
            let r;
            try {
              r = await einBuscar(jar, dni);
            } catch (e) {
              // sesion reutilizada que ya expiro: se reintenta con login nuevo
              if (!/sesion EIN expirada/i.test(e.message)) throw e;
              jar = await einLogin(usuario, password);
              r = await einBuscar(jar, dni);
            }
            salida.ein.items = r.items;
            salida.ein.aviso = r.aviso;
            salida.cookies = jar.cabecera;
            if (r.participante) salida.participante = salida.participante || r.participante;
          } catch (e) {
            salida.ein.error = e.message;
          }
        })()
      );
    }

    await Promise.all(tareas);

    salida.total = salida.jomiser.items.filter((i) => i.descargable).length + salida.ein.items.length;
    res.status(200).json(salida);
  } catch (e) {
    res.status(500).json({ error: e?.message || String(e) });
  }
}

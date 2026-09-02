/**
 * POST /api/download
 * Body JOMISER: { fuente: "JOMISER", id }
 * Body EIN:     { fuente: "EIN", dni, cod, usuario?, password?, cookies? }
 *
 * Devuelve UN PDF (binario). El navegador arma el ZIP con la estructura de
 * carpetas, porque una funcion serverless no puede escribir en disco ni
 * devolver mas de 4.5 MB por respuesta.
 */

import { Jar, einDescargar, einLogin, jomiserDescargar, normalizarDni } from "./_lib/nexa.js";

const EIN_USUARIO = process.env.EIN_USUARIO || "MROBLESV";
const EIN_PASSWORD = process.env.EIN_PASSWORD || "123456";

export default async function handler(req, res) {
  if (req.method !== "POST") {
    res.status(405).json({ error: "Usa POST" });
    return;
  }

  try {
    const body = typeof req.body === "string" ? JSON.parse(req.body) : req.body || {};
    const fuente = String(body.fuente || "").toUpperCase();

    /* ---------------- JOMISER ---------------- */
    if (fuente === "JOMISER") {
      const pdf = await jomiserDescargar(body.id);
      enviarPdf(res, pdf, { verificado: "na" });
      return;
    }

    /* ------------------ EIN ------------------ */
    if (fuente === "EIN") {
      const norm = normalizarDni(body.dni);
      if (!norm) {
        res.status(400).json({ error: "DNI invalido" });
        return;
      }
      const cod = String(body.cod || "");
      if (!/^\d+$/.test(cod)) {
        res.status(400).json({ error: "COD invalido" });
        return;
      }

      const usuario = body.usuario || EIN_USUARIO;
      const password = body.password || EIN_PASSWORD;

      let jar = new Jar(body.cookies || "");
      if (jar.vacio) jar = await einLogin(usuario, password);

      let r;
      try {
        r = await einDescargar(jar, norm.dni, cod);
      } catch (e) {
        if (!/sesion EIN expirada/i.test(e.message)) throw e;
        jar = await einLogin(usuario, password);
        r = await einDescargar(jar, norm.dni, cod);
      }

      if (r.pdf === null) {
        res.status(200).json({ sinCertificado: true, motivo: r.motivo });
        return;
      }
      enviarPdf(res, r.pdf, { verificado: r.verificado ? "si" : "no" });
      return;
    }

    res.status(400).json({ error: "fuente desconocida" });
  } catch (e) {
    res.status(502).json({ error: e?.message || String(e) });
  }
}

function enviarPdf(res, pdf, { verificado }) {
  res.setHeader("Content-Type", "application/pdf");
  res.setHeader("Content-Length", String(pdf.length));
  res.setHeader("X-Verificado", verificado);
  res.status(200).send(pdf);
}

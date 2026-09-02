/**
 * Servidor local que emula el enrutado de Vercel (estatico + /api/*).
 * Sirve para probar sin instalar la CLI de Vercel:
 *
 *    npm run build && node dev-server.js      ->  http://localhost:3000
 */

import http from "node:http";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const RAIZ = path.dirname(fileURLToPath(import.meta.url));
const DIST = path.join(RAIZ, "dist");
const PUERTO = Number(process.env.PORT || 3000);

const MIME = {
  ".html": "text/html; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".svg": "image/svg+xml",
  ".json": "application/json; charset=utf-8",
  ".ico": "image/x-icon",
};

/** Envoltorio con la forma de req/res que esperan las funciones de Vercel. */
function adaptar(res) {
  res.status = (c) => {
    res.statusCode = c;
    return res;
  };
  res.json = (o) => {
    res.setHeader("Content-Type", "application/json; charset=utf-8");
    res.end(JSON.stringify(o));
    return res;
  };
  res.send = (b) => {
    res.end(Buffer.isBuffer(b) ? b : String(b));
    return res;
  };
  return res;
}

const servidor = http.createServer(async (req, res) => {
  const url = new URL(req.url, `http://${req.headers.host}`);

  if (url.pathname.startsWith("/api/")) {
    const nombre = url.pathname.slice("/api/".length).replace(/[^a-z0-9_-]/gi, "");
    const archivo = path.join(RAIZ, "api", `${nombre}.js`);
    if (!fs.existsSync(archivo)) {
      adaptar(res).status(404).json({ error: "función no encontrada" });
      return;
    }

    const trozos = [];
    for await (const t of req) trozos.push(t);
    const crudo = Buffer.concat(trozos).toString("utf8");
    req.body = crudo ? JSON.parse(crudo) : {};

    try {
      const mod = await import(`file://${archivo}?t=${Date.now()}`);
      await mod.default(req, adaptar(res));
    } catch (e) {
      console.error(e);
      if (!res.headersSent) adaptar(res).status(500).json({ error: e.message });
    }
    return;
  }

  let rel = url.pathname === "/" ? "/index.html" : url.pathname;
  let archivo = path.join(DIST, rel);
  if (!fs.existsSync(archivo) || fs.statSync(archivo).isDirectory()) {
    archivo = path.join(DIST, "index.html"); // SPA fallback
  }
  res.setHeader("Content-Type", MIME[path.extname(archivo)] || "application/octet-stream");
  fs.createReadStream(archivo).pipe(res);
});

servidor.listen(PUERTO, () => {
  console.log(`listo -> http://localhost:${PUERTO}`);
});

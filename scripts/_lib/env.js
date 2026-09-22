/**
 * Carga el `.env` del proyecto (gitignorado) para que los scripts locales
 * tengan las mismas variables que las funciones en Vercel, sin tener que
 * exportarlas a mano en cada terminal. Lo que ya este en el entorno no se
 * pisa: asi se puede sobreescribir puntualmente desde la linea de comandos.
 */

import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

export function cargarEnv(raiz) {
  const base = raiz || path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "..");
  const ruta = path.join(base, ".env");
  if (!fs.existsSync(ruta)) return false;

  for (const linea of fs.readFileSync(ruta, "utf8").split(/\r?\n/)) {
    const t = linea.trim();
    if (!t || t.startsWith("#")) continue;
    const i = t.indexOf("=");
    if (i < 0) continue;
    const clave = t.slice(0, i).trim();
    let valor = t.slice(i + 1).trim();
    if (/^".*"$/s.test(valor) || /^'.*'$/s.test(valor)) valor = valor.slice(1, -1);
    if (!(clave in process.env)) process.env[clave] = valor;
  }
  return true;
}

/** Argumentos estilo `--clave valor` / `--bandera`, mas los sueltos. */
export function argumentos(argv = process.argv.slice(2)) {
  const opciones = {};
  const sueltos = [];
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a.startsWith("--")) {
      const clave = a.slice(2);
      const siguiente = argv[i + 1];
      if (siguiente === undefined || siguiente.startsWith("--")) {
        opciones[clave] = true;
      } else {
        opciones[clave] = siguiente;
        i++;
      }
    } else {
      sueltos.push(a);
    }
  }
  return { opciones, sueltos };
}

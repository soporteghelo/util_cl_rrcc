/** Cliente de las funciones serverless. */

async function pedir(ruta, cuerpo, senal) {
  const res = await fetch(ruta, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(cuerpo),
    signal: senal,
  });
  return res;
}

/** Inventario de certificados de un DNI. */
export async function buscar(cuerpo, senal) {
  const res = await pedir("/api/search", cuerpo, senal);
  const datos = await res.json().catch(() => ({ error: `respuesta ilegible (HTTP ${res.status})` }));
  if (!res.ok) throw new Error(datos.error || `HTTP ${res.status}`);
  return datos;
}

/** Descarga UN certificado. Devuelve { pdf: ArrayBuffer }. */
export async function descargar(cuerpo, senal) {
  const res = await pedir("/api/download", cuerpo, senal);
  const tipo = res.headers.get("content-type") || "";

  if (tipo.includes("application/pdf")) {
    return { pdf: await res.arrayBuffer() };
  }

  const datos = await res.json().catch(() => ({ error: `respuesta ilegible (HTTP ${res.status})` }));
  throw new Error(datos.error || `HTTP ${res.status}`);
}

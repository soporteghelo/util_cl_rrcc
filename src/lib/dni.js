/**
 * Normalizacion de documentos.
 *
 * El problema de los ceros: Excel guarda "07481337" como el NUMERO 7481337 y
 * pierde el cero. Al leer el archivo ya no existe. Como en ambas plataformas
 * todos los documentos son de 8 digitos, se rellena a 8 por la izquierda.
 *
 * Esto importa mas de lo que parece: si el DNI llega mal, la consulta puede
 * no encontrar a la persona o traer a quien no es.
 */

export const LARGO_DNI = 8;

export function normalizarDni(valor, largo = LARGO_DNI) {
  if (valor === null || valor === undefined) return null;
  let bruto = String(valor).trim();
  if (!bruto) return null;

  // Notacion cientifica de Excel: 7.1481337E+7
  if (/^\d+(\.\d+)?[eE][+-]?\d+$/.test(bruto)) {
    const n = Number(bruto);
    if (Number.isFinite(n)) bruto = String(Math.round(n));
  }
  // Decimal residual: "71481337.0"
  if (/^\d+\.0+$/.test(bruto)) bruto = bruto.split(".")[0];

  // Quita apostrofes de Excel, espacios, guiones, puntos de miles
  const digitos = bruto.replace(/\D/g, "");
  if (!digitos) return null;

  let dni = digitos;
  let relleno = 0;
  if (digitos.length < largo) {
    dni = digitos.padStart(largo, "0");
    relleno = largo - digitos.length;
  }

  return {
    dni,
    original: String(valor).trim(),
    relleno,
    largoAtipico: dni.length !== largo, // carne de extranjeria, pasaporte...
  };
}

/** Normaliza una lista, quita duplicados y conserva el orden. */
export function normalizarLista(valores) {
  const vistos = new Set();
  const items = [];
  const descartados = [];

  for (const v of valores) {
    const r = normalizarDni(v);
    if (!r) {
      const t = String(v ?? "").trim();
      if (t) descartados.push(t);
      continue;
    }
    if (vistos.has(r.dni)) continue;
    vistos.add(r.dni);
    items.push(r);
  }

  return {
    items,
    descartados,
    rellenados: items.filter((i) => i.relleno > 0),
    atipicos: items.filter((i) => i.largoAtipico),
  };
}

/** Extrae documentos de un texto pegado a mano (una linea o separados). */
export function desdeTexto(texto) {
  return String(texto || "")
    .split(/[\s,;|]+/)
    .map((t) => t.trim())
    .filter(Boolean);
}

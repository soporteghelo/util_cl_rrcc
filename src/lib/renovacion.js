/**
 * Motor de renovacion de la Autorizacion de Riesgos Criticos.
 *
 * Quien orquesta es el navegador, igual que en el extractor de certificados:
 * cada funcion serverless hace UNA operacion corta y vuelve. Con los 60 s de
 * Vercel Hobby no hay otra forma de procesar a una persona con 18 cursos, y
 * ademas permite ir pintando el avance en pantalla.
 *
 * Por persona:
 *   1. leer su fila de `BD AESA`           -> /api/sheets  (persona)
 *   2. inventariar sus certificados        -> /api/search
 *   3. recalcular fechas, estados y "A"    -> estados.js (aca, sin red)
 *   4. escribir la fila de vuelta          -> /api/sheets  (guardar)
 *   5. armar la carpeta de salida en Drive -> /api/download + /api/drive-output
 */

import { buscar, descargar, sheets, drive, aBase64, desdeBase64, blobABase64 } from "./api.js";
import { obtenerContexto, obtenerPersonal, obtenerPersona, anotarPersona } from "./datos.js";
import { renovarFila, copiarFila, leerFila, filaNueva, tiposDeMatriz, diferenciasFila } from "../../shared/estados.js";
import { fotocheckPng } from "./fotocheck.js";
import { armarAutorizacion, medirImagen } from "./docx.js";

export const MIME_DOCX = "application/vnd.openxmlformats-officedocument.wordprocessingml.document";

/* ------------------------------------------------------------------ */
/* Contexto (se carga una vez por corrida)                             */
/* ------------------------------------------------------------------ */

/**
 * CONFIG + diccionario de cursos + matriz por puesto, en una sola llamada.
 * Lo sirve `datos.js`: la primera pestana que lo pida lo trae y el resto lo
 * reutiliza sin volver a preguntarle a la hoja.
 */
export function cargarContexto() {
  return obtenerContexto();
}

/**
 * Todo el personal de `BD AESA`, para el reporte de vencimientos por RRCC.
 * Una sola llamada trae a todo el mundo en vez de consultar persona por
 * persona; cada elemento ya viene con la forma de `leerFila`.
 *
 * `filtro: "vencidos_activos"` le pide al backend que filtre ANTES de
 * serializar: para "estado total" es la diferencia entre bajar a las 600+
 * personas de la hoja (1.5+ MB, lo mas lento de la app) o solo a las pocas
 * decenas que estan vencidas y activas. Un backend viejo que no reconozca el
 * filtro simplemente lo ignora y sigue devolviendo a todo el mundo: por eso
 * quien llama debe seguir filtrando del lado del navegador igual.
 *
 * Lo sirve `datos.js`, que ademas lo comparte entre pestanas: si ESTADO RRCC
 * ya bajo el listado completo, el filtrado que necesita ESTADO TOTAL sale de
 * ahi sin tocar la red.
 */
export function listarPersonal(senal, filtro) {
  return obtenerPersonal({ filtro });
}

/**
 * Nombre de la carpeta de la persona. La plantilla vive en CONFIG para no
 * tener que tocar codigo si manana la quieren con el DNI delante.
 */
export function nombreCarpeta(persona, config = {}) {
  const plantilla = config.PLANTILLA_CARPETA || "{DNI}_{APELLIDOS} {NOMBRES}";
  return plantilla
    .replace(/\{APELLIDOS\}/gi, persona.apellidos || "")
    .replace(/\{NOMBRES\}/gi, persona.nombres || "")
    .replace(/\{NOMBRE\}/gi, persona.nombreCompleto || "")
    .replace(/\{DNI\}/gi, persona.dni || "")
    .replace(/\{CODIGO\}/gi, persona.codigo || "")
    .replace(/\s+/g, " ")
    .trim();
}

const nombreCertificado = (item) =>
  [item.fecha, item.curso].filter(Boolean).join("_").replace(/[\\/:*?"<>|]+/g, " ").trim() + ".pdf";

/* ------------------------------------------------------------------ */
/* Paso 1-4: recalcular y guardar la fila                              */
/* ------------------------------------------------------------------ */

/**
 * Renueva a una persona y deja su fila escrita en la hoja.
 * Devuelve { estado: "ok" | "nuevo" | "error", ... }.
 */
export async function renovarPersona(dni, ctx, { log = () => {}, senal, escribir = true } = {}) {
  log(`buscando ${dni} en la base...`);
  // lo que va a escribir lee SIEMPRE de la hoja: recalcular sobre una copia
  // cacheada pisaria lo que otro haya editado desde que se guardo esa copia.
  const registro = await obtenerPersona(dni, { refrescar: escribir, senal });

  if (!registro.encontrada) {
    log(`${dni} no esta en la base: hay que darlo de alta como personal nuevo`, "warn");
    return { estado: "nuevo", dni };
  }

  const antes = leerFila(registro.valores);
  log(`${antes.nombreCompleto || dni} · fila ${registro.fila}`, "ok");

  log("consultando certificados (JOMISER + EIN + Drive)...");
  const inventario = await buscar({ dni }, senal);
  for (const aviso of inventario.avisos || []) log(`  ${aviso}`, "warn");

  const resultado = renovarFila({
    fila: registro.valores,
    items: inventario.items || [],
    diccionario: ctx.diccionario,
    config: ctx.config,
  });

  const cambiados = resultado.detalle.filter((d) => d.cambio === "NUEVO" || d.cambio === "ACTUALIZADO");
  log(`${cambiados.length} riesgo(s) con certificado nuevo`, cambiados.length ? "ok" : "info");
  for (const a of resultado.alertas) log(`  ${a.codigo ? a.codigo + ": " : ""}${a.motivo}`, a.nivel === "error" ? "err" : "warn");

  if (escribir) {
    await sheets(
      { accion: "guardar", fila: registro.fila, valores: resultado.fila, noMapeados: resultado.noMapeados },
      senal
    );
    // el resto de las pestanas repinta sola con esta fila: no hay que recargar
    anotarPersona({ dni, fila: registro.fila, valores: resultado.fila });
    log("fila actualizada en la hoja", "ok");
  }

  return {
    estado: "ok",
    dni,
    fila: registro.fila,
    antes,
    despues: leerFila(resultado.fila),
    valores: resultado.fila,
    // la fila tal como queda en la hoja: la recalculada si se escribio, la
    // original si fue solo consulta. Es la base de las ediciones manuales.
    enHoja: escribir ? resultado.fila : copiarFila(registro.valores),
    detalle: resultado.detalle,
    alertas: resultado.alertas,
    personales: resultado.personales,
    inventario,
  };
}

/* ------------------------------------------------------------------ */
/* Guardar una fila y comprobar que la hoja la tiene                   */
/* ------------------------------------------------------------------ */

/**
 * Guarda la fila y la RELEE de la hoja para confirmar que quedo como se pidio.
 *
 * Hace falta porque Apps Script a veces ejecuta el guardado pero entrega una
 * respuesta rota (pagina 404 de Drive) cuando se demora: sin la relectura, la
 * app diria "no se pudo guardar" con el cambio ya en la hoja. Si el guardado
 * falla pero la relectura muestra la fila como se pidio, cuenta como guardado
 * (`recuperado`). Si falla y la hoja no coincide, se lanza el error original.
 *
 * `codigos` = los riesgos que se quiere comprobar; `datos` = columnas de A:O
 * a corregir ({ "F. Vencimiento": "2026-10-03", "Area Planilla": "MINA" }), que
 * tambien se comprueban. Devuelve { fila, valores
 * (la fila tal como esta en la hoja), diferencias, confirmado, recuperado }.
 */
export async function guardarFilaVerificada({ fila, valores, dni, codigos, datos = {}, noMapeados = [], senal }) {
  let errorGuardado = null;
  let respuesta = null;
  try {
    respuesta = await sheets({ accion: "guardar", fila, valores, datos, noMapeados }, senal);
  } catch (e) {
    if (senal?.aborted) throw e;
    errorGuardado = e;
  }

  let leido = null;
  try {
    // `refrescar` obligatorio: la gracia de este paso es ver lo que quedo en
    // la hoja, no lo que la app creia que habia
    leido = await obtenerPersona(dni, { refrescar: true, senal });
  } catch (e) {
    if (errorGuardado) throw errorGuardado; // ni se pudo guardar ni comprobar
    throw new Error(`se guardo, pero no se pudo releer la hoja para confirmarlo: ${e.message}`);
  }
  if (!leido?.encontrada || Number(leido.fila) !== Number(fila)) {
    throw errorGuardado || new Error("no se pudo confirmar: la persona no esta en la fila esperada de la hoja");
  }

  const diferencias = diferenciasFila(valores, leido.valores, codigos, Object.keys(datos));
  if (errorGuardado && diferencias.length) throw errorGuardado; // no se guardo
  // lo releido es la version confirmada: con eso se parchea lo compartido y
  // las demas pestanas quedan al dia sin volver a bajar el listado
  anotarPersona({ dni, fila: leido.fila, valores: leido.valores });
  return {
    fila: Number(fila),
    valores: copiarFila(leido.valores),
    diferencias,
    confirmado: diferencias.length === 0,
    recuperado: Boolean(errorGuardado),
    formulaReemplazada: respuesta?.formulaReemplazada || [],
  };
}

/* ------------------------------------------------------------------ */
/* Consulta: ver a la persona y verificar sus "A" sin tocar nada       */
/* ------------------------------------------------------------------ */

/**
 * Resumen de las autorizaciones de una persona: cuantas "A" tiene, cuantas
 * siguen vigentes y cuales hay que renovar.
 *
 * Se calcula sobre el resultado YA recalculado con los certificados de
 * JOMISER, EIN y Drive, asi que "vigente" quiere decir que existe un
 * certificado que lo respalda hoy, no que la hoja lo diga.
 */
export function resumenAutorizaciones(detalle = []) {
  const autorizados = detalle.filter((d) => d.tipo === "A");
  const porEstado = (e) => autorizados.filter((d) => d.estado === e);
  return {
    total: autorizados.length,
    vigentes: porEstado("VIGENTE"),
    porVencer: porEstado("ACTUALIZAR"),
    vencidos: porEstado("VENCIDO"),
    sinCertificado: autorizados.filter((d) => d.estado === "NO APLICA"),
    capacitados: detalle.filter((d) => d.tipo === "C" && d.cap).length,
    conCertificadoNuevo: detalle.filter((d) => d.cambio === "NUEVO" || d.cambio === "ACTUALIZADO").length,
  };
}

/**
 * Consulta de solo lectura: trae los datos de la persona y verifica la
 * vigencia de sus autorizaciones contra JOMISER, EIN y Drive. No escribe en
 * la hoja ni crea nada en Drive.
 */
export async function consultarPersona(dni, ctx, opciones = {}) {
  const r = await renovarPersona(dni, ctx, { ...opciones, escribir: false });
  if (r.estado !== "ok") return r;
  return { ...r, consulta: true, resumen: resumenAutorizaciones(r.detalle) };
}

/* ------------------------------------------------------------------ */
/* Paso 5: la carpeta de salida en Drive                               */
/* ------------------------------------------------------------------ */

/**
 * Crea la carpeta de la persona en Drive y le deja dentro:
 *   - los certificados de los RRCC que quedaron VIGENTES,
 *   - el PNG del fotocheck nuevo,
 *   - el Word con el fotocheck nuevo (10 x 8 cm) y la foto del antiguo.
 */
export async function generarSalidas(resultado, ctx, { log = () => {}, senal, avance = () => {}, antiguoManual = null } = {}) {
  const persona = resultado.despues;
  const nombre = nombreCarpeta(persona, ctx.config);

  log(`carpeta de Drive "${nombre}"...`);
  const carpeta = await drive({ accion: "carpeta", nombre }, senal);
  log(carpeta.creada ? `carpeta creada` : `carpeta ya existia, se actualiza`, "ok");

  const salida = { carpetaId: carpeta.carpetaId, nombre, certificados: [], fotocheck: null, word: null, fallos: [] };

  /* --- certificados vigentes ---
   * Tanto "A" (autorizados) como "C" (capacitados) suben su PDF si esta
   * vigente y se puede descargar. Los de origen EIN quedan fuera de la
   * carpeta de salida a pedido del area. */
  const vigentes = resultado.detalle.filter(
    (d) =>
      d.estado === "VIGENTE" &&
      d.certificado &&
      d.certificado.descargable &&
      d.certificado.origen !== "EIN"
  );
  log(`${vigentes.length} certificado(s) vigente(s) para subir`);

  for (const [i, d] of vigentes.entries()) {
    if (senal?.aborted) break;
    const cert = d.certificado;
    avance(i, vigentes.length, `${d.codigo} · ${cert.curso}`);
    try {
      const r = await descargar(
        { id: cert.id, origen: cert.origen, ...(cert.datosDescarga || {}) },
        senal
      );
      if (r.sinCertificado) {
        log(`  · ${d.codigo}: sin certificado emitido`, "warn");
        continue;
      }
      const subido = await drive(
        {
          accion: "subir",
          carpetaId: carpeta.carpetaId,
          nombre: nombreCertificado(cert),
          mime: "application/pdf",
          datos: aBase64(r.pdf),
        },
        senal
      );
      salida.certificados.push(subido);
      log(`  · ${d.codigo}: ${(r.pdf.byteLength / 1024).toFixed(0)} KB → ${subido.nombre}`, "ok");
    } catch (e) {
      salida.fallos.push({ codigo: d.codigo, error: e.message });
      log(`  · ${d.codigo}: ${e.message}`, "err");
    }
  }

  /* --- el PDF consolidado de Drive, si lo hay ---
   * No es de ningun curso, asi que no entra en la grilla de riesgos, pero es
   * un certificado de la persona y va en su carpeta igual. La reinduccion
   * (origen INDUCCION) queda fuera de la carpeta a pedido del area. */
  for (const item of resultado.personales || []) {
    if (senal?.aborted || !item.descargable || item.origen === "INDUCCION") continue;
    try {
      const r = await descargar({ id: item.id, origen: item.origen, ...(item.datosDescarga || {}) }, senal);
      if (r.sinCertificado) continue;
      const subido = await drive(
        {
          accion: "subir",
          carpetaId: carpeta.carpetaId,
          nombre: `${item.archivo ? item.archivo.replace(/\.pdf$/i, "") : item.curso}.pdf`.replace(/[\\/:*?"<>|]+/g, " "),
          mime: "application/pdf",
          datos: aBase64(r.pdf),
        },
        senal
      );
      salida.certificados.push(subido);
      log(`  · [${item.origen}] ${subido.nombre}`, "ok");
    } catch (e) {
      salida.fallos.push({ codigo: "DRIVE", error: e.message });
      log(`  · [${item.origen}] ${item.curso}: ${e.message}`, "err");
    }
  }

  /* --- fotocheck nuevo --- */
  log("dibujando el fotocheck...");
  const foto = await fotoDeDni(persona.dni, senal).catch((e) => {
    log(`  sin foto de la persona: ${e.message}`, "warn");
    return null;
  });
  const png = await fotocheckPng(persona, { foto });
  const pngBase64 = await blobABase64(png.blob);

  salida.fotocheck = await drive(
    {
      accion: "subir",
      carpetaId: carpeta.carpetaId,
      nombre: `FOTOCHECK_${persona.nombreCompleto || persona.dni}.png`,
      mime: "image/png",
      datos: pngBase64,
    },
    senal
  );
  log(`fotocheck subido (${png.ancho}x${png.alto} px)`, "ok");

  /* --- Word de autorizacion ---
   * Si se adjunto a mano desde la ficha (boton "fotocheck antiguo"), esa
   * imagen manda y no se vuelve a pedir la de Drive. */
  const antiguo =
    antiguoManual ||
    (await fotoAntigua(persona.fotocheckAntiguoDriveId, senal).catch((e) => {
      log(`  sin foto del fotocheck antiguo: ${e.message}`, "warn");
      return null;
    }));

  const docx = await armarAutorizacion({
    fotocheck: { datos: await png.blob.arrayBuffer(), mime: "image/png" },
    antiguo,
    medidas: {
      fotocheckAnchoCm: Number(ctx.config.FOTOCHECK_ANCHO_CM || 10),
      fotocheckAltoCm: Number(ctx.config.FOTOCHECK_ALTO_CM || 8),
      antiguoAnchoCm: Number(ctx.config.ANTIGUO_ANCHO_CM || 17),
    },
  });

  salida.word = await drive(
    {
      accion: "subir",
      carpetaId: carpeta.carpetaId,
      nombre: `Autorizacion_RRCC_${persona.nombreCompleto || persona.dni}.docx`,
      mime: MIME_DOCX,
      datos: await blobABase64(docx),
    },
    senal
  );
  log(`Word de autorizacion subido`, "ok");

  // se devuelven las imagenes ya bajadas para que la vista pueda abrir la
  // previsualizacion sin volver a pedirlas a Drive
  salida.blobs = { fotocheck: png.blob, word: docx };
  salida.foto = foto;
  salida.antiguo = antiguo;
  return salida;
}

/**
 * Foto de la persona, buscada por documento en la carpeta FOTOS.
 *
 * No se usa la columna FOTO de la hoja porque guarda una ruta de texto
 * ("FOTOS/47259616.png"), no un id, y porque las fotos estan subidas con las
 * dos grafias del documento (con y sin el cero inicial). Buscar por DNI
 * normalizado resuelve las dos cosas de una vez.
 */
export async function fotoDeDni(dni, senal) {
  if (!dni) throw new Error("la fila no tiene DNI");
  const r = await drive({ accion: "foto-de", dni }, senal);
  if (!r.encontrada) throw new Error(`no hay foto de ${dni} en la carpeta FOTOS`);
  return `data:${r.mime};base64,${r.datos}`;
}

/** Foto del fotocheck antiguo, con sus dimensiones (para no deformarla). */
async function fotoAntigua(idDrive, senal) {
  if (!idDrive) throw new Error("la fila no tiene FOTOCHECK_ANTIGUO_DRIVE_ID");
  const r = await drive({ accion: "bajar", id: idDrive }, senal);
  const bytes = desdeBase64(r.datos);
  const medida = await medirImagen(new Blob([bytes], { type: r.mime }));
  return { datos: bytes, mime: r.mime, ancho: medida.ancho, alto: medida.alto };
}

/* ------------------------------------------------------------------ */
/* Alta de personal nuevo                                              */
/* ------------------------------------------------------------------ */

/**
 * Da de alta a una persona y despues le corre el mismo motor de renovacion,
 * para que sus fechas salgan de los certificados y no a mano.
 */
export async function altaPersona(datos, ctx, { log = () => {}, senal, tipos = null } = {}) {
  const porMatriz = tipos || tiposDeMatriz(ctx.matriz, datos.cargo, datos.area);
  const marcados = Object.keys(porMatriz).length;
  log(`matriz por puesto: ${marcados} riesgo(s) marcados para "${datos.cargo || "sin cargo"}"`, marcados ? "ok" : "warn");

  const fila = filaNueva({ datos, tipos: porMatriz });
  const alta = await sheets({ accion: "alta", valores: fila }, senal);
  if (!alta.ok) {
    if (alta.yaExiste) log(alta.error, "warn");
    return { estado: "existe", ...alta };
  }
  log(`alta creada con codigo ${alta.codigo} (fila ${alta.fila})`, "ok");
  // la persona nueva entra ya en el listado compartido: ESTADO RRCC y ESTADO
  // TOTAL la ven sin recargar, aunque la renovacion que sigue todavia no haya
  // terminado de ponerle fechas
  anotarPersona({ dni: datos.dni, fila: alta.fila, valores: alta.valores || fila });

  return renovarPersona(datos.dni, ctx, { log, senal });
}

/** Sube la foto de una persona a la carpeta de fotos y devuelve su id. */
export async function subirFoto(archivo, { nombre, senal } = {}) {
  const datos = await blobABase64(archivo);
  const r = await drive(
    { accion: "foto", nombre: nombre || archivo.name, mime: archivo.type || "image/jpeg", datos },
    senal
  );
  return r.id;
}

/**
 * Piezas de interfaz que comparten las tres vistas: la consola, la barra de
 * progreso, el aviso de fin y el cambio de pestana.
 */

export const $ = (id) => document.getElementById(id);

/* ------------------------------------------------------------------ */
/* Consola                                                             */
/* ------------------------------------------------------------------ */

/**
 * Devuelve una funcion `log(texto, clase)` atada a un panel de consola.
 * El cursor parpadeante se va moviendo al final, como en una terminal.
 */
export function crearConsola(idTerm, idLimpiar) {
  const term = $(idTerm);
  let cursor = null;

  function log(texto, clase = "info") {
    if (!term) return;
    cursor?.remove();
    const linea = document.createElement("div");
    linea.className = `ln ln-${clase}`;
    linea.textContent = texto;
    term.appendChild(linea);

    cursor = document.createElement("span");
    cursor.className = "cursor";
    term.appendChild(cursor);
    term.scrollTop = term.scrollHeight;
  }

  log.limpiar = () => {
    if (term) term.innerHTML = "";
    cursor = null;
  };
  log.cabecera = (t) => log(t, "head");

  $(idLimpiar)?.addEventListener("click", log.limpiar);
  return log;
}

/* ------------------------------------------------------------------ */
/* Barra de progreso                                                   */
/* ------------------------------------------------------------------ */

/** `prefijo` es el id sin sufijo: "rn" para #rn-bar-fill, #rn-bar-txt, ... */
export function crearProgreso(prefijo) {
  const p = prefijo ? `${prefijo}-` : "";
  const envoltorio = $(`${p}bar-wrap`);
  const relleno = $(`${p}bar-fill`);
  const texto = $(`${p}bar-txt`);
  const porcentaje = $(`${p}bar-pct`);

  return {
    mostrar(visible = true) {
      if (envoltorio) envoltorio.hidden = !visible;
    },
    set(hecho, total, mensaje) {
      const pct = total ? Math.round((hecho / total) * 100) : 0;
      if (relleno) relleno.style.width = `${pct}%`;
      if (porcentaje) porcentaje.textContent = `${pct}%`;
      if (texto) texto.textContent = mensaje;
    },
  };
}

/* ------------------------------------------------------------------ */
/* Aviso de fin                                                        */
/* ------------------------------------------------------------------ */

let cerrarToast = null;

/**
 * Avisa por tres vias, porque un lote tarda y se suele dejar en segundo
 * plano: el aviso en la pagina, la notificacion del sistema y un pitido.
 */
export function notificar(titulo, detalle, tipo = "ok") {
  const toast = $("toast");
  if (toast) {
    clearTimeout(cerrarToast);
    toast.className = `toast ${tipo === "ok" ? "" : tipo}`.trim();
    $("toast-ic").textContent = tipo === "ok" ? "✓" : "!";
    $("toast-tit").textContent = titulo;
    $("toast-sub").textContent = detalle;
    toast.hidden = false;

    // reinicia la animacion de la barra al reutilizar el mismo nodo
    const barra = toast.querySelector(".toast-bar");
    if (barra) {
      barra.style.animation = "none";
      void barra.offsetWidth;
      barra.style.animation = "";
    }
    cerrarToast = setTimeout(() => (toast.hidden = true), 12000);
  }

  try {
    if ("Notification" in window && Notification.permission === "granted") {
      const n = new Notification(titulo, { body: detalle, icon: "/favicon.svg", tag: "aesa-rrcc" });
      n.onclick = () => {
        window.focus();
        n.close();
      };
    }
  } catch {
    /* algunos navegadores lanzan si la pagina no es segura */
  }

  if (tipo === "ok") pitido();
}

export function pitido() {
  try {
    const ctx = new (window.AudioContext || window.webkitAudioContext)();
    const t0 = ctx.currentTime;
    for (const [i, hz] of [880, 1320].entries()) {
      const osc = ctx.createOscillator();
      const gan = ctx.createGain();
      osc.type = "sine";
      osc.frequency.value = hz;
      gan.gain.setValueAtTime(0.0001, t0 + i * 0.11);
      gan.gain.exponentialRampToValueAtTime(0.08, t0 + i * 0.11 + 0.01);
      gan.gain.exponentialRampToValueAtTime(0.0001, t0 + i * 0.11 + 0.1);
      osc.connect(gan).connect(ctx.destination);
      osc.start(t0 + i * 0.11);
      osc.stop(t0 + i * 0.11 + 0.11);
    }
    setTimeout(() => ctx.close(), 600);
  } catch {
    /* sin audio disponible */
  }
}

/** Pide permiso de notificacion sin bloquear: el dialogo pararia el lote. */
export function pedirPermisoAviso() {
  try {
    if ("Notification" in window && Notification.permission === "default") {
      Notification.requestPermission().catch(() => {});
    }
  } catch {
    /* sin soporte */
  }
}

/* ------------------------------------------------------------------ */
/* Pestanas                                                            */
/* ------------------------------------------------------------------ */

export function montarPestanas(pares) {
  const botones = pares.map(([idTab]) => $(idTab));

  function activar(indice) {
    pares.forEach(([idTab, idVista], i) => {
      const activo = i === indice;
      const tab = $(idTab);
      const vista = $(idVista);
      if (tab) {
        tab.classList.toggle("activo", activo);
        tab.setAttribute("aria-selected", String(activo));
      }
      if (vista) vista.hidden = !activo;
    });
  }

  botones.forEach((boton, i) => boton?.addEventListener("click", () => activar(i)));
  activar(0);
  return activar;
}

/* ------------------------------------------------------------------ */
/* Descargas                                                           */
/* ------------------------------------------------------------------ */

export function descargarBlob(blob, nombre) {
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url;
  a.download = nombre;
  document.body.appendChild(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 4000);
}

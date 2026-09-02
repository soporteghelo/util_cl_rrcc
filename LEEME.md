# Extractor de Certificados — JOMISER + EIN

Descarga todos los certificados de una persona (o de una lista de personas) desde
**JOMISER** (`aula.jomiser.com`) y **EIN / WebNexa** (`Certificados > Cert. x Persona`).

Hay **dos versiones**, y comparten la misma lógica:

| | Escritorio | Web |
|---|---|---|
| Archivo | `descargar_certificados.py` | carpeta `web/` |
| Interfaz | tkinter (ventana Windows) | Vite, estética terminal, responsive |
| Entrada | un DNI | un DNI, lista pegada o **Excel/CSV** |
| Salida | escribe en la ruta que elijas | ZIP, o carpeta real (Chrome/Edge) |
| Requiere | Python 3.8+ | desplegar en Vercel |
| Ideal para | lotes largos sin límite de tiempo | usar desde el móvil o compartir |

---

## Versión de escritorio

Doble clic en **`EJECUTAR.bat`**, o:

```
python descargar_certificados.py                      # ventana
python descargar_certificados.py 71481337 "D:\Certif" # consola
```

## Versión web

Ver **[web/README.md](web/README.md)** para desplegar en Vercel.

```bash
cd web && npm install && npm run build && node dev-server.js
```

---

## Lo que generan (ambas, igual)

```
71481337/
├── JOMISER/
│   ├── 2026-08-28_EXCAVACIONES SUBTERRÁNEAS.pdf
│   ├── 2026-08-29_TRABAJOS EN ALTURA.pdf
│   ├── 2026-08-29_HERRAMIENTAS DE PODER.pdf
│   └── 2026-08-30_SUSTANCIAS QUÍMICAS PELIGROSAS.pdf
├── EIN/
│   ├── 137518_RIESGOS CRITICOS_09-08-2026.pdf
│   └── 137197_INDUCCIÓN_15-08-2026.pdf
└── resumen.txt
```

`resumen.txt` lista todo: lo descargado, lo que no tiene certificado
(desaprobados) y los errores.

---

## Ceros a la izquierda — por qué importa tanto

Excel guarda `07481337` como el **número** 7481337: el cero desaparece del
archivo. Como en ambas plataformas todos los documentos son de 8 dígitos, las dos
versiones rellenan a 8 y avisan del cambio.

No es un detalle cosmético. **EIN busca por coincidencia parcial (LIKE):**

| Búsqueda en EIN | Resultado |
|---|---|
| `10350889` | los certificados de 10350889 ✓ |
| `0350889` | ⚠️ **también** los de 10350889 |
| `350889` | ⚠️ **también** los de 10350889 |

Un DNI sin su cero **no da error**: entrega en silencio los certificados de otra
persona. Por eso, además de rellenar, ambas versiones **descartan toda fila cuyo
NDocumento no sea idéntico al DNI pedido** y lo avisan.

---

## Particularidades del servidor EIN que las apps manejan

- **Devuelve el certificado de otra persona de forma intermitente.** Bug de
  concurrencia del reporte Crystal en el servidor (~1 de cada 4 descargas; pasa
  igual haciendo clic a mano). Cada PDF se abre, se extrae su texto y se verifica
  que el registro `<COD><DNI>` sea el esperado; si no, se reintenta. Sin esta
  comprobación archivarías certificados equivocados sin notarlo.
- **La página del reporte cambia según el curso**: RIESGOS CRÍTICOS abre
  `WebFormCertificad.aspx` e INDUCCIÓN `WebFormCertificad_induccion.aspx`. Se usa
  la URL a la que redirige el servidor, no una fija, así que cursos nuevos
  funcionan solos.
- **Los desaprobados no generan certificado** en ninguna de las dos plataformas:
  se marcan `SIN CERTIFICADO`, no como error.
- **Corta conexiones al azar**: todas las peticiones reintentan con espera
  progresiva.
- La empresa "TP" del combo EMPRESA devuelve error 500; se usa siempre la
  seleccionada por defecto (NEXA MINERIA).

---

## Configuración

**Escritorio** — constantes al inicio de `descargar_certificados.py`:
`CARPETA_JOMISER`, `CARPETA_EIN`, `EIN_USUARIO`, `EIN_PASSWORD`,
`EIN_INTENTOS_VALIDACION`.

**Web** — variables de entorno en Vercel: `EIN_USUARIO`, `EIN_PASSWORD`.
También se pueden sobrescribir desde la interfaz.

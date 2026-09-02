# Extractor de Certificados — JOMISER + EIN

Descarga todos los certificados de una persona (o de una lista) desde
**JOMISER** (`aula.jomiser.com`) y **EIN / WebNexa** (`Certificados > Cert. x Persona`).

Hay **dos versiones** que comparten la misma lógica de extracción:

| | Web (este repo, raíz) | Escritorio |
|---|---|---|
| Ubicación | `/` | `escritorio/` |
| Interfaz | Vite, estética terminal, responsive | tkinter (ventana Windows) |
| Entrada | un DNI, lista pegada o **Excel/CSV** | un DNI |
| Salida | carpeta elegida por el usuario, o ZIP | escribe en la ruta que elijas |
| Requiere | desplegar en Vercel (o `npm run dev`) | Python 3.8+, sin dependencias |
| Ideal para | usar desde el móvil o compartir | lotes largos sin límite de tiempo |

---

## Estructura

```
├── index.html            interfaz
├── src/
│   ├── main.js           orquestador (dirige todo el proceso)
│   ├── style.css         estética terminal
│   └── lib/
│       ├── dni.js        normalización + ceros a la izquierda
│       ├── excel.js      lector .xlsx / .csv en el navegador
│       ├── api.js        cliente de las funciones
│       └── guardar.js    escritura en carpeta y ZIP
├── api/                  funciones serverless (Node)
│   ├── _lib/nexa.js      scraping de ambas plataformas
│   ├── search.js         POST → inventario de certificados de un DNI
│   └── download.js       POST → UN PDF
├── dev-server.js         emula Vercel en local
├── vercel.json           maxDuration 60 s
└── escritorio/
    ├── descargar_certificados.py
    └── EJECUTAR.bat
```

> La app web vive en la **raíz del repo** a propósito: así Vercel detecta Vite y
> las funciones de `api/` sin tener que tocar el *Root Directory* del proyecto.

---

## Desplegar en Vercel

Importa el repo (**New Project → util_cl_rrcc**) y despliega. Deja el
**Root Directory vacío** (`./`): no hay que cambiarlo.

O desde la terminal:

```bash
npm i -g vercel
vercel --prod
```

### Variables de entorno (recomendado)

En **Settings → Environment Variables**:

| Variable | Valor |
|---|---|
| `EIN_USUARIO` | usuario de WebNexa |
| `EIN_PASSWORD` | contraseña |

Si no las defines se usan las del código. En la interfaz, el enlace
*credenciales* permite sobrescribirlas por sesión.

> La app queda pública al desplegarla. Si no quieres que cualquiera consulte
> certificados, activa
> [Vercel Authentication](https://vercel.com/docs/security/deployment-protection)
> en Settings → Deployment Protection.

---

## Desarrollo local

```bash
npm install
npm run build
node dev-server.js        # http://localhost:3000  (front + /api)
```

`dev-server.js` replica el enrutado de Vercel, así que no hace falta su CLI.
Con recarga en caliente: `vercel dev`, o `npm run dev` (Vite hace proxy de
`/api` al 3000).

## Versión de escritorio

```
escritorio\EJECUTAR.bat                                    # ventana
python escritorio\descargar_certificados.py 71481337 "D:\Certif"   # consola
```

---

## Lo que generan (ambas, igual)

```
71481337/
├── JOMISER/
│   ├── 2026-08-28_EXCAVACIONES SUBTERRÁNEAS.pdf
│   └── 2026-08-29_TRABAJOS EN ALTURA.pdf
├── EIN/
│   ├── 137518_RIESGOS CRITICOS_09-08-2026.pdf
│   └── 137197_INDUCCIÓN_15-08-2026.pdf
└── resumen.txt
```

`resumen.txt` lista todo: lo descargado, lo que no tiene certificado
(desaprobados) y los errores.

### Guardado en la web

Al pulsar **INICIAR EXTRACCIÓN** se abre primero el explorador para elegir la
carpeta. Cada PDF **se escribe en disco en cuanto llega**, no al final: en lotes
grandes no se acumula nada en memoria y lo ya descargado queda guardado aunque
abortes a mitad.

Requiere la File System Access API (Chrome/Edge de escritorio). Donde no existe
—Firefox, Safari, móvil— la app lo detecta, no pide carpeta y ofrece
**DESCARGAR ZIP** al terminar, con la misma estructura dentro.

Al acabar avisa por tres vías: aviso en la página, notificación del sistema (si
concedes el permiso) y un pitido corto.

---

## Ceros a la izquierda — por qué importa tanto

Excel guarda `07481337` como el **número** 7481337: el cero desaparece del
archivo. Como en ambas plataformas todos los documentos son de 8 dígitos, las
dos versiones rellenan a 8 y avisan del cambio valor por valor.

No es un detalle cosmético. **EIN busca por coincidencia parcial (LIKE):**

| Búsqueda en EIN | Resultado |
|---|---|
| `10350889` | los certificados de 10350889 ✓ |
| `0350889` | ⚠️ **también** los de 10350889 |
| `350889` | ⚠️ **también** los de 10350889 |

Un DNI sin su cero **no da error**: entrega en silencio los certificados de otra
persona. Por eso, además de rellenar, ambas versiones **descartan toda fila cuyo
NDocumento no sea idéntico al DNI pedido** y lo avisan.

El lector de Excel distingue si la celda venía como **texto** (ceros intactos) o
como **número** (ceros perdidos). Detecta la columna por la cabecera (`DNI`,
`DOCUMENTO`, `NDocumento`, `CÉDULA`…) y, si no hay, elige la que tenga más
valores con forma de documento. El `.xls` antiguo no se puede leer: guárdalo como
`.xlsx` o `.csv`.

---

## Particularidades del servidor EIN que el código maneja

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

## Por qué el navegador dirige y no una sola función

Las funciones de Vercel tienen dos límites que la tarea rompe de inmediato:

- **60 s de ejecución** en el plan Hobby. Descargar los certificados de un solo
  DNI ya toma más (el reporte Crystal de EIN es lento y hay reintentos).
- **4.5 MB por respuesta**. Un solo PDF de JOMISER pesa 421 KB.

Por eso cada función hace **una operación corta**:

```
navegador                       serverless                servidores
   │                                                          │
   ├── POST /api/search   ──►  login + búsqueda  ────────────►│
   │   ◄── lista de certificados                              │
   │                                                          │
   ├── POST /api/download ──►  1 certificado     ────────────►│
   │   ◄── PDF (binario)                                      │
   │   … se repite por cada certificado                       │
   │
   └── guarda en la carpeta elegida (o arma el ZIP)
```

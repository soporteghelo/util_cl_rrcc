# NEXA_CERT_EXTRACTOR — versión web (Vite + Vercel)

Extractor de certificados por DNI desde **JOMISER** (`aula.jomiser.com`) y
**EIN / WebNexa**. Acepta un DNI, una lista pegada, o un **Excel/CSV**.

```
web/
├── index.html            interfaz
├── src/
│   ├── main.js           orquestador (dirige todo el proceso)
│   ├── style.css         estética terminal
│   └── lib/
│       ├── dni.js        normalización + ceros a la izquierda
│       ├── excel.js      lector .xlsx / .csv en el navegador
│       ├── api.js        cliente de las funciones
│       └── guardar.js    ZIP y guardado en carpeta real
├── api/                  funciones serverless (Node)
│   ├── _lib/nexa.js      scraping de ambas plataformas
│   ├── search.js         POST → inventario de certificados de un DNI
│   └── download.js       POST → UN PDF
├── dev-server.js         emula Vercel en local
└── vercel.json           maxDuration 60 s
```

---

## Desplegar en Vercel

```bash
npm i -g vercel
cd web
vercel            # primera vez: crea el proyecto
vercel --prod     # publica
```

O desde el dashboard: **New Project → importar el repo → Root Directory: `web`**.
Vercel detecta Vite y `vercel.json` hace el resto.

### Variables de entorno (recomendado)

En **Settings → Environment Variables** define las credenciales para no llevarlas
en el código:

| Variable | Valor |
|---|---|
| `EIN_USUARIO` | `MROBLESV` |
| `EIN_PASSWORD` | `123456` |

Si no las defines, se usan esas mismas por defecto. En la interfaz, el enlace
*credenciales* permite sobrescribirlas por sesión.

> **Nota:** la app es pública en cuanto la despliegas. Si no quiere que cualquiera
> consulte certificados, protéjala con
> [Vercel Authentication](https://vercel.com/docs/security/deployment-protection)
> (Settings → Deployment Protection), que es un interruptor.

---

## Desarrollo local

```bash
cd web
npm install
npm run build
node dev-server.js        # http://localhost:3000  (front + /api)
```

`dev-server.js` replica el enrutado de Vercel, así que no hace falta la CLI.
Para trabajar con recarga en caliente: `vercel dev`, o `npm run dev` en otra
terminal (Vite hace proxy de `/api` al 3000).

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
   └── arma el ZIP con la estructura de carpetas y lo entrega
```

El ZIP se genera **en el navegador** (JSZip): no hay disco donde escribir en
serverless, y así el tamaño total no tiene límite práctico.

### Guardado

Al pulsar **INICIAR EXTRACCIÓN** se abre primero el explorador para elegir la
carpeta. A partir de ahí cada PDF **se escribe en disco en cuanto llega**, no al
final: en lotes grandes no se acumula nada en memoria y lo ya descargado queda
guardado aunque abortes a mitad. El `resumen.txt` de cada DNI se escribe al
terminar ese DNI.

Requiere la File System Access API (Chrome/Edge de escritorio). Donde no existe
—Firefox, Safari, móvil— la app lo detecta, no pide carpeta y ofrece
**DESCARGAR ZIP** al terminar. Ambas rutas producen la misma estructura:

```
71481337/
├── JOMISER/
│   └── 2026-08-28_EXCAVACIONES SUBTERRÁNEAS.pdf
├── EIN/
│   └── 137518_RIESGOS CRITICOS_09-08-2026.pdf
└── resumen.txt
```

### Aviso al terminar

Como un lote puede tardar varios minutos y sueles dejarlo en segundo plano, al
acabar se avisa por tres vías: un aviso en la propia página, una **notificación
del sistema** (si concedes el permiso, que se pide al iniciar sin bloquear) y un
pitido corto.

---

## Interfaz

Dos columnas a pantalla completa, sin scroll de página: entrada a la izquierda,
resultados y consola a la derecha. Cada panel se desplaza por dentro si le falta
sitio, así que nada se corta ni se derrama. Por debajo de 900 px pasa a una
columna con scroll normal.

---

## Ceros a la izquierda

Excel guarda `07481337` como el **número** 7481337 y el cero desaparece del
archivo. Como en ambas plataformas todos los documentos son de 8 dígitos, la app
rellena a 8 y **te muestra exactamente qué cambió**, valor por valor.

Esto no es cosmético. **EIN busca por coincidencia parcial (LIKE), no exacta:**

| Búsqueda | Lo que devuelve EIN |
|---|---|
| `10350889` | los certificados de 10350889 ✓ |
| `0350889` | ⚠️ **también** los de 10350889 |
| `350889` | ⚠️ **también** los de 10350889 |

Un DNI sin su cero no da error: entrega en silencio los certificados **de otra
persona**. Por eso, además de rellenar, `api/_lib/nexa.js` descarta toda fila
cuyo `NDocumento` no sea idéntico al DNI pedido, y lo avisa en la consola.

El lector de Excel distingue si la celda venía como **texto** (ceros intactos) o
como **número** (ceros perdidos) y lo informa. Detecta la columna por la cabecera
(`DNI`, `DOCUMENTO`, `NDocumento`, `CÉDULA`…) y, si no hay cabecera, elige la
columna con más valores con forma de documento.

`.xls` antiguo no se puede leer: guárdalo como `.xlsx` o `.csv`.

---

## Otras particularidades del servidor EIN

- **Devuelve el certificado de otra persona de forma intermitente** (bug de
  concurrencia del reporte Crystal; ~1 de cada 4 descargas). Cada PDF se abre, se
  extrae su texto y se comprueba que el registro `<COD><DNI>` sea el esperado; si
  no coincide, se reintenta. Si no se puede verificar, se marca `SIN VERIFICAR`
  en vez de mentir.
- **La página del reporte cambia según el curso** (`WebFormCertificad.aspx` para
  RIESGOS CRÍTICOS, `WebFormCertificad_induccion.aspx` para INDUCCIÓN). Se usa la
  URL a la que redirige el servidor, no una fija.
- **Los desaprobados no tienen certificado**: se marcan `SIN CERTIFICADO`.
- **Corta conexiones al azar**: todas las peticiones reintentan con espera
  progresiva.
- La empresa "TP" del combo EMPRESA da error 500 en el servidor; se usa siempre
  la seleccionada por defecto (NEXA MINERIA).

---

## Versión de escritorio

En la carpeta superior está `descargar_certificados.py`, la app de escritorio en
Python (tkinter, sin dependencias) que guarda directamente en una ruta elegida.
Sirve para lotes largos sin límite de tiempo.

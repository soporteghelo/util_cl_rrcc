# Extractor de Certificados — JOMISER + Drive

Descarga todos los certificados de una persona (o de una lista) desde
**JOMISER** (`aula.jomiser.com`) y, si está configurada, una **carpeta fija de
Google Drive** con un PDF por persona (`<DNI>_<APELLIDOS NOMBRES>.pdf`).
Acepta un DNI, una lista pegada o un **Excel/CSV**.

App web en Vite con funciones serverless para Vercel.

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
│   ├── _lib/nexa.js      extracción de JOMISER
│   ├── _lib/drive.js     extracción de la carpeta de Drive
│   ├── search.js         POST → certificados de un DNI (JOMISER + Drive)
│   └── download.js       POST → UN PDF (según su origen)
├── dev-server.js         emula Vercel en local
├── vercel.json           maxDuration 60 s
└── escritorio/           versión antigua en Python (incluye EIN)
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

JOMISER es una consulta pública, así que no hacen falta credenciales ni
variables de entorno. La búsqueda en Drive es **opcional**: sin configurarla
la app sigue funcionando solo con JOMISER.

### Variables de entorno (Drive, opcional)

En **Settings → Environment Variables** de Vercel:

| Variable | Valor |
|---|---|
| `DRIVE_API_KEY` | API key de Google Cloud con la Drive API habilitada |
| `DRIVE_FOLDER_ID` | ID de la carpeta pública (el segmento tras `/folders/` en su URL) |

Setup, una sola vez:

1. En [Google Cloud Console](https://console.cloud.google.com/), en un
   proyecto (nuevo o existente), habilitar **Google Drive API**.
2. Crear una **API key** (Credenciales → Crear credenciales → Clave de API),
   restringida a la Drive API. Sin restricción de referrer/IP: la llamada
   sale desde las funciones de Vercel con IP variable.
3. La carpeta de Drive con los certificados debe estar compartida como
   **"Cualquiera con el enlace — Lector"**.
4. Copiar el ID de la carpeta desde su URL
   (`drive.google.com/drive/folders/`**`ESTE_ID`**) y cargar ambas variables
   en Vercel.

> La app queda pública al desplegarla. Si no quieres que cualquiera consulte
> certificados, activa
> [Vercel Authentication](https://vercel.com/docs/security/deployment-protection)
> en Settings → Deployment Protection.

## Desarrollo local

```bash
npm install
npm run build
node dev-server.js        # http://localhost:3000  (front + /api)
```

`dev-server.js` replica el enrutado de Vercel, así que no hace falta su CLI.
Con recarga en caliente: `vercel dev`, o `npm run dev` (Vite hace proxy de
`/api` al 3000).

---

## Salida

### ZIP

Solo los certificados, sueltos en la raíz. Sin subcarpetas y sin resumen. El ZIP
se llama como el participante en JOMISER, más su documento:

```
MEZA SUAZO, LUIS ANGEL_71481337.zip
├── 2026-08-28_EXCAVACIONES SUBTERRÁNEAS.pdf
├── 2026-08-29_TRABAJOS EN ALTURA.pdf
├── 2026-08-29_HERRAMIENTAS DE PODER.pdf
└── 2026-08-30_SUSTANCIAS QUÍMICAS PELIGROSAS.pdf
```

Si JOMISER no devolvió nombre, el ZIP se llama `certificados_<DNI>.zip`.

Con **varios DNI** no hay un único participante, así que el ZIP se llama
`certificados_<N>_dni_<fecha>.zip` y cada archivo lleva el documento delante
(`71481337_2026-08-28_EXCAVACIONES SUBTERRÁNEAS.pdf`), porque al ir todos
sueltos dos personas podrían coincidir en curso y fecha y no sabrías de quién es
cada archivo.

### Carpeta del equipo

Al pulsar **INICIAR EXTRACCIÓN** se abre primero el explorador para elegir la
carpeta. Cada PDF **se escribe en disco en cuanto llega**, no al final: en lotes
grandes no se acumula nada en memoria y lo ya descargado queda guardado aunque
abortes a mitad. Se crea una subcarpeta por DNI para que un lote de muchas
personas no acabe como cientos de archivos sueltos:

```
<carpeta elegida>/
└── 71481337/
    ├── 2026-08-28_EXCAVACIONES SUBTERRÁNEAS.pdf
    └── 2026-08-29_TRABAJOS EN ALTURA.pdf
```

Requiere la File System Access API (Chrome/Edge de escritorio). Donde no existe
—Firefox, Safari, móvil— la app lo detecta, no pide carpeta y ofrece el ZIP.

### Aviso al terminar

Como un lote puede tardar varios minutos y sueles dejarlo en segundo plano, al
acabar se avisa por tres vías: un aviso en la propia página, una notificación
del sistema (si concedes el permiso, que se pide al iniciar sin bloquear) y un
pitido corto.

---

## Ceros a la izquierda

Excel guarda `07481337` como el **número** 7481337: el cero desaparece del
archivo. Como todos los documentos son de 8 dígitos, la app rellena a 8 y **te
muestra exactamente qué cambió**, valor por valor:

```
cero restaurado: 7481337 → 07481337
cero restaurado: 350889  → 00350889
```

El lector de Excel distingue si la celda venía como **texto** (ceros intactos) o
como **número** (ceros perdidos) y lo informa. Detecta la columna por la cabecera
(`DNI`, `DOCUMENTO`, `NDocumento`, `CÉDULA`…) y, si no hay, elige la que tenga
más valores con forma de documento. El `.xls` antiguo no se puede leer: guárdalo
como `.xlsx` o `.csv`.

---

## Detalles de JOMISER

- Es una consulta pública: `GET /certificados?dni=<DNI>` devuelve la tabla, y
  cada fila aprobada trae un enlace `/pdf/exportar-certificado/<id>`.
- **Busca por coincidencia exacta**, así que un DNI mal escrito no devuelve a
  otra persona. Aun así se comprueba que el `COD. IDENTIDAD` de la respuesta sea
  el DNI pedido.
- **Los desaprobados no tienen certificado**: se marcan `SIN CERTIFICADO`, no
  como error.

## Detalles de Drive

- Busca con la **Drive API oficial** (`files.list` + API key) en vez de
  raspar la página pública de la carpeta: esa página solo trae los primeros
  50 archivos, y con más de 50 certificados un DNI "tardío" daría un falso
  `SIN CERTIFICADO` aunque el archivo exista. La API filtra del lado de
  Google, así que el tamaño de la carpeta no importa.
- La búsqueda por nombre de Drive (`contains`) es por **subcadena, no por
  prefijo**: un DNI corto podría matchear como parte de uno más largo (mismo
  problema de coincidencia parcial que EIN, ver más abajo). Por eso el
  código descarta cualquier resultado cuyo nombre no **arranque exacto** con
  el DNI buscado.
- Si no hay archivo para el DNI se marca `SIN CERTIFICADO` (no error) y
  queda un aviso en el log de la corrida.
- Descargar el PDF no necesita la API key: alcanza con que el archivo sea
  público (`drive.google.com/uc?export=download&id=<id>`).

---

## Por qué el navegador dirige y no una sola función

Las funciones de Vercel tienen dos límites que la tarea rompe de inmediato:

- **60 s de ejecución** en el plan Hobby.
- **4.5 MB por respuesta**. Un solo PDF de JOMISER pesa 421 KB.

Por eso cada función hace **una operación corta**:

```
navegador                       serverless              JOMISER / Drive
   │                                                          │
   ├── POST /api/search   ──►  consulta por DNI  ────────────►│
   │   ◄── lista de certificados (con su origen)               │
   │                                                          │
   ├── POST /api/download ──►  1 certificado     ────────────►│
   │   ◄── PDF (binario)                                      │
   │   … se repite por cada certificado                       │
   │
   └── guarda en la carpeta elegida (o arma el ZIP)
```

---

## Versión de escritorio (`escritorio/`)

App en Python + tkinter, sin dependencias. **Sigue descargando de JOMISER y de
EIN/WebNexa**, y guarda con la estructura antigua (`<DNI>/JOMISER/`,
`<DNI>/EIN/` y `resumen.txt`).

```
escritorio\EJECUTAR.bat                                          # ventana
python escritorio\descargar_certificados.py 71481337 "D:\Certif" # consola
```

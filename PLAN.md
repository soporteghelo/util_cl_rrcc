# Plan de Implementación — Automatización de Autorización de RRCC (AESA / Cerro Lindo)

> Documento de arquitectura y plan de trabajo. Se construye **extendiendo el repo
> `util_cl_rrcc`** (Vite + funciones serverless en Vercel), reutilizando el
> extractor de certificados JOMISER / EIN / Drive ya existente.
> Fuente de datos en línea: **Google Sheets** (datos) + **Google Drive** (fotos y salidas).
> Objetivo: que renovar la Autorización de Riesgos Críticos de una persona sea
> cuestión de **unos clics**.

---

## 1. Objetivo y alcance

**Problema actual.** Actualizar la Autorización de RRCC (Riesgos Críticos por puesto)
del personal es manual: hoy vive en `_1. BASE DE RIESGOS CRITICOS AESA VERSION 1.xlsx`
(~300 MB, 586 fotos incrustadas, pestañas `BD AESA` y `FOTOCHEK`). Por cada persona
hay que buscar sus certificados, copiar fechas, recalcular vigencias, decidir a qué
cursos va "A" (Autorizado), actualizar el fotocheck y armar una carpeta con sus certificados.

**Meta.** Una App web que, para una o varias personas (por DNI):

1. Jala automáticamente los certificados (JOMISER + EIN + Drive) — **ya resuelto** por `util_cl_rrcc`.
2. Rellena fechas de capacitación y vencimiento y calcula el **ESTADO** de cada RRCC.
3. Asigna **"A"** según la regla de negocio (renovación por fila / matriz para personal nuevo).
4. Genera el **fotocheck** actualizado.
5. Entrega por persona una **carpeta en Google Drive** (nombre = la persona) con:
   - sus certificados **vigentes** (vigencia 1 año), y
   - un **Word** con la imagen del fotocheck nuevo (8 cm alto × 10 cm ancho) y debajo la foto del fotocheck antiguo.
6. Permite **dar de alta personal nuevo** desde la App (datos completos, EMO, restricciones, foto, matriz por puesto).

**Dos flujos de usuario:**
- **Renovación** (personal existente): automático de punta a punta.
- **Nuevo personal**: la App pide los inputs que exige el Excel + una **matriz por puesto de trabajo** que define qué cursos debe llevar y marcar como "A".

---

## 2. Lo que YA existe (no reconstruir)

`util_cl_rrcc` (repo actual) — Vite + serverless en Vercel:

| Pieza | Qué hace | Reuso |
|---|---|---|
| `api/search.js` | `POST {dni}` → inventario de certificados de las 3 fuentes | **Núcleo del motor de renovación** |
| `api/download.js` | `POST {id, origen,...}` → 1 PDF | Descarga de certs para las carpetas |
| `api/_lib/nexa.js` | JOMISER (público, `aula.jomiser.com`) | tal cual |
| `api/_lib/ein.js` | EIN / WebNexa (login ASP.NET + Crystal) | tal cual (fechas de ES y HM salen de aquí) |
| `api/_lib/drive.js` | Carpeta Drive por API key | base para la lectura; se ampliará a escritura |
| `src/lib/*` | dni, excel, api, guardar (ZIP en navegador) | referencia |

**Forma de la respuesta de `/api/search`** (clave para todo el diseño):

```json
{
  "dni": "71871839",
  "participante": "MIGUEL ROJAS, EDUARDO",
  "items": [
    { "id": "...", "curso": "EXCAVACIONES SUBTERRÁNEAS", "fecha": "2026-08-28",
      "origen": "EIN", "estado": "PENDIENTE", "descargable": true, "datosDescarga": {...} },
    { "id": "...", "curso": "TRABAJOS EN ALTURA", "fecha": "2026-08-29",
      "origen": "JOMISER", "estado": "APROBADO", "descargable": true }
  ],
  "avisos": []
}
```

Cada `item` trae **curso + fecha + origen**. Eso es lo único que necesita el motor de estados.

**Limitaciones heredadas a respetar:** función serverless en Hobby = **60 s** y **4.5 MB** por respuesta;
por eso el navegador orquesta (una llamada corta por operación) y arma el ZIP. El nuevo motor sigue el mismo patrón.

---

## 3. Modelo de datos en Google Sheets

Un único Spreadsheet **`RRCC AESA — BD`** con estas hojas:

### 3.1 `PERSONAL` (espejo liviano de `BD AESA`)
Una fila por persona. Se elimina la foto incrustada; en su lugar una columna con el **ID/URL de Drive**.

Columnas de datos (según el Excel):
`Codigo` (AE001…), `Apellidos`, `Nombres`, `DNI`, `EMPRESA`, `Guardia`,
`Cargo Planilla`, `Area Planilla`, `COMENTARIO`, `F. Ex. Médico`, `F. Vencimiento EMO`,
`USO DE LENTES`, `FOTO_DRIVE_ID`, `FOTOCHECK_ANTIGUO_DRIVE_ID`, `ESTADO_FINAL`.

Luego, por cada uno de los **20 riesgos críticos**, 4 columnas
(`Fecha capacitacion`, `Fecha vencimiento`, `TIPO` A|C, `ESTADO`):

| Código | Riesgo crítico | Fuente de fecha de vencimiento |
|---|---|---|
| AE | Bloqueo y Aislamiento de Energías | capacitación + 365 |
| IE | Instalaciones Eléctricas | cap + 365 |
| SQ | Sustancias Químicas Peligrosas | cap + 365 |
| PM | Protección de Máquinas | cap + 365 |
| TA | Trabajo en Altura | cap + 365 |
| CS | Cargas Suspendidas | cap + 365 |
| SP | Sistemas Presurizados | cap + 365 |
| **ES** | **Excavaciones Subterráneas** | **fecha del certificado EIN** |
| **HM** | **Herramientas Manuales** | **fecha del certificado EIN** |
| OC | Excavación en Obras Civiles | cap + 365 |
| EC | Espacios Confinados | cap + 365 |
| VEM | Vehículos y Equipos Móviles | cap + 365 |
| AP | Animales Ponzoñosos | cap + 365 |
| HP | Herramientas de Poder | cap + 365 |
| TC | Trabajos en Caliente | cap + 365 |
| OB | Oficial de Bloqueo | cap + 365 |
| MD | Montaje y Desmontaje | cap + 365 |
| RIG | Rigger | cap + 365 |

> Las columnas y su orden se conservan idénticas a `BD AESA` para migración 1:1
> y para que la hoja `FOTOCHECK` siga funcionando por `BUSCARV`/código.

### 3.2 `CURSO_RRCC` (diccionario curso → riesgo crítico)
El nombre de curso que devuelve JOMISER/EIN no siempre es idéntico al rótulo del RRCC.
Tabla de mapeo mantenible sin tocar código:

| nombre_certificado (como llega) | codigo_rrcc | fuente_preferida |
|---|---|---|
| EXCAVACIONES SUBTERRÁNEAS | ES | EIN |
| HERRAMIENTAS MANUALES | HM | EIN |
| TRABAJO EN ALTURA / TRABAJOS EN ALTURA | TA | JOMISER |
| SUSTANCIAS QUÍMICAS PELIGROSAS | SQ | JOMISER |
| … | … | … |

Matching por **normalización** (mayúsculas, sin tildes, sinónimos) + esta tabla de alias.
Todo curso sin match queda en un log "curso no mapeado" para revisión.

### 3.3 `MATRIZ_PUESTO` (solo personal nuevo)
Qué RRCC exige cada puesto. Fila = `Cargo` / `Area`; columnas = los 20 códigos con `A`, `C` o vacío.
La renovación **no** usa esta matriz (usa las "A" que la persona ya tiene); el alta de personal nuevo **sí**.

### 3.4 `CONFIG`
Parámetros: umbrales de estado (330/365 días), plantilla de nombre de carpeta,
ID de la carpeta raíz de salidas en Drive, ID de la carpeta de fotos, etc.

---

## 4. Reglas de negocio (núcleo)

### 4.1 Cálculo de ESTADO por RRCC (idéntico al Excel actual)
Con `cap` = fecha de capacitación:
- `cap` vacía → **NO APLICA**
- `HOY − cap > 365` → **VENCIDO**
- `HOY − cap ≥ 330` → **ACTUALIZAR** (por renovar pronto)
- resto → **VIGENTE**

`ESTADO_FINAL` = VIGENTE si el mínimo de vigencias aplicables no está vencido; si no, VENCIDO.
(Equivale a `MIN(vencimientos)` + `IF(dias>0,"VIGENTE","VENCIDO")` del Excel.)

### 4.2 Fecha de vencimiento
- Regla general: **vencimiento = capacitación + 365** (todos con vigencia de 1 año).
- **Excepción ES y HM:** la fecha de vencimiento se toma del **certificado EIN** (no cap+365),
  porque su emisor define la vigencia. El motor usa la fecha que `ein.js` devuelve para esos dos cursos.

### 4.3 Asignación de "A" (Autorizado) — **regla central pedida**
- **Renovación (por fila):** los cursos que la persona **debe** tener son exactamente
  aquellos en los que **ya figura "A"** en su fila. No se consulta matriz externa por puesto.
  El motor, al renovar, mantiene "A" en esos RRCC y actualiza su fecha con el certificado nuevo.
  Si un RRCC con "A" no tiene certificado vigente nuevo → queda en **ACTUALIZAR/VENCIDO** (alerta).
- **Personal nuevo:** como no hay fila previa con "A", se usa `MATRIZ_PUESTO` según Cargo/Área
  para decidir qué RRCC van "A".
- `TIPO`: **A = AUTORIZADO**, **C = CAPACITADO** (se refleja en el fotocheck).

### 4.4 Fotocheck (hoja `FOTOCHECK`)
Réplica del layout actual (BUSCARV por `Codigo`): foto, DNI, Apellidos/Nombres, Área, Cargo,
F. Ex. Médico, F. Vencimiento, Uso de Lentes, y la grilla de los 20 RRCC con su fecha de
vencimiento y letra (A/C). "AUTORIZADO" / "NO AUTORIZADO" según corresponda.

---

## 5. Motor de renovación (flujo detallado)

Para cada DNI de entrada:

1. **Leer fila** de `PERSONAL` (datos + qué RRCC tienen "A" hoy). Si no existe → derivar a flujo "nuevo".
2. **`POST /api/search`** → inventario de certificados (JOMISER + EIN + Drive).
3. **Mapear** cada certificado a su `codigo_rrcc` vía `CURSO_RRCC` (normalización + alias).
   Para cada RRCC, quedarse con el certificado **más reciente**.
4. **Actualizar fechas** por RRCC:
   - `Fecha capacitacion` = fecha del certificado.
   - `Fecha vencimiento` = cap + 365 (general) **o** fecha EIN (ES, HM).
   - Recalcular `ESTADO`.
5. **Aplicar regla "A"**: conservar "A" en los RRCC donde ya la tenía; si ese RRCC no obtuvo
   certificado nuevo, marcar alerta (no se pierde el "A", pero se resalta el vencimiento).
6. **Escribir** la fila de vuelta en `PERSONAL` (Sheets API, batch update).
7. **Generar salidas** (sección 6).
8. **Resumen** en pantalla: por persona, RRCC actualizados, alertas (cursos "A" sin cert vigente,
   cursos no mapeados, avisos EIN/Drive).

Orquestación en el navegador (igual que hoy): una llamada corta por operación para respetar los 60 s.
Lote de varias personas = cola con barra de progreso y aviso al terminar (ya implementado en el front actual).

---

## 6. Salidas por persona (Google Drive)

Carpeta raíz de salidas (en `CONFIG`). Por persona se crea/actualiza una subcarpeta
**cuyo nombre es la persona** (`APELLIDOS NOMBRES` o `<DNI> - APELLIDOS NOMBRES`, definible en `CONFIG`):

```
/Salidas RRCC/
└── MIGUEL ROJAS EDUARDO/
    ├── 2026-08-28_EXCAVACIONES SUBTERRÁNEAS.pdf     (solo vigentes)
    ├── 2026-08-29_TRABAJOS EN ALTURA.pdf
    ├── ...
    └── Autorizacion_RRCC_MIGUEL ROJAS EDUARDO.docx
```

- **Certificados vigentes**: se descargan vía `/api/download` los certs cuyo RRCC quedó **VIGENTE**
  (vigencia de 1 año) y se suben a la subcarpeta.
- **Word** `Autorizacion_RRCC_<persona>.docx`:
  - Arriba: **imagen del fotocheck nuevo**, tamaño **8 cm de alto × 10 cm de ancho**.
  - Debajo: **foto del fotocheck antiguo** (input que sube el usuario / `FOTOCHECK_ANTIGUO_DRIVE_ID`).
- Todo se escribe en Drive (nada queda solo en el navegador).

**Cómo se obtiene "la imagen del fotocheck nuevo":** se renderiza el fotocheck como HTML
(plantilla que replica la hoja `FOTOCHECK`) → PNG. Opciones técnicas en sección 8.

---

## 7. Alta de personal nuevo

Formulario en la App que pide lo que exige el Excel:
- Datos: Apellidos, Nombres, DNI, Empresa, Guardia, Cargo, Área, Comentario.
- **EMO**: F. Ex. Médico, F. Vencimiento, restricciones, **Uso de Lentes**.
- **Foto** de la persona (se sube a Drive; el Sheet guarda su ID/URL).
- **Foto del fotocheck antiguo** si aplica.
- **Matriz por puesto**: la App carga de `MATRIZ_PUESTO` los RRCC del Cargo/Área elegido y
  propone las "A"; el usuario confirma/ajusta.
Luego corre el mismo motor (secciones 5–6) para llenar fechas/estados desde certificados y generar salidas.
Se **inserta** la nueva fila en `PERSONAL` con su `Codigo` correlativo (AE###).

---

## 8. Componentes técnicos nuevos (dentro de `util_cl_rrcc`)

### Backend (nuevas funciones `api/`)
- `api/sheets.js` — leer/escribir `PERSONAL`, `CURSO_RRCC`, `MATRIZ_PUESTO`, `CONFIG` (Google Sheets API).
- `api/_lib/sheets.js` — cliente Sheets con **service account** (JWT); helpers batchGet/batchUpdate.
- `api/_lib/estados.js` — reglas de negocio puras (mapeo curso→RRCC, cap+365 vs EIN, ESTADO, regla "A"). **Testeable.**
- `api/drive-output.js` — crear subcarpeta por persona, subir PDFs y el DOCX (Drive API, service account con permiso de escritura).
- `api/_lib/drive.js` — ampliar de solo-lectura (API key) a **escritura** (service account).
- `api/docx.js` (o generación en cliente) — arma el Word con las dos imágenes y tamaños exactos.
- `api/foto-upload.js` — subir foto de persona / fotocheck antiguo a Drive.

### Frontend (nuevas vistas)
- **Renovación**: input de DNI(s) o carga de Excel/lista → tabla de resultados por persona (RRCC, estados, alertas) → botón "Generar salidas".
- **Nuevo personal**: formulario + selector de matriz por puesto.
- **Fotocheck**: previsualización/plantilla HTML para exportar a PNG.
- Reutilizar el motor de progreso/cola/avisos actual.

### Generación del DOCX y del PNG del fotocheck
Elegir en el arranque (decisión abierta, sección 11):
- **A (recomendada):** `docx` (npm) para el Word y renderizado del fotocheck HTML→PNG con una
  librería headless. Como Vercel serverless no trae Chromium, el render del PNG puede hacerse:
  (i) en el navegador con `html-to-image`/`canvas` (sin headless en el server), o
  (ii) en una función con `@sparticuz/chromium` + `puppeteer-core`.
- **B:** plantilla `.dotx` de Word + reemplazo de imágenes (skill docx), si se prefiere fidelidad al formato oficial.

### Integración Google (setup único)
- Crear **Service Account** en Google Cloud; habilitar **Sheets API** y **Drive API**.
- Compartir el Spreadsheet y la carpeta raíz de salidas **con el email del service account** (editor).
- Variables de entorno nuevas en Vercel:
  `GOOGLE_SA_EMAIL`, `GOOGLE_SA_PRIVATE_KEY`, `SHEET_ID`, `DRIVE_OUTPUT_FOLDER_ID`, `DRIVE_FOTOS_FOLDER_ID`.
- Se conservan las existentes: `EIN_USUARIO`, `EIN_PASSWORD`, `DRIVE_API_KEY`, `DRIVE_FOLDER_ID`.

---

## 9. Migración inicial del Excel → Sheets (una sola vez)

Script de migración (Node/Python, corre local, no en Vercel):
1. Leer `BD AESA` del `.xlsx` (openpyxl / exceljs) → volcar filas a la hoja `PERSONAL`.
2. Extraer las **586 fotos incrustadas** (`xl/media/*`), mapear cada imagen a su fila
   (por el anclaje de dibujo `xl/drawings`), subirlas a la carpeta Drive de fotos y
   guardar el `FOTO_DRIVE_ID` en cada fila.
3. Sembrar `CURSO_RRCC` con los 20 RRCC y sus alias conocidos.
4. Sembrar `MATRIZ_PUESTO` desde la matriz por puesto (input a pedir).
5. Validar: conteo de filas, DNIs con ceros a la izquierda (ya resuelto por `dni.js`), fotos sin match.

> El `.xlsx` original queda como respaldo; la fuente de verdad pasa a ser el Sheet.

---

## 10. Fases y entregables

| Fase | Entregable | Resultado |
|---|---|---|
| **0. Setup** | Service account, APIs Google, Spreadsheet vacío con hojas, env vars | Base lista |
| **1. Migración** | Script `.xlsx → PERSONAL` + fotos a Drive | Datos en línea |
| **2. Motor (MVP)** | `estados.js` + `sheets.js` + vista Renovación (1 DNI) | Estados y "A" automáticos, escritos al Sheet |
| **3. Salidas** | `drive-output.js` + DOCX + PNG fotocheck | Carpeta por persona con certs vigentes + Word |
| **4. Lote** | Cola multi-DNI + Excel/lista + resumen y alertas | Renovación masiva en un clic |
| **5. Nuevo personal** | Formulario + `MATRIZ_PUESTO` | Alta completa desde la App |
| **6. Fotocheck online** | Hoja/planilla FOTOCHECK replicada + export | Impresión directa |
| **7. Robustez** | Tests de `estados.js`, manejo de errores EIN/Drive, log de no mapeados | Confiable |

Este documento cubre hasta la fase **6/7**; se implementa por fases (MVP = fases 0–3).

---

## 11. Riesgos y decisiones abiertas

1. **Fotos: Sheet vs Drive.** Definido: **binario en Drive, referencia (ID/URL) en el Sheet** —
   así el Sheet queda liviano y se cumple "las fotos se guardan asociadas al registro".
2. **Render del fotocheck a PNG** en serverless (no hay Chromium por defecto): elegir
   navegador (`html-to-image`) vs `@sparticuz/chromium`. Recomendado empezar en navegador.
3. **EIN**: límite de 60 s y bug de concurrencia de Crystal (~1/4 devuelve PDF de otra persona,
   ya mitigado con verificación de `<COD><DNI>` y reintentos). En lote, encolar EIN con cuidado.
4. **Nombres de curso** heterogéneos entre JOMISER y EIN: el diccionario `CURSO_RRCC` es la pieza
   a mantener; todo no mapeado se reporta, nunca se asume.
5. **Seguridad**: la app hoy queda pública al desplegar. Con datos de personal conviene activar
   **Vercel Deployment Protection** o un login simple.
6. **Autorización "A" sin certificado vigente**: decidir si se degrada a "C", se mantiene "A"
   con alerta, o se bloquea. Propuesto: mantener y **alertar** (no perder autorizaciones por un cert atrasado).
7. **Matriz por puesto**: falta el archivo real de la matriz para sembrar `MATRIZ_PUESTO` (input pendiente del usuario).

---

## 12. Setup técnico (checklist para el arranque)

- [ ] Google Cloud: proyecto + habilitar **Sheets API** y **Drive API**.
- [ ] Crear **Service Account** + clave JSON. Guardar `client_email` y `private_key`.
- [ ] Crear Spreadsheet `RRCC AESA — BD` con hojas `PERSONAL`, `CURSO_RRCC`, `MATRIZ_PUESTO`, `CONFIG`.
- [ ] Compartir Spreadsheet + carpeta de salidas + carpeta de fotos con el email del service account (**Editor**).
- [ ] Cargar env vars en Vercel (sección 8).
- [ ] Correr script de migración (fase 1) y validar conteos.
- [ ] Proveer: **matriz por puesto** y una **foto de fotocheck antiguo** de ejemplo.

---

## 13. Inputs pendientes del usuario

1. **Matriz por puesto de trabajo** (Excel/lista Cargo→RRCC) para `MATRIZ_PUESTO`.
2. Confirmar el **nombre exacto de la carpeta por persona** (`APELLIDOS NOMBRES` vs `DNI - ...`).
3. Confirmar **tamaños del Word**: fotocheck nuevo 8 cm alto × 10 cm ancho; ¿tamaño de la foto del fotocheck antiguo?
4. Ejemplos de **nombres de curso** tal como llegan de JOMISER y EIN para completar el diccionario.
5. Decisión sobre la regla del punto 11.6 (A sin cert vigente).

---

*Generado como base de implementación. La ejecución se hará por fases en VS Code sobre el repo `util_cl_rrcc`.*

# -*- coding: utf-8 -*-
"""
DESCARGADOR DE CERTIFICADOS  (JOMISER + EIN / WebNexa)
=======================================================

Ingresa un DNI y descarga TODOS los certificados disponibles de las dos fuentes:

  1) JOMISER  -> https://aula.jomiser.com/certificados
  2) EIN      -> http://44.193.188.247/WebNexa  (Certificados > Cert. x Persona)

Estructura que genera en la carpeta destino elegida:

    <destino>/
        <DNI>/
            JOMISER/   *.pdf
            EIN/       *.pdf
            resumen.txt

Requisitos: solo Python 3.8+ (usa unicamente la libreria estandar).
Ejecutar:   python descargar_certificados.py     o    doble clic en EJECUTAR.bat
"""

import os
import re
import sys
import ssl
import time
import zlib
import queue
import html
import json
import threading
import unicodedata
import http.cookiejar
import urllib.parse
import urllib.request
import urllib.error

import tkinter as tk
from tkinter import ttk, filedialog, messagebox


# ---------------------------------------------------------------------------
# CONFIGURACION
# ---------------------------------------------------------------------------

# Nombres de las subcarpetas por origen (cambialos aqui si los necesitas distintos)
CARPETA_JOMISER = "JOMISER"
CARPETA_EIN = "EIN"

JOMISER_URL = "https://aula.jomiser.com/certificados"

EIN_BASE = "http://44.193.188.247/WebNexa"
EIN_LOGIN = EIN_BASE + "/serviceit/Login_g.aspx"
EIN_GRID = EIN_BASE + "/serviceit/WebFormContraCerti.aspx"
EIN_USUARIO = "MROBLESV"
EIN_PASSWORD = "123456"

# El servidor EIN a veces devuelve el certificado de OTRA persona (bug de
# concurrencia del reporte Crystal). Cada PDF se valida y se reintenta.
EIN_INTENTOS_VALIDACION = 4

USER_AGENT = "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/125 Safari/537.36"

CONFIG_PATH = os.path.join(os.path.expanduser("~"), ".certificados_nexa.json")


# ---------------------------------------------------------------------------
# UTILIDADES
# ---------------------------------------------------------------------------

class Cancelado(Exception):
    """Se lanza cuando el usuario cancela la descarga."""


LARGO_DNI = 8


def normalizar_dni(valor, largo=LARGO_DNI):
    """
    Devuelve (dni, relleno) o (None, 0).

    Excel guarda 07481337 como el numero 7481337 y pierde el cero. Como en las
    dos plataformas todos los documentos son de 8 digitos, se rellena a 8.
    Importa porque EIN busca por coincidencia PARCIAL: un DNI sin su cero no
    falla, devuelve los certificados de OTRA persona.
    """
    if valor is None:
        return None, 0
    bruto = str(valor).strip()
    if not bruto:
        return None, 0
    if re.fullmatch(r"\d+\.0+", bruto):          # "71481337.0"
        bruto = bruto.split(".")[0]
    digitos = re.sub(r"\D", "", bruto)
    if not digitos:
        return None, 0
    if len(digitos) < largo:
        return digitos.rjust(largo, "0"), largo - len(digitos)
    return digitos, 0


def limpiar_nombre(texto, maximo=90):
    """Convierte un texto en un nombre de archivo valido para Windows."""
    texto = html.unescape(texto or "")
    texto = unicodedata.normalize("NFC", texto)
    texto = re.sub(r"[\\/:*?\"<>|\r\n\t]+", " ", texto)
    texto = re.sub(r"\s+", " ", texto).strip(" .")
    return (texto[:maximo].strip() or "SIN_NOMBRE")


def quitar_tags(fragmento):
    """Extrae el texto plano de un fragmento de HTML."""
    texto = re.sub(r"<[^>]+>", " ", fragmento or "")
    return re.sub(r"\s+", " ", html.unescape(texto)).strip()


def texto_de_pdf(datos):
    """Extrae el texto visible de un PDF (streams Flate). Devuelve bytes."""
    partes = []
    for m in re.finditer(rb"stream\r?\n(.*?)endstream", datos, re.S):
        try:
            partes.append(zlib.decompress(m.group(1)))
        except Exception:
            pass
    return b" ".join(partes)


def nombre_unico(carpeta, nombre):
    """Evita sobrescribir: agrega (2), (3)... si el archivo ya existe."""
    base, ext = os.path.splitext(nombre)
    destino = os.path.join(carpeta, nombre)
    n = 2
    while os.path.exists(destino):
        destino = os.path.join(carpeta, "%s (%d)%s" % (base, n, ext))
        n += 1
    return destino


class Sesion:
    """Cliente HTTP con cookies y reintentos automaticos."""

    def __init__(self, verificar_ssl=True):
        ctx = None if verificar_ssl else ssl._create_unverified_context()
        self.cj = http.cookiejar.CookieJar()
        handlers = [urllib.request.HTTPCookieProcessor(self.cj)]
        if ctx is not None:
            handlers.append(urllib.request.HTTPSHandler(context=ctx))
        self.opener = urllib.request.build_opener(*handlers)

    def _abrir(self, req, timeout, intentos, cancelado=None):
        ultimo = None
        for intento in range(intentos):
            if cancelado and cancelado():
                raise Cancelado()
            try:
                r = self.opener.open(req, timeout=timeout)
                return r, r.read()
            except Exception as e:
                ultimo = e
                if intento < intentos - 1:
                    time.sleep(2 + intento * 3)
        raise ultimo

    def get(self, url, timeout=90, intentos=4, cancelado=None):
        req = urllib.request.Request(url, headers={
            "User-Agent": USER_AGENT,
            "Accept": "text/html,application/xhtml+xml,*/*",
            "Accept-Language": "es-ES,es;q=0.9",
        })
        return self._abrir(req, timeout, intentos, cancelado)

    def post(self, url, datos, timeout=180, intentos=4, referer=None, cancelado=None):
        cuerpo = urllib.parse.urlencode(datos, encoding="utf-8").encode("utf-8")
        req = urllib.request.Request(url, data=cuerpo, headers={
            "User-Agent": USER_AGENT,
            "Content-Type": "application/x-www-form-urlencoded",
            "Accept": "text/html,application/xhtml+xml,*/*",
            "Accept-Language": "es-ES,es;q=0.9",
            "Referer": referer or url,
        })
        return self._abrir(req, timeout, intentos, cancelado)


def campos_ocultos(pagina_html):
    """Devuelve todos los <input type=hidden> de una pagina ASP.NET."""
    campos = {}
    for tag in re.findall(r"<input[^>]*type=\"hidden\"[^>]*>", pagina_html, re.I):
        nombre = re.search(r'name="([^"]+)"', tag)
        valor = re.search(r'value="([^"]*)"', tag)
        if nombre:
            campos[html.unescape(nombre.group(1))] = html.unescape(valor.group(1)) if valor else ""
    return campos


# ---------------------------------------------------------------------------
# FUENTE 1: JOMISER
# ---------------------------------------------------------------------------

class ClienteJomiser:
    """https://aula.jomiser.com/certificados  -  consulta publica por DNI."""

    def __init__(self, log, cancelado):
        self.s = Sesion()
        self.log = log
        self.cancelado = cancelado

    def buscar(self, dni):
        """Devuelve (nombre_participante, [registros])."""
        url = "%s?dni=%s" % (JOMISER_URL, urllib.parse.quote(dni))
        _, cuerpo = self.s.get(url, cancelado=self.cancelado)
        pagina = cuerpo.decode("utf-8", "replace")

        m = re.search(r"PARTICIPANTE:\s*</label>\s*<span>(.*?)</span>", pagina, re.S | re.I)
        participante = quitar_tags(m.group(1)) if m else ""

        registros = []
        tabla = re.search(r"<table[^>]*id=\"example-table\".*?</table>", pagina, re.S | re.I)
        if not tabla:
            return participante, registros

        cuerpo_tabla = re.search(r"<tbody[^>]*>(.*?)</tbody>", tabla.group(0), re.S | re.I)
        filas = re.findall(r"<tr[^>]*>(.*?)</tr>", cuerpo_tabla.group(1) if cuerpo_tabla else tabla.group(0), re.S | re.I)

        for fila in filas:
            celdas = re.findall(r"<td[^>]*>(.*?)</td>", fila, re.S | re.I)
            if len(celdas) < 4:
                continue
            empresa, curso, fecha, accion = (quitar_tags(celdas[0]), quitar_tags(celdas[1]),
                                             quitar_tags(celdas[2]), celdas[3])
            enlace = re.search(r'href="([^"]*exportar-certificado/\d+)"', accion, re.I)
            registros.append({
                "empresa": empresa,
                "curso": curso,
                "fecha": fecha,
                "url": html.unescape(enlace.group(1)) if enlace else None,
                "estado": quitar_tags(accion) or "SIN CERTIFICADO",
            })
        return participante, registros

    def descargar(self, registro):
        """Descarga el PDF de un registro. Devuelve bytes."""
        r, datos = self.s.get(registro["url"], timeout=180, cancelado=self.cancelado)
        if datos[:4] != b"%PDF":
            raise RuntimeError("la respuesta no es un PDF (%s)" % r.headers.get("Content-Type"))
        return datos


# ---------------------------------------------------------------------------
# FUENTE 2: EIN / WebNexa  (ASP.NET WebForms + SAP Crystal Reports)
# ---------------------------------------------------------------------------

class ClienteEin:
    """Login, busqueda por DNI en 'Cert. x Persona' y exportacion a PDF."""

    PREFIJO_GRID = "ctl00$ContentPlaceHolder1$"

    def __init__(self, log, cancelado, usuario=EIN_USUARIO, password=EIN_PASSWORD):
        self.s = Sesion()
        self.log = log
        self.cancelado = cancelado
        self.usuario = usuario
        self.password = password
        self.empresa = "2"  # valor por defecto (NEXA MINERIA); se lee de la pagina
        self.descartadas = 0  # filas de otro documento que devolvio la busqueda

    # -- login ---------------------------------------------------------------
    def login(self):
        _, cuerpo = self.s.get(EIN_LOGIN, cancelado=self.cancelado)
        campos = campos_ocultos(cuerpo.decode("utf-8", "replace"))
        campos.update({
            "txtusuario": self.usuario,
            "txtpass": self.password,
            "btnlogg": "Ingresar",
        })
        r, cuerpo = self.s.post(EIN_LOGIN, campos, cancelado=self.cancelado)
        pagina = cuerpo.decode("utf-8", "replace")
        if "Login_g.aspx" in r.url or "txtusuario" in pagina:
            raise RuntimeError("no se pudo iniciar sesion en EIN (revisa usuario y contrasena)")
        return True

    # -- busqueda ------------------------------------------------------------
    def _pagina_grid(self):
        _, cuerpo = self.s.get(EIN_GRID, cancelado=self.cancelado)
        pagina = cuerpo.decode("utf-8", "replace")
        if "DropInteresados" not in pagina:
            raise RuntimeError("sesion EIN expirada o sin acceso a Cert. x Persona")
        # empresa seleccionada actualmente en el combo
        combo = re.search(r"id=\"ctl00_ContentPlaceHolder1_DropInteresados\".*?</select>", pagina, re.S | re.I)
        if combo:
            sel = re.search(r'<option[^>]*selected[^>]*value="([^"]*)"', combo.group(0), re.I) or \
                  re.search(r'<option[^>]*value="([^"]*)"[^>]*selected', combo.group(0), re.I)
            if sel:
                self.empresa = html.unescape(sel.group(1))
        return pagina

    def _buscar_html(self, dni):
        """Hace la busqueda por DNI y devuelve el HTML del grid resultante."""
        pagina = self._pagina_grid()
        campos = campos_ocultos(pagina)
        campos.update({
            self.PREFIJO_GRID + "DropInteresados": self.empresa,
            self.PREFIJO_GRID + "DropOpf": "DNI",
            self.PREFIJO_GRID + "txtdat": dni,
            self.PREFIJO_GRID + "btnfil": "Buscar",
        })
        _, cuerpo = self.s.post(EIN_GRID, campos, referer=EIN_GRID, cancelado=self.cancelado)
        return cuerpo.decode("utf-8", "replace")

    def buscar(self, dni):
        """
        Devuelve la lista de registros del participante (una fila = un curso).

        Solo se aceptan filas cuyo NDocumento sea EXACTAMENTE el DNI pedido:
        EIN busca por coincidencia parcial y, por ejemplo, "0350889" devuelve
        los certificados de "10350889".
        """
        pagina = self._buscar_html(dni)
        registros = []
        self.descartadas = 0
        tabla = re.search(r"id=\"ctl00_ContentPlaceHolder1_GridView1\".*?</table>", pagina, re.S | re.I)
        if not tabla:
            return registros

        filas = re.findall(r"<tr[^>]*>(.*?)</tr>", tabla.group(0), re.S | re.I)
        indice = 0
        for fila in filas:
            if "<td" not in fila.lower():
                continue  # encabezado
            celdas = [quitar_tags(c) for c in re.findall(r"<td[^>]*>(.*?)</td>", fila, re.S | re.I)]
            if len(celdas) < 12:
                continue
            registro = {
                "indice": indice,
                "cod": celdas[1],
                "dni": celdas[2],
                "apellidos": celdas[3],
                "nombres": celdas[4],
                "cargo": celdas[5],
                "curso": celdas[6],
                "promedio": celdas[7],
                "condicion": celdas[8],
                "inicio": celdas[9],
                "final": celdas[10],
            }
            indice += 1
            if registro["dni"] != dni:
                self.descartadas += 1
                continue
            registros.append(registro)
        return registros

    # -- descarga ------------------------------------------------------------
    def _abrir_reporte(self, dni, indice):
        """Pulsa 'Selec.' en la fila indicada. Devuelve (url_reporte, html) o None."""
        pagina = self._buscar_html(dni)
        campos = campos_ocultos(pagina)
        campos.update({
            "__EVENTTARGET": self.PREFIJO_GRID + "GridView1",
            "__EVENTARGUMENT": "Select$%d" % indice,
            self.PREFIJO_GRID + "DropInteresados": self.empresa,
            self.PREFIJO_GRID + "DropOpf": "DNI",
            self.PREFIJO_GRID + "txtdat": dni,
        })
        campos.pop(self.PREFIJO_GRID + "btnfil", None)
        r, cuerpo = self.s.post(EIN_GRID, campos, referer=EIN_GRID, cancelado=self.cancelado)
        pagina_reporte = cuerpo.decode("utf-8", "replace")
        # Si no hay visor Crystal, ese registro no tiene certificado emitido
        if not any(k.startswith("__CRYSTALSTATE") for k in campos_ocultos(pagina_reporte)):
            return None
        return r.url, pagina_reporte

    def _exportar_pdf(self, url_reporte, pagina_reporte):
        """Ejecuta el 'Print to PDF' del visor Crystal. Devuelve bytes."""
        campos = campos_ocultos(pagina_reporte)
        estado = [k for k in campos if k.startswith("__CRYSTALSTATE")]
        control = estado[0][len("__CRYSTALSTATE"):]        # ctl00$...$CrystalReportViewer1
        vid = control.split("$")[-1]                        # CrystalReportViewer1
        campos.update({
            "__EVENTTARGET": control,
            "__EVENTARGUMENT": '{"text":"PDF", "range":"false", "tb":"crexport"}',
            "%s_toptoolbar_search_textField" % vid: "Find...",
            "text_%s_toptoolbar_selectPg" % vid: "1 of 1+",
            "text_%s_toptoolbar_zoom" % vid: "100%",
        })
        r, datos = self.s.post(url_reporte, campos, timeout=240, referer=url_reporte,
                               cancelado=self.cancelado)
        return datos

    @staticmethod
    def _validar(pdf, cod, dni):
        """True = correcto, False = es de otra persona, None = no verificable."""
        texto = texto_de_pdf(pdf)
        if not texto:
            return None
        if (cod + dni).encode() in texto:           # registro INRC ...- <COD><DNI>
            return True
        encontrados = set(re.findall(rb"Con DNI:\s*(\d+)", texto))
        if encontrados:
            return dni.encode() in encontrados
        return dni.encode() in texto or None

    def descargar(self, dni, registro):
        """Descarga y valida el PDF de un registro. Devuelve bytes o None."""
        for intento in range(1, EIN_INTENTOS_VALIDACION + 1):
            if self.cancelado():
                raise Cancelado()
            reporte = self._abrir_reporte(dni, registro["indice"])
            if reporte is None:
                return None  # sin certificado (desaprobado / no emitido)

            pdf = self._exportar_pdf(*reporte)
            if pdf[:4] != b"%PDF":
                self.log("      . respuesta no-PDF, reintentando (%d/%d)"
                         % (intento, EIN_INTENTOS_VALIDACION))
                time.sleep(2)
                continue

            estado = self._validar(pdf, registro["cod"], registro["dni"])
            if estado is True:
                return pdf
            if estado is None:
                self.log("      ! no se pudo verificar el contenido del PDF; se guarda igual")
                return pdf
            self.log("      . el servidor devolvio el certificado de otra persona, "
                     "reintentando (%d/%d)" % (intento, EIN_INTENTOS_VALIDACION))
            time.sleep(3)

        raise RuntimeError("el servidor devolvio siempre un certificado equivocado "
                           "(%d intentos)" % EIN_INTENTOS_VALIDACION)


# ---------------------------------------------------------------------------
# ORQUESTADOR
# ---------------------------------------------------------------------------

class Descargador:

    def __init__(self, log, progreso, cancelado):
        self.log = log
        self.progreso = progreso
        self.cancelado = cancelado

    def ejecutar(self, dni, destino, usar_jomiser, usar_ein, usuario, password):
        carpeta_dni = os.path.join(destino, limpiar_nombre(dni))
        os.makedirs(carpeta_dni, exist_ok=True)

        resumen = {"dni": dni, "participante": "", "jomiser": [], "ein": [], "errores": []}
        total_ok = 0

        if usar_jomiser:
            total_ok += self._jomiser(dni, carpeta_dni, resumen)
        if usar_ein:
            total_ok += self._ein(dni, carpeta_dni, resumen, usuario, password)

        self._escribir_resumen(carpeta_dni, resumen)
        return carpeta_dni, total_ok, resumen

    # -- JOMISER -------------------------------------------------------------
    def _jomiser(self, dni, carpeta_dni, resumen):
        self.log("")
        self.log("=" * 62)
        self.log("  JOMISER  (aula.jomiser.com)")
        self.log("=" * 62)
        carpeta = os.path.join(carpeta_dni, CARPETA_JOMISER)
        os.makedirs(carpeta, exist_ok=True)
        descargados = 0

        try:
            cliente = ClienteJomiser(self.log, self.cancelado)
            participante, registros = cliente.buscar(dni)
        except Cancelado:
            raise
        except Exception as e:
            self.log("  ERROR al consultar JOMISER: %s" % e)
            resumen["errores"].append("JOMISER: %s" % e)
            return 0

        if participante:
            resumen["participante"] = resumen["participante"] or participante
            self.log("  Participante: %s" % participante)
        if not registros:
            self.log("  Sin registros para el DNI %s" % dni)
            return 0

        self.log("  %d registro(s) encontrado(s)" % len(registros))
        for i, reg in enumerate(registros, 1):
            if self.cancelado():
                raise Cancelado()
            etiqueta = "%s - %s" % (reg["fecha"], reg["curso"])
            if not reg["url"]:
                self.log("  [%d/%d] %s  ->  sin certificado (%s)"
                         % (i, len(registros), etiqueta, reg["estado"]))
                resumen["jomiser"].append({"curso": reg["curso"], "fecha": reg["fecha"],
                                           "estado": reg["estado"], "archivo": None})
                continue
            try:
                self.log("  [%d/%d] %s" % (i, len(registros), etiqueta))
                pdf = cliente.descargar(reg)
                nombre = limpiar_nombre("%s_%s" % (reg["fecha"], reg["curso"])) + ".pdf"
                ruta = nombre_unico(carpeta, nombre)
                with open(ruta, "wb") as fh:
                    fh.write(pdf)
                self.log("          guardado: %s  (%.0f KB)"
                         % (os.path.basename(ruta), len(pdf) / 1024.0))
                descargados += 1
                resumen["jomiser"].append({"curso": reg["curso"], "fecha": reg["fecha"],
                                           "estado": "DESCARGADO",
                                           "archivo": os.path.basename(ruta)})
            except Cancelado:
                raise
            except Exception as e:
                self.log("          ERROR: %s" % e)
                resumen["errores"].append("JOMISER %s: %s" % (etiqueta, e))
                resumen["jomiser"].append({"curso": reg["curso"], "fecha": reg["fecha"],
                                           "estado": "ERROR: %s" % e, "archivo": None})
            self.progreso()

        self.log("  JOMISER: %d PDF descargado(s)" % descargados)
        return descargados

    # -- EIN -----------------------------------------------------------------
    def _ein(self, dni, carpeta_dni, resumen, usuario, password):
        self.log("")
        self.log("=" * 62)
        self.log("  EIN  (WebNexa - Cert. x Persona)")
        self.log("=" * 62)
        carpeta = os.path.join(carpeta_dni, CARPETA_EIN)
        os.makedirs(carpeta, exist_ok=True)
        descargados = 0

        try:
            cliente = ClienteEin(self.log, self.cancelado, usuario, password)
            self.log("  Iniciando sesion como %s ..." % usuario)
            cliente.login()
            self.log("  Sesion iniciada")
            registros = cliente.buscar(dni)
        except Cancelado:
            raise
        except Exception as e:
            self.log("  ERROR al conectar con EIN: %s" % e)
            resumen["errores"].append("EIN: %s" % e)
            return 0

        if cliente.descartadas:
            aviso = ("%d fila(s) de otro documento descartadas (EIN busca por "
                     "coincidencia parcial)" % cliente.descartadas)
            self.log("  %s" % aviso)
            resumen["errores"].append("EIN: %s" % aviso)

        if not registros:
            self.log("  Sin registros para el DNI %s" % dni)
            return 0

        nombre_completo = "%s, %s" % (registros[0]["apellidos"], registros[0]["nombres"])
        resumen["participante"] = resumen["participante"] or nombre_completo
        self.log("  Participante: %s" % nombre_completo)
        self.log("  %d registro(s) encontrado(s)" % len(registros))

        for i, reg in enumerate(registros, 1):
            if self.cancelado():
                raise Cancelado()
            etiqueta = "%s - %s (%s)" % (reg["cod"], reg["curso"], reg["condicion"])
            try:
                self.log("  [%d/%d] %s" % (i, len(registros), etiqueta))
                pdf = cliente.descargar(dni, reg)
                if pdf is None:
                    self.log("          sin certificado emitido (%s)" % reg["condicion"])
                    resumen["ein"].append({"cod": reg["cod"], "curso": reg["curso"],
                                           "condicion": reg["condicion"],
                                           "estado": "SIN CERTIFICADO", "archivo": None})
                    self.progreso()
                    continue
                nombre = limpiar_nombre("%s_%s_%s" % (reg["cod"], reg["curso"],
                                                      reg["inicio"].replace("/", "-"))) + ".pdf"
                ruta = nombre_unico(carpeta, nombre)
                with open(ruta, "wb") as fh:
                    fh.write(pdf)
                self.log("          guardado: %s  (%.0f KB)"
                         % (os.path.basename(ruta), len(pdf) / 1024.0))
                descargados += 1
                resumen["ein"].append({"cod": reg["cod"], "curso": reg["curso"],
                                       "condicion": reg["condicion"], "estado": "DESCARGADO",
                                       "archivo": os.path.basename(ruta)})
            except Cancelado:
                raise
            except Exception as e:
                self.log("          ERROR: %s" % e)
                resumen["errores"].append("EIN %s: %s" % (etiqueta, e))
                resumen["ein"].append({"cod": reg["cod"], "curso": reg["curso"],
                                       "condicion": reg["condicion"],
                                       "estado": "ERROR: %s" % e, "archivo": None})
            self.progreso()

        self.log("  EIN: %d PDF descargado(s)" % descargados)
        return descargados

    # -- resumen -------------------------------------------------------------
    def _escribir_resumen(self, carpeta_dni, resumen):
        lineas = []
        lineas.append("RESUMEN DE DESCARGA DE CERTIFICADOS")
        lineas.append("=" * 62)
        lineas.append("DNI          : %s" % resumen["dni"])
        lineas.append("Participante : %s" % (resumen["participante"] or "-"))
        lineas.append("Fecha        : %s" % time.strftime("%d/%m/%Y %H:%M:%S"))
        lineas.append("")
        lineas.append("JOMISER (%d registro(s))" % len(resumen["jomiser"]))
        lineas.append("-" * 62)
        for r in resumen["jomiser"]:
            lineas.append("  [%s] %s | %s" % (r["estado"], r["fecha"], r["curso"]))
            if r["archivo"]:
                lineas.append("      -> %s/%s" % (CARPETA_JOMISER, r["archivo"]))
        if not resumen["jomiser"]:
            lineas.append("  (sin registros)")
        lineas.append("")
        lineas.append("EIN (%d registro(s))" % len(resumen["ein"]))
        lineas.append("-" * 62)
        for r in resumen["ein"]:
            lineas.append("  [%s] COD %s | %s | %s"
                          % (r["estado"], r["cod"], r["curso"], r["condicion"]))
            if r["archivo"]:
                lineas.append("      -> %s/%s" % (CARPETA_EIN, r["archivo"]))
        if not resumen["ein"]:
            lineas.append("  (sin registros)")
        if resumen["errores"]:
            lineas.append("")
            lineas.append("ERRORES")
            lineas.append("-" * 62)
            for e in resumen["errores"]:
                lineas.append("  - %s" % e)
        try:
            with open(os.path.join(carpeta_dni, "resumen.txt"), "w", encoding="utf-8") as fh:
                fh.write("\n".join(lineas) + "\n")
        except Exception:
            pass


# ---------------------------------------------------------------------------
# INTERFAZ GRAFICA
# ---------------------------------------------------------------------------

class App(ttk.Frame):

    def __init__(self, raiz):
        super().__init__(raiz, padding=12)
        self.raiz = raiz
        self.cola = queue.Queue()
        self.hilo = None
        self.cancelar = threading.Event()
        self.ultima_carpeta = None

        raiz.title("Descargador de Certificados  -  JOMISER + EIN")
        raiz.geometry("820x620")
        raiz.minsize(720, 560)
        self.grid(sticky="nsew")
        raiz.columnconfigure(0, weight=1)
        raiz.rowconfigure(0, weight=1)
        self.columnconfigure(0, weight=1)

        self._construir()
        self._cargar_config()
        self.after(120, self._vaciar_cola)

    # -- construccion de la UI ----------------------------------------------
    def _construir(self):
        fila = 0

        cab = ttk.Label(self, text="Descarga de certificados por DNI",
                        font=("Segoe UI", 14, "bold"))
        cab.grid(row=fila, column=0, sticky="w"); fila += 1
        ttk.Label(self, text="Fuentes: aula.jomiser.com  +  WebNexa (EIN)",
                  foreground="#555").grid(row=fila, column=0, sticky="w", pady=(0, 10)); fila += 1

        # --- datos ---
        caja = ttk.LabelFrame(self, text=" Datos ", padding=10)
        caja.grid(row=fila, column=0, sticky="ew"); fila += 1
        caja.columnconfigure(1, weight=1)

        ttk.Label(caja, text="DNI:").grid(row=0, column=0, sticky="w", pady=4)
        self.var_dni = tk.StringVar()
        e = ttk.Entry(caja, textvariable=self.var_dni, width=18, font=("Consolas", 11))
        e.grid(row=0, column=1, sticky="w", padx=(8, 0), pady=4)
        e.focus_set()
        e.bind("<Return>", lambda _ev: self._iniciar())

        ttk.Label(caja, text="Guardar en:").grid(row=1, column=0, sticky="w", pady=4)
        marco = ttk.Frame(caja)
        marco.grid(row=1, column=1, sticky="ew", padx=(8, 0), pady=4)
        marco.columnconfigure(0, weight=1)
        self.var_destino = tk.StringVar()
        ttk.Entry(marco, textvariable=self.var_destino).grid(row=0, column=0, sticky="ew")
        ttk.Button(marco, text="Examinar...", command=self._elegir_carpeta,
                   width=13).grid(row=0, column=1, padx=(6, 0))

        ttk.Label(caja, text="Fuentes:").grid(row=2, column=0, sticky="w", pady=4)
        marco_f = ttk.Frame(caja)
        marco_f.grid(row=2, column=1, sticky="w", padx=(8, 0), pady=4)
        self.var_jomiser = tk.BooleanVar(value=True)
        self.var_ein = tk.BooleanVar(value=True)
        ttk.Checkbutton(marco_f, text="JOMISER", variable=self.var_jomiser).grid(row=0, column=0)
        ttk.Checkbutton(marco_f, text="EIN (WebNexa)", variable=self.var_ein).grid(row=0, column=1, padx=(16, 0))

        # --- credenciales EIN ---
        cred = ttk.LabelFrame(self, text=" Credenciales EIN (WebNexa) ", padding=10)
        cred.grid(row=fila, column=0, sticky="ew", pady=(10, 0)); fila += 1
        ttk.Label(cred, text="Usuario:").grid(row=0, column=0, sticky="w")
        self.var_usuario = tk.StringVar(value=EIN_USUARIO)
        ttk.Entry(cred, textvariable=self.var_usuario, width=20).grid(row=0, column=1, padx=(8, 20))
        ttk.Label(cred, text="Contrasena:").grid(row=0, column=2, sticky="w")
        self.var_password = tk.StringVar(value=EIN_PASSWORD)
        ttk.Entry(cred, textvariable=self.var_password, width=20, show="*").grid(row=0, column=3, padx=(8, 0))

        # --- acciones ---
        acciones = ttk.Frame(self)
        acciones.grid(row=fila, column=0, sticky="ew", pady=12); fila += 1
        self.btn_descargar = ttk.Button(acciones, text="DESCARGAR", command=self._iniciar, width=20)
        self.btn_descargar.grid(row=0, column=0)
        self.btn_cancelar = ttk.Button(acciones, text="Cancelar", command=self._cancelar,
                                       width=14, state="disabled")
        self.btn_cancelar.grid(row=0, column=1, padx=8)
        self.btn_abrir = ttk.Button(acciones, text="Abrir carpeta", command=self._abrir_carpeta,
                                    width=16, state="disabled")
        self.btn_abrir.grid(row=0, column=2)

        self.barra = ttk.Progressbar(self, mode="determinate")
        self.barra.grid(row=fila, column=0, sticky="ew"); fila += 1

        self.var_estado = tk.StringVar(value="Listo")
        ttk.Label(self, textvariable=self.var_estado, foreground="#333").grid(
            row=fila, column=0, sticky="w", pady=(4, 8)); fila += 1

        # --- log ---
        caja_log = ttk.LabelFrame(self, text=" Progreso ", padding=6)
        caja_log.grid(row=fila, column=0, sticky="nsew")
        self.rowconfigure(fila, weight=1)
        caja_log.columnconfigure(0, weight=1)
        caja_log.rowconfigure(0, weight=1)
        self.log = tk.Text(caja_log, height=14, wrap="none", font=("Consolas", 9),
                           background="#1e1e1e", foreground="#d4d4d4", insertbackground="#d4d4d4")
        self.log.grid(row=0, column=0, sticky="nsew")
        barra_v = ttk.Scrollbar(caja_log, orient="vertical", command=self.log.yview)
        barra_v.grid(row=0, column=1, sticky="ns")
        self.log.configure(yscrollcommand=barra_v.set, state="disabled")

    # -- config persistente --------------------------------------------------
    def _cargar_config(self):
        try:
            with open(CONFIG_PATH, "r", encoding="utf-8") as fh:
                cfg = json.load(fh)
            self.var_destino.set(cfg.get("destino", ""))
            if cfg.get("usuario"):
                self.var_usuario.set(cfg["usuario"])
        except Exception:
            pass
        if not self.var_destino.get():
            self.var_destino.set(os.path.join(os.path.expanduser("~"), "Downloads"))

    def _guardar_config(self):
        try:
            with open(CONFIG_PATH, "w", encoding="utf-8") as fh:
                json.dump({"destino": self.var_destino.get(),
                           "usuario": self.var_usuario.get()}, fh)
        except Exception:
            pass

    # -- helpers de UI -------------------------------------------------------
    def _elegir_carpeta(self):
        carpeta = filedialog.askdirectory(title="Elige la carpeta donde guardar los certificados",
                                          initialdir=self.var_destino.get() or os.path.expanduser("~"))
        if carpeta:
            self.var_destino.set(os.path.normpath(carpeta))

    def _abrir_carpeta(self):
        if self.ultima_carpeta and os.path.isdir(self.ultima_carpeta):
            os.startfile(self.ultima_carpeta)

    def _escribir(self, texto):
        self.log.configure(state="normal")
        self.log.insert("end", texto + "\n")
        self.log.see("end")
        self.log.configure(state="disabled")

    def _vaciar_cola(self):
        try:
            while True:
                tipo, dato = self.cola.get_nowait()
                if tipo == "log":
                    self._escribir(dato)
                elif tipo == "estado":
                    self.var_estado.set(dato)
                elif tipo == "max":
                    self.barra.configure(maximum=max(dato, 1), value=0)
                elif tipo == "paso":
                    self.barra.step(1)
                elif tipo == "fin":
                    self._terminar(dato)
        except queue.Empty:
            pass
        self.after(120, self._vaciar_cola)

    # -- ciclo de descarga ---------------------------------------------------
    def _iniciar(self):
        if self.hilo and self.hilo.is_alive():
            return
        crudo = self.var_dni.get().strip()
        destino = self.var_destino.get().strip()

        dni, relleno = normalizar_dni(crudo)
        if not dni:
            messagebox.showwarning("DNI invalido", "Escribe un DNI (solo numeros).")
            return
        if not destino:
            messagebox.showwarning("Falta la carpeta", "Elige la carpeta donde guardar.")
            return
        if not self.var_jomiser.get() and not self.var_ein.get():
            messagebox.showwarning("Sin fuentes", "Marca al menos una fuente (JOMISER o EIN).")
            return
        try:
            os.makedirs(destino, exist_ok=True)
        except Exception as e:
            messagebox.showerror("Carpeta invalida", "No se puede usar esa carpeta:\n%s" % e)
            return

        self._guardar_config()
        self.log.configure(state="normal"); self.log.delete("1.0", "end"); self.log.configure(state="disabled")
        self.cancelar.clear()
        self.btn_descargar.configure(state="disabled")
        self.btn_cancelar.configure(state="normal")
        self.btn_abrir.configure(state="disabled")
        self.barra.configure(mode="indeterminate"); self.barra.start(12)
        self.var_estado.set("Descargando...")

        self._escribir("DNI: %s" % dni)
        if relleno:
            self._escribir("AVISO: se restauro el cero inicial: %s -> %s "
                           "(Excel borra los ceros al guardar el DNI como numero)"
                           % (crudo, dni))
        self._escribir("Destino: %s" % os.path.join(destino, dni))

        args = (dni, destino, self.var_jomiser.get(), self.var_ein.get(),
                self.var_usuario.get().strip(), self.var_password.get())
        self.hilo = threading.Thread(target=self._trabajar, args=args, daemon=True)
        self.hilo.start()

    def _cancelar(self):
        self.cancelar.set()
        self.var_estado.set("Cancelando...")

    def _trabajar(self, dni, destino, usar_jomiser, usar_ein, usuario, password):
        log = lambda t: self.cola.put(("log", t))
        paso = lambda: self.cola.put(("paso", None))
        try:
            d = Descargador(log, paso, self.cancelar.is_set)
            carpeta, total, resumen = d.ejecutar(dni, destino, usar_jomiser, usar_ein,
                                                 usuario, password)
            self.cola.put(("fin", (carpeta, total, resumen, None)))
        except Cancelado:
            self.cola.put(("fin", (None, 0, None, "cancelado")))
        except Exception as e:
            self.cola.put(("log", "ERROR GENERAL: %s" % e))
            self.cola.put(("fin", (None, 0, None, str(e))))

    def _terminar(self, dato):
        carpeta, total, resumen, error = dato
        self.barra.stop()
        self.barra.configure(mode="determinate", value=0)
        self.btn_descargar.configure(state="normal")
        self.btn_cancelar.configure(state="disabled")

        if error == "cancelado":
            self.var_estado.set("Cancelado por el usuario")
            self._escribir("")
            self._escribir("--- CANCELADO ---")
            return
        if error:
            self.var_estado.set("Termino con errores")
            messagebox.showerror("Error", str(error))
            return

        self.ultima_carpeta = carpeta
        self.btn_abrir.configure(state="normal")
        errores = len(resumen["errores"]) if resumen else 0
        self._escribir("")
        self._escribir("=" * 62)
        self._escribir("  LISTO: %d certificado(s) descargado(s)%s"
                       % (total, "  |  %d error(es)" % errores if errores else ""))
        self._escribir("  Carpeta: %s" % carpeta)
        self._escribir("=" * 62)
        self.var_estado.set("Listo: %d certificado(s) en %s" % (total, carpeta))

        if errores:
            messagebox.showwarning(
                "Descarga terminada con avisos",
                "Se descargaron %d certificado(s).\n%d registro(s) con problemas.\n\n"
                "Revisa el detalle en resumen.txt" % (total, errores))
        else:
            messagebox.showinfo("Descarga completa",
                                "Se descargaron %d certificado(s).\n\n%s" % (total, carpeta))


# ---------------------------------------------------------------------------
# MODO CONSOLA:  python descargar_certificados.py <DNI> <carpeta>
# ---------------------------------------------------------------------------

def main_consola(entrada, destino):
    try:
        sys.stdout.reconfigure(encoding="utf-8")   # tildes correctas en la consola
    except Exception:
        pass
    dni, relleno = normalizar_dni(entrada)
    if not dni:
        print("DNI invalido: %r" % entrada)
        return 1
    if relleno:
        print("AVISO: se restauro el cero inicial: %s -> %s" % (entrada, dni))
    print("DNI: %s" % dni)
    print("Destino: %s" % destino)
    d = Descargador(lambda t: print(t), lambda: None, lambda: False)
    carpeta, total, resumen = d.ejecutar(dni, destino, True, True, EIN_USUARIO, EIN_PASSWORD)
    print("")
    print("LISTO: %d certificado(s) en %s" % (total, carpeta))
    for e in resumen["errores"]:
        print("  aviso: %s" % e)
    return 0


if __name__ == "__main__":
    if len(sys.argv) >= 3:
        sys.exit(main_consola(sys.argv[1], sys.argv[2]))
    raiz = tk.Tk()
    try:
        ttk.Style().theme_use("vista")
    except Exception:
        pass
    App(raiz)
    raiz.mainloop()

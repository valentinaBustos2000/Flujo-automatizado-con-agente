const express = require("express");
const { execFile } = require("child_process");
const { promisify } = require("util");
const dns = require("dns").promises;
const { buildPowerBiModel } = require("./model-builder");

const ejecutarArchivo = promisify(execFile);
const app = express();
const puerto = Number(process.env.PORT || 3000);

const colas = {
    browser: Promise.resolve(),
    directa: Promise.resolve()
};
let solicitudesPendientes = 0;
let solicitudesActivas = 0;
let procesando = false;
const cacheDetalles = new Map();
const cacheTtlMs = 6 * 60 * 60 * 1000;
const cacheMaximo = 5000;

app.use(express.json({ limit: "20mb" }));

app.get("/", (req, res) => {
    res.json({
        status: "ok",
        message: "Servidor de scraping V9.1 multifuente estable funcionando",
        processing: procesando,
        queued: Math.max(solicitudesPendientes - solicitudesActivas, 0),
        cached_details: cacheDetalles.size
    });
});

function ejecutarEnCola(tipo, tarea) {
    if (!colas[tipo]) throw new Error(`Tipo de cola no reconocido: ${tipo}`);
    solicitudesPendientes += 1;

    const ejecutar = async () => {
        solicitudesActivas += 1;
        procesando = true;
        try {
            return await tarea();
        } finally {
            solicitudesPendientes -= 1;
            solicitudesActivas -= 1;
            procesando = solicitudesActivas > 0;
        }
    };

    const resultado = colas[tipo].then(ejecutar, ejecutar);
    colas[tipo] = resultado.catch(() => undefined);
    return resultado;
}

function detalleError(error) {
    return [error?.message, error?.stdout, error?.stderr]
        .filter(Boolean)
        .join("\n");
}

function esperar(ms) {
    return new Promise(resolve => setTimeout(resolve, ms));
}

function esErrorTransitorio(error) {
    if (error?.killed || error?.signal === "SIGTERM" || error?.code === "ETIMEDOUT") return true;
    const detalle = detalleError(error).replace(/--timeout\s+\d+/gi, "");
    return /name or service not known|dns error|enotfound|eai_again|etimedout|timed?\s*out|timeout|econnreset|socket hang up|http\s+(408|425|429|5\d\d)/i
        .test(detalle);
}

async function confirmarDns(hostname) {
    let ultimoError;
    for (let intento = 1; intento <= 4; intento += 1) {
        try {
            await dns.lookup(hostname);
            return;
        } catch (error) {
            ultimoError = error;
            if (intento < 4) await esperar(intento * 10000);
        }
    }
    throw ultimoError;
}

function decodificarHtml(valor) {
    return String(valor || "")
        .replace(/<br\s*\/?>/gi, " ")
        .replace(/<[^>]+>/g, " ")
        .replace(/&nbsp;|&#160;/gi, " ")
        .replace(/&amp;/gi, "&")
        .replace(/&quot;|&#34;/gi, '"')
        .replace(/&#39;|&apos;/gi, "'")
        .replace(/&lt;/gi, "<")
        .replace(/&gt;/gi, ">")
        .replace(/&#(\d+);/g, (_, numero) => String.fromCodePoint(Number(numero)))
        .replace(/&#x([0-9a-f]+);/gi, (_, numero) => String.fromCodePoint(parseInt(numero, 16)))
        .replace(/\s+/g, " ")
        .trim();
}

function normalizar(valor) {
    return decodificarHtml(valor)
        .toLowerCase()
        .normalize("NFD")
        .replace(/[\u0300-\u036f]/g, "")
        .replace(/\s+/g, " ")
        .trim();
}

function limpiarMarkdown(valor) {
    return decodificarHtml(String(valor || "")
        .replace(/!\[[^\]]*\]\([^)]+\)/g, "")
        .replace(/\[([^\]]+)\]\([^)]+\)/g, "$1")
        .replace(/[*_`#]/g, " "));
}

function extraerUrlMarkdown(valor) {
    const coincidencia = String(valor || "").match(/\]\((https?:\/\/[^)]+)\)/i);
    return coincidencia?.[1] || "";
}

function extraerRangoSalarial(valor) {
    const numeros = String(valor || "").match(/\d[\d. ]*/g) || [];
    const montos = numeros
        .map(numero => Number(numero.replace(/[. ]/g, "")))
        .filter(numero => Number.isFinite(numero));
    return {
        salario_minimo: montos[0] ?? null,
        salario_maximo: montos[1] ?? montos[0] ?? null
    };
}

function extraerVacantesSena(contenido, consulta) {
    const resultados = [];
    const vistos = new Set();
    const lineas = String(contenido || "").split(/\r?\n/);

    for (const linea of lineas) {
        if (!linea.includes("|")) continue;
        const celdasOriginales = linea.split("|").map(celda => celda.trim());
        if (celdasOriginales.length < 16) continue;
        const celdas = celdasOriginales.slice(-16);
        const codigo = limpiarMarkdown(celdas[1]);
        const cargo = limpiarMarkdown(celdas[2]);
        if (!/^\d{6,10}$/.test(codigo) || !cargo || /cargo/i.test(cargo)) continue;
        if (vistos.has(codigo)) continue;
        vistos.add(codigo);

        const salario = limpiarMarkdown(celdas[6]);
        const teletrabajo = limpiarMarkdown(celdas[7]);
        const salarioNumerico = extraerRangoSalarial(salario);
        const url = extraerUrlMarkdown(celdasOriginales[0]) || extraerUrlMarkdown(celdasOriginales[1]);
        const departamento = limpiarMarkdown(celdas[3]);
        const municipio = limpiarMarkdown(celdas[4]);
        const indicadorTeletrabajo = /^(1|si|sí|teletrabajo)$/i.test(teletrabajo);

        resultados.push({
            fuente_registro_id: codigo,
            fecha_extraccion: new Date().toISOString(),
            fecha_publicacion: limpiarMarkdown(celdas[10]),
            cargo,
            empresa: "No informada",
            contrato: limpiarMarkdown(celdas[9]),
            modalidad_trabajo: indicadorTeletrabajo ? "Remota" : "No informada",
            estado_modalidad: indicadorTeletrabajo ? "Publicada" : "No informada",
            modalidad_texto_original: indicadorTeletrabajo ? "Teletrabajo" : "No teletrabajo",
            url_vacante: url,
            salario,
            salario_minimo: salarioNumerico.salario_minimo,
            salario_maximo: salarioNumerico.salario_maximo,
            ubicacion: [municipio, departamento].filter(Boolean).join(", "),
            departamento,
            municipio,
            experiencia_meses: Number(limpiarMarkdown(celdas[14])) || 0,
            jornada: limpiarMarkdown(celdas[8]),
            vacantes_publicadas: Number(limpiarMarkdown(celdas[5])) || 0,
            area_desempeno_sena: limpiarMarkdown(celdas[11]),
            area_ocupacional_sena: limpiarMarkdown(celdas[12]),
            id_consulta: consulta.id_consulta || "",
            area_codigo: consulta.area_codigo || "",
            area_estrategica: consulta.area_estrategica || "",
            palabra_clave: consulta.palabra_clave || "",
            fuente_portal: "APE SENA"
        });
    }

    return resultados;
}

async function ejecutarComandoBrowser(sesion, argumentos, timeout = 120000) {
    return ejecutarArchivo("agent-browser", ["--session", sesion, ...argumentos], {
        maxBuffer: 20 * 1024 * 1024,
        timeout
    });
}

async function buscarVacantesSena(consulta) {
    const sesion = `sena-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
    const url = "https://ape.sena.edu.co/spe-web/spe/public/buscadorVacante";
    let contenido = "";
    let diagnostico = "";

    try {
        await ejecutarComandoBrowser(sesion, ["open", url], 150000);
        const snapshot = await ejecutarComandoBrowser(sesion, ["snapshot", "-i"], 60000);
        diagnostico = snapshot.stdout.slice(0, 5000);

        if (/acceso restringido|bloqueada por pol[ií]ticas de seguridad/i.test(diagnostico)) {
            return { status: "blocked", message: "APE SENA bloqueó el acceso del navegador local", content: diagnostico, vacancies: [] };
        }

        const selector = 'input[placeholder*="Buscar por Cargo"]';
        try {
            await ejecutarComandoBrowser(sesion, ["fill", selector, consulta.palabra_clave], 60000);
        } catch (_) {
            await ejecutarComandoBrowser(sesion, [
                "find", "placeholder", "Buscar por Cargo, Departamento, Municipio o Código de solicitud",
                "fill", consulta.palabra_clave
            ], 60000);
        }

        await ejecutarComandoBrowser(sesion, ["press", "Enter"], 60000);
        await ejecutarComandoBrowser(sesion, ["wait", "12000"], 30000);
        const lectura = await ejecutarComandoBrowser(sesion, ["read"], 120000);
        contenido = lectura.stdout.trim();

        if (/acceso restringido|bloqueada por pol[ií]ticas de seguridad/i.test(contenido)) {
            return { status: "blocked", message: "APE SENA bloqueó el acceso del navegador local", content: contenido.slice(0, 5000), vacancies: [] };
        }

        const vacancies = extraerVacantesSena(contenido, consulta);
        return {
            status: vacancies.length > 0 ? "ok" : "empty",
            message: vacancies.length > 0 ? "Búsqueda APE SENA procesada" : "La búsqueda no produjo filas interpretables",
            content: contenido.slice(0, 12000),
            vacancies,
            total: vacancies.length
        };
    } catch (error) {
        return {
            status: "error",
            message: "No fue posible completar la búsqueda en APE SENA",
            error: detalleError(error).slice(0, 1200),
            content: contenido || diagnostico,
            vacancies: []
        };
    } finally {
        await ejecutarComandoBrowser(sesion, ["close"], 30000).catch(() => undefined);
    }
}

function lineasVisiblesHtml(html) {
    return String(html || "")
        .replace(/<script\b[\s\S]*?<\/script>/gi, " ")
        .replace(/<style\b[\s\S]*?<\/style>/gi, " ")
        .replace(/<br\s*\/?>/gi, "\n")
        .replace(/<[^>]+>/g, "\n")
        .split(/\r?\n/)
        .map(linea => decodificarHtml(linea))
        .filter(Boolean);
}

function valorAntesEtiqueta(html, etiqueta) {
    const objetivo = normalizar(etiqueta);
    const lineas = lineasVisiblesHtml(html);
    const indice = lineas.findIndex(linea => normalizar(linea) === objetivo);
    return indice > 0 ? lineas[indice - 1] : "";
}

function extraerTextoClase(html, clase) {
    const patron = new RegExp(`<span[^>]+class=["'][^"']*\\b${clase}\\b[^"']*["'][^>]*>([\\s\\S]*?)<\\/span>`, "i");
    const coincidencia = String(html || "").match(patron);
    return coincidencia ? decodificarHtml(coincidencia[1]) : "";
}

function convertirMontoElempleo(token, usaMillones) {
    const limpio = String(token || "").replace(/\s/g, "");
    if (!limpio) return null;

    const separadoresMiles = /[.,]\d{3}(?:[.,]\d{3})+$/;
    let numero;
    if (separadoresMiles.test(limpio)) {
        numero = Number(limpio.replace(/[.,]/g, ""));
    } else {
        numero = Number(limpio.replace(/\./g, "").replace(",", "."));
    }

    if (!Number.isFinite(numero)) return null;
    if (usaMillones && numero < 1000) numero *= 1000000;
    return Math.round(numero);
}

function extraerRangoSalarialElempleo(valor) {
    const texto = decodificarHtml(valor);
    if (!texto || /confidencial|convenir|no informad/i.test(texto)) {
        return { salario_minimo: null, salario_maximo: null };
    }

    const usaMillones = /mill[oó]n|millones/i.test(texto);
    const tokens = texto.match(/\d+(?:[.,]\d+)*/g) || [];
    const montos = tokens
        .map(token => convertirMontoElempleo(token, usaMillones))
        .filter(monto => Number.isFinite(monto) && monto > 0);

    return {
        salario_minimo: montos[0] ?? null,
        salario_maximo: montos[1] ?? montos[0] ?? null
    };
}

const MUNICIPIOS_TOLIMA = [
    "Ibagué", "Alpujarra", "Alvarado", "Ambalema", "Anzoátegui", "Armero Guayabal",
    "Ataco", "Cajamarca", "Carmen de Apicalá", "Casabianca", "Chaparral", "Coello",
    "Coyaima", "Cunday", "Dolores", "Espinal", "Falan", "Flandes", "Fresno", "Guamo",
    "Herveo", "Honda", "Icononzo", "Lérida", "Líbano", "San Sebastián de Mariquita",
    "Mariquita", "Melgar", "Murillo", "Natagaima", "Ortega", "Palocabildo", "Piedras",
    "Planadas", "Prado", "Purificación", "Rioblanco", "Roncesvalles", "Rovira", "Saldaña",
    "San Antonio", "San Luis", "Santa Isabel", "Suárez", "Valle de San Juan", "Venadillo",
    "Villahermosa", "Villarrica"
];

function identificarMunicipioTolima(ubicacion) {
    const valor = normalizar(ubicacion);
    const coincidencias = MUNICIPIOS_TOLIMA
        .filter(municipio => valor.includes(normalizar(municipio)))
        .sort((a, b) => b.length - a.length);
    return coincidencias[0] || "";
}

function normalizarModalidadPublicada(modalidad) {
    const valor = normalizar(modalidad);
    if (/hibrid|mixt/.test(valor)) return "Híbrida";
    if (/remot|virtual|teletrabajo/.test(valor)) return "Remota";
    if (/presencial/.test(valor)) return "Presencial";
    return "No informada";
}

function extraerVacantesElempleo(html, consulta) {
    const segmentos = String(html || "").split(/<div class=["'][^"']*\bresult-item\b[^"']*["'][^>]*>/i).slice(1);
    const resultados = [];
    const vistos = new Set();

    for (const segmento of segmentos) {
        const atributoDatos = segmento.match(/data-ga4-offerdata="([^"]+)"/i)?.[1] || "";
        let datos = {};
        try {
            datos = JSON.parse(decodificarHtml(atributoDatos));
        } catch (_) {
            datos = {};
        }

        const href = decodificarHtml(segmento.match(/data-url=["']([^"']*\/co\/ofertas-trabajo\/[^"']+)["']/i)?.[1] || "");
        const idUrl = href.match(/-(\d{7,12})(?:[/?#]|$)/)?.[1] || "";
        const id = String(datos.id || idUrl).trim();
        const cargo = decodificarHtml(datos.title || obtenerAtributo(segmento.match(/<a\b[^>]*class=["'][^"']*js-offer-title[^"']*["'][^>]*>/i)?.[0] || "", "title"));
        if (!id || !cargo || vistos.has(id)) continue;
        vistos.add(id);

        const salario = decodificarHtml(datos.salary || valorAntesEtiqueta(segmento, "Salario"));
        const contrato = valorAntesEtiqueta(segmento, "Tipo de contrato");
        const modalidadOriginal = valorAntesEtiqueta(segmento, "Modalidad laboral");
        const modalidad = normalizarModalidadPublicada(modalidadOriginal);
        const ubicacion = decodificarHtml(datos.location || valorAntesEtiqueta(segmento, "Ubicación"));
        const fechaPublicacion = extraerTextoClase(segmento, "js-offer-date");
        const descripcionAtributo = segmento.match(/data-offer-description="([^"]*)"/i)?.[1] || "";
        const descripcion = decodificarHtml(descripcionAtributo);
        const salarioNumerico = extraerRangoSalarialElempleo(salario);
        const ubicacionNormalizada = normalizar(ubicacion);
        const municipioTolima = identificarMunicipioTolima(ubicacion);
        const municipio = municipioTolima || (/remot/.test(ubicacionNormalizada) ? "No informado" : (ubicacion || "No informado"));
        const departamento = (municipioTolima || /tolima/.test(ubicacionNormalizada)) ? "Tolima" : "No informado";

        resultados.push({
            fuente_registro_id: `EE-${id}`,
            fecha_extraccion: new Date().toISOString(),
            fecha_publicacion: fechaPublicacion,
            cargo,
            empresa: decodificarHtml(datos.company || "No informada"),
            contrato: contrato || "No informado",
            modalidad_trabajo: modalidad || "No informada",
            estado_modalidad: modalidadOriginal ? "Publicada" : "No informada",
            modalidad_texto_original: modalidadOriginal,
            url_vacante: href ? `https://www.elempleo.com${href}` : "",
            salario: salario || "No informado",
            salario_minimo: salarioNumerico.salario_minimo,
            salario_maximo: salarioNumerico.salario_maximo,
            ubicacion: ubicacion || "No informada",
            departamento,
            municipio,
            es_ibague_tolima: departamento === "Tolima" ? 1 : 0,
            descripcion,
            cargos_relacionados: decodificarHtml(datos.equivalentPositions || ""),
            etiquetas: decodificarHtml(datos.tags || ""),
            vacantes_publicadas: 1,
            id_consulta: consulta.id_consulta || "",
            area_codigo: consulta.area_codigo || "",
            area_estrategica: consulta.area_estrategica || "",
            palabra_clave: consulta.palabra_clave || "",
            fuente_portal: "elempleo.com"
        });
    }

    return resultados;
}

async function buscarVacantesElempleo(consulta) {
    let contenido = "";
    try {
        contenido = await descargarHtml(consulta.url, 60000);
        const textoControl = normalizar(contenido.slice(0, 200000));
        if (/acceso denegado|access denied|captcha|verify you are human/.test(textoControl)) {
            return {
                status: "blocked",
                message: "elempleo.com bloqueó el acceso automatizado",
                content: lineasVisiblesHtml(contenido).slice(0, 20).join(" | "),
                vacancies: []
            };
        }

        const vacancies = extraerVacantesElempleo(contenido, consulta);
        return {
            status: vacancies.length > 0 ? "ok" : "empty",
            message: vacancies.length > 0 ? "Búsqueda de elempleo.com procesada" : "La página no produjo vacantes interpretables",
            content: `URL: ${consulta.url} | segmentos: ${(contenido.match(/\bresult-item\b/gi) || []).length}`,
            vacancies,
            total: vacancies.length
        };
    } catch (error) {
        return {
            status: "error",
            message: "No fue posible consultar elempleo.com",
            error: detalleError(error).slice(0, 1200),
            content: contenido ? lineasVisiblesHtml(contenido).slice(0, 20).join(" | ") : "",
            vacancies: []
        };
    }
}

async function descargarHtml(url, timeoutMs = 25000) {
    const controlador = new AbortController();
    const temporizador = setTimeout(() => controlador.abort(), timeoutMs);
    try {
        const respuesta = await fetch(url, {
            redirect: "follow",
            signal: controlador.signal,
            headers: {
                "user-agent": "Mozilla/5.0 (compatible; AgentePlaneacionUnibague/5.0)",
                "accept": "text/html,application/xhtml+xml"
            }
        });
        if (!respuesta.ok) throw new Error(`HTTP ${respuesta.status}`);
        return await respuesta.text();
    } finally {
        clearTimeout(temporizador);
    }
}

function obtenerAtributo(etiqueta, nombre) {
    const patron = new RegExp(`${nombre}\\s*=\\s*["']([^"']+)["']`, "i");
    return etiqueta.match(patron)?.[1] || "";
}

function extraerEnlacesVacantes(html) {
    const enlaces = [];
    const vistos = new Set();
    const etiquetas = String(html || "").match(/<a\b[^>]*>/gi) || [];

    for (const etiqueta of etiquetas) {
        const href = decodificarHtml(obtenerAtributo(etiqueta, "href"));
        const titulo = decodificarHtml(obtenerAtributo(etiqueta, "title"));
        if (!/^https:\/\/www\.magneto365\.com\/co\/empleos\/[^/?#]+\/?$/i.test(href)) continue;
        if (!titulo || vistos.has(href)) continue;
        vistos.add(href);
        enlaces.push({ title: titulo, url: href.replace(/\/$/, "") });
    }

    return enlaces;
}

function extraerPublicacion(html) {
    const scripts = String(html || "").match(/<script\b[^>]*>[\s\S]*?<\/script>/gi) || [];
    for (const script of scripts) {
        if (!/id=["']JobPosting["']/i.test(script) && !/"@type"\s*:\s*"JobPosting"/i.test(script)) continue;
        const cuerpo = script.replace(/^<script\b[^>]*>/i, "").replace(/<\/script>$/i, "").trim();
        try {
            const datos = JSON.parse(cuerpo);
            const candidatos = Array.isArray(datos?.["@graph"]) ? datos["@graph"] : [datos];
            const publicacion = candidatos.find(item => item?.["@type"] === "JobPosting");
            if (publicacion) return publicacion;
        } catch (_) {
            // Algunas páginas pueden contener scripts no serializables; se continúa con el siguiente.
        }
    }
    return null;
}

function fragmentoEvidencia(texto, indice, longitud) {
    const inicio = Math.max(0, indice - 55);
    const fin = Math.min(texto.length, indice + longitud + 105);
    return texto.slice(inicio, fin).replace(/\s+/g, " ").trim().slice(0, 220);
}

function detectarModalidad(titulo, descripcion) {
    const textoOriginal = decodificarHtml(`${titulo || ""}. ${descripcion || ""}`);
    const textoNormalizado = normalizar(textoOriginal);
    const reglas = [
        {
            modalidad: "Híbrida",
            patrones: [
                /modalidad\s*(?:de\s+trabajo\s*)?[:\-]?\s*(?:100\s*%\s*)?(?:hibrid[oa]|mixta?)/i,
                /(?:trabajo|modelo|esquema)\s+hibrid[oa]/i,
                /\bhibrid[oa]\b/i
            ]
        },
        {
            modalidad: "Remota",
            patrones: [
                /modalidad\s*(?:de\s+trabajo\s*)?[:\-]?\s*(?:100\s*%\s*)?(?:remot[oa]|virtual|teletrabajo)/i,
                /(?:trabajo|labor)\s+(?:100\s*%\s*)?(?:remot[oa]|virtual)/i,
                /\b(?:home\s*office|trabajo\s+desde\s+casa|teletrabajo|remot[oa])\b/i
            ]
        },
        {
            modalidad: "Presencial",
            patrones: [
                /modalidad\s*(?:de\s+trabajo\s*)?[:\-]?\s*(?:100\s*%\s*)?presencial/i,
                /(?:trabajo|labor)\s+(?:100\s*%\s*)?presencial/i,
                /\bpresencial(?:mente)?\b/i
            ]
        }
    ];

    for (const regla of reglas) {
        for (const patron of regla.patrones) {
            const coincidencia = patron.exec(textoNormalizado);
            if (!coincidencia) continue;
            const contextoPrevio = textoNormalizado.slice(Math.max(0, coincidencia.index - 28), coincidencia.index);
            if (/\b(?:no|sin)\s+(?:es\s+|ofrece\s+|maneja\s+)?$/.test(contextoPrevio)) continue;
            return {
                modalidad_trabajo: regla.modalidad,
                modalidad_texto_original: fragmentoEvidencia(textoOriginal, coincidencia.index, coincidencia[0].length),
                estado_modalidad: "Publicada"
            };
        }
    }

    return {
        modalidad_trabajo: "No informada",
        modalidad_texto_original: "",
        estado_modalidad: "No informada"
    };
}

async function consultarDetalle(enlace) {
    try {
        const html = await descargarHtml(enlace.url, 18000);
        const publicacion = extraerPublicacion(html);
        const descripcion = publicacion?.description || "";
        return {
            title: enlace.title,
            url: enlace.url,
            ...detectarModalidad(enlace.title, descripcion),
            detalle_estado: publicacion ? "Consultado" : "Sin datos estructurados"
        };
    } catch (error) {
        return {
            title: enlace.title,
            url: enlace.url,
            modalidad_trabajo: "No disponible",
            modalidad_texto_original: "",
            estado_modalidad: "Error de consulta",
            detalle_estado: detalleError(error).slice(0, 180)
        };
    }
}

function consultarDetalleConCache(enlace) {
    const ahora = Date.now();
    const existente = cacheDetalles.get(enlace.url);
    if (existente && existente.expiresAt > ahora) return existente.promise;

    if (cacheDetalles.size >= cacheMaximo) {
        const primeraClave = cacheDetalles.keys().next().value;
        if (primeraClave) cacheDetalles.delete(primeraClave);
    }

    const promise = consultarDetalle(enlace);
    cacheDetalles.set(enlace.url, { promise, expiresAt: ahora + cacheTtlMs });
    return promise;
}

async function mapearConLimite(elementos, limite, funcion) {
    const resultados = new Array(elementos.length);
    let siguiente = 0;

    async function trabajador() {
        while (siguiente < elementos.length) {
            const indice = siguiente++;
            resultados[indice] = await funcion(elementos[indice], indice);
        }
    }

    const cantidad = Math.min(limite, Math.max(elementos.length, 1));
    await Promise.all(Array.from({ length: cantidad }, () => trabajador()));
    return resultados;
}

async function prepararEnlacesPagina(url) {
    try {
        const html = await descargarHtml(url, 35000);
        const enlaces = extraerEnlacesVacantes(html);
        return {
            details: enlaces.map(enlace => ({
                ...enlace,
                modalidad_trabajo: "Pendiente",
                modalidad_texto_original: "",
                estado_modalidad: "Pendiente de enriquecimiento",
                detalle_estado: "Pendiente"
            })),
            error: ""
        };
    } catch (error) {
        console.error("No fue posible obtener los enlaces de detalle:", error.message);
        return { details: [], error: detalleError(error).slice(0, 250) };
    }
}

async function leerPaginaUnaVez(direccion, instruction) {
    console.log("Leyendo la pagina con Agent-browser...");
    const enlacesPromise = prepararEnlacesPagina(direccion.href);

    try {
        const respuesta = await ejecutarArchivo(
            "agent-browser",
            ["read", direccion.href, "--timeout", "75000"],
            {
                maxBuffer: 20 * 1024 * 1024,
                timeout: 90000
            }
        );

        const contenidoCompleto = respuesta.stdout.trim();
        if (!contenidoCompleto) throw new Error("Agent-browser no devolvio contenido");

        const lineas = contenidoCompleto.split(/\r?\n/).filter(linea => linea.trim() !== "");
        const titulo = lineas.length > 0 ? lineas[0].replace(/^#+\s*/, "").trim() : "";
        const limite = 30000;
        const contenido = contenidoCompleto.slice(0, limite);
        const enlaces = await enlacesPromise;

        console.log("Lectura terminada correctamente");
        console.log("Caracteres obtenidos:", contenidoCompleto.length);

        return {
            status: "ok",
            message: enlaces.error
                ? "Scraping realizado; algunos enlaces de detalle no fueron identificados"
                : "Scraping realizado; enlaces listos para enriquecimiento",
            url: direccion.href,
            instruction: instruction || "Sin instruccion",
            extraction_mode: "agent-browser-read+job-detail",
            result: {
                title: titulo,
                content: contenido,
                truncated: contenidoCompleto.length > limite,
                total_characters: contenidoCompleto.length,
                vacancy_details: enlaces.details,
                detail_error: enlaces.error
            }
        };
    } catch (error) {
        const detalle = detalleError(error);
        if (/HTTP\s+404/i.test(detalle)) {
            console.log("Pagina adicional no disponible (HTTP 404)");
            return {
                status: "no_additional_page",
                message: "La pagina solicitada no existe; no hay una pagina adicional disponible",
                url: direccion.href,
                instruction: instruction || "Sin instruccion",
                extraction_mode: "agent-browser-read+job-detail",
                result: { title: "", content: "", truncated: false, total_characters: 0, vacancy_details: [] }
            };
        }
        throw error;
    }
}

async function leerPagina(direccion, instruction) {
    let ultimoError;

    for (let intento = 1; intento <= 3; intento += 1) {
        try {
            await confirmarDns(direccion.hostname);
            return await leerPaginaUnaVez(direccion, instruction);
        } catch (error) {
            ultimoError = error;
            const reintentable = esErrorTransitorio(error);

            if (!reintentable || intento === 3) throw error;

            const esperaMs = intento * 20000;
            console.warn(
                `Falla transitoria en ${direccion.hostname}. ` +
                `Reintento ${intento + 1}/3 en ${esperaMs / 1000} segundos.`
            );
            await esperar(esperaMs);
        }
    }

    throw ultimoError;
}

app.post("/scrape", async (req, res) => {
    const { url, instruction } = req.body;
    console.log("Solicitud recibida desde n8n");
    console.log("URL:", url);

    if (!url) return res.status(400).json({ status: "error", message: "No se recibio ninguna URL" });

    let direccion;
    try {
        direccion = new URL(url);
        if (!["http:", "https:"].includes(direccion.protocol)) throw new Error("Protocolo no permitido");
    } catch (error) {
        return res.status(400).json({ status: "error", message: "La URL recibida no es valida", error: error.message });
    }

    try {
        const respuesta = await ejecutarEnCola("browser", () => leerPagina(direccion, instruction));
        return res.json(respuesta);
    } catch (error) {
        console.error("Error durante el scraping:", error.message);
        const esTiempoAgotado = error.killed || error.signal === "SIGTERM" || error.code === "ETIMEDOUT";
        return res.status(500).json({
            status: "error",
            message: esTiempoAgotado ? "La pagina tardo demasiado en responder" : "No fue posible realizar el scraping",
            error: error.message
        });
    }
});

app.post("/powerbi-model", async (req, res) => {
    const { vacancies, executions } = req.body || {};
    console.log("Solicitud de modelo estructurado para Power BI");

    try {
        const result = await buildPowerBiModel({
            vacancies,
            executions,
            outputDir: process.env.FILES_DIR || "/files"
        });
        console.log("Modelo de Power BI generado:", result.outputPath);
        return res.json({
            status: "ok",
            message: "Modelo estructurado para Power BI generado correctamente",
            ...result
        });
    } catch (error) {
        console.error("Error generando el modelo de Power BI:", error.message);
        return res.status(500).json({
            status: "error",
            message: "No fue posible generar el modelo estructurado para Power BI",
            error: error.message
        });
    }
});

app.post("/enrich-modalities", async (req, res) => {
    const vacancies = Array.isArray(req.body?.vacancies) ? req.body.vacancies : [];
    console.log("Solicitud de enriquecimiento de modalidades:", vacancies.length);

    if (vacancies.length === 0) {
        return res.status(400).json({ status: "error", message: "No se recibieron vacantes para enriquecer" });
    }
    if (vacancies.length > 5000) {
        return res.status(400).json({ status: "error", message: "La solicitud supera el máximo de 5000 vacantes" });
    }

    try {
        let procesadas = 0;
        const enriquecidas = await mapearConLimite(vacancies, 8, async vacancy => {
            const url = String(vacancy?.url_vacante || "").trim();
            let detalle;
            if (!url) {
                detalle = {
                    modalidad_trabajo: "No disponible",
                    modalidad_texto_original: "",
                    estado_modalidad: "Detalle no localizado",
                    detalle_estado: "URL no disponible"
                };
            } else {
                detalle = await consultarDetalleConCache({ title: String(vacancy.cargo || ""), url });
            }

            procesadas += 1;
            if (procesadas % 50 === 0 || procesadas === vacancies.length) {
                console.log(`Modalidades procesadas: ${procesadas}/${vacancies.length}`);
            }

            return {
                ...vacancy,
                modalidad_trabajo: detalle.modalidad_trabajo,
                modalidad_texto_original: detalle.modalidad_texto_original,
                estado_modalidad: detalle.estado_modalidad,
                detalle_estado: detalle.detalle_estado
            };
        });

        return res.json({
            status: "ok",
            message: "Modalidades enriquecidas correctamente",
            vacancies: enriquecidas,
            total: enriquecidas.length,
            publicadas: enriquecidas.filter(item => item.estado_modalidad === "Publicada").length,
            errores: enriquecidas.filter(item => item.estado_modalidad === "Error de consulta").length
        });
    } catch (error) {
        console.error("Error enriqueciendo modalidades:", error.message);
        return res.status(500).json({
            status: "error",
            message: "No fue posible enriquecer las modalidades",
            error: error.message
        });
    }
});

app.post("/scrape-sena", async (req, res) => {
    const consulta = {
        id_consulta: String(req.body?.id_consulta || "").trim(),
        area_codigo: String(req.body?.area_codigo || "").trim(),
        area_estrategica: String(req.body?.area_estrategica || "").trim(),
        palabra_clave: String(req.body?.palabra_clave || "").trim()
    };

    if (!consulta.palabra_clave) {
        return res.status(400).json({ status: "error", message: "No se recibió una palabra clave" });
    }

    console.log("Solicitud APE SENA:", consulta.id_consulta, consulta.palabra_clave);
    const resultado = await ejecutarEnCola("browser", () => buscarVacantesSena(consulta));
    return res.json({ ...resultado, query: consulta });
});

app.post("/scrape-elempleo", async (req, res) => {
    const consulta = {
        id_consulta: String(req.body?.id_consulta || "").trim(),
        area_codigo: String(req.body?.area_codigo || "").trim(),
        area_estrategica: String(req.body?.area_estrategica || "").trim(),
        palabra_clave: String(req.body?.palabra_clave || "").trim(),
        url: String(req.body?.url || "").trim()
    };

    if (!consulta.url || !/^https:\/\/www\.elempleo\.com\/co\/ofertas-empleo\//i.test(consulta.url)) {
        return res.status(400).json({ status: "error", message: "No se recibió una URL válida de elempleo.com" });
    }

    console.log("Solicitud elempleo.com:", consulta.id_consulta, consulta.palabra_clave);
    const resultado = await ejecutarEnCola("directa", () => buscarVacantesElempleo(consulta));
    return res.json({ ...resultado, query: consulta });
});

if (require.main === module) {
    const servidor = app.listen(puerto, "0.0.0.0", () => console.log(`Servidor V9.1 multifuente estable ejecutandose en el puerto ${puerto}`));
    servidor.requestTimeout = 30 * 60 * 1000;
}

module.exports = {
    app,
    decodificarHtml,
    extraerEnlacesVacantes,
    extraerPublicacion,
    detectarModalidad,
    extraerVacantesSena,
    extraerRangoSalarialElempleo,
    extraerVacantesElempleo,
    identificarMunicipioTolima,
    normalizarModalidadPublicada
};

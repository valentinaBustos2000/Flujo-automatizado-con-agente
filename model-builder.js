const ExcelJS = require("exceljs");
const crypto = require("crypto");
const fs = require("fs/promises");
const path = require("path");

const COLORS = {
    blue: "1F4E78",
    blueLight: "D9EAF7",
    gray: "44546A",
    grayLight: "E7E9ED",
    gold: "C9A227",
    white: "FFFFFF",
    greenLight: "E2F0D9",
    redLight: "FCE4D6"
};

function clean(value) {
    return value === null || value === undefined ? "" : String(value).trim();
}

function normalize(value) {
    return clean(value)
        .normalize("NFD")
        .replace(/[\u0300-\u036f]/g, "")
        .toLowerCase()
        .replace(/[^a-z0-9]+/g, " ")
        .trim();
}

function splitPipe(value) {
    return clean(value).split("|").map(item => item.trim()).filter(Boolean);
}

function asNumber(value) {
    if (value === null || value === undefined || value === "") return null;
    const number = Number(value);
    return Number.isFinite(number) ? number : null;
}

function asDate(value) {
    if (!value) return null;
    const date = value instanceof Date ? value : new Date(value);
    return Number.isNaN(date.getTime()) ? null : date;
}

function asFlag(value) {
    if (typeof value === "boolean") return value ? 1 : 0;
    return /^(1|true|si|sí)$/i.test(clean(value)) ? 1 : 0;
}

function sourceName(row) {
    const source = clean(row.fuente_portal);
    if (/elempleo/i.test(source)) return "elempleo.com";
    if (/magneto/i.test(source)) return "Magneto";
    return source || "Fuente no informada";
}

function vacancyId(row) {
    const source = sourceName(row);
    const external = clean(row.fuente_registro_id) || clean(row.url_vacante);
    const natural = [row.cargo, row.empresa, row.ubicacion].map(normalize).join("|");
    const key = `${normalize(source)}|${external || natural}`;
    return `VAC-${crypto.createHash("sha256").update(key).digest("hex").slice(0, 14).toUpperCase()}`;
}

function possibleDuplicateGroup(row) {
    const natural = [row.cargo, row.empresa, row.ubicacion].map(normalize).join("|");
    return `GRP-${crypto.createHash("sha256").update(natural).digest("hex").slice(0, 14).toUpperCase()}`;
}

function locationId(row) {
    const natural = [row.departamento, row.municipio, row.ubicacion].map(normalize).join("|");
    return `UBI-${crypto.createHash("sha256").update(natural).digest("hex").slice(0, 12).toUpperCase()}`;
}

function executionId(row) {
    const date = asDate(row.fecha_ejecucion);
    const key = `${sourceName(row)}|${clean(row.id_consulta)}|${clean(row.pagina)}|${date ? date.toISOString() : clean(row.fecha_ejecucion)}`;
    return `EJE-${crypto.createHash("sha256").update(key).digest("hex").slice(0, 14).toUpperCase()}`;
}

function salaryState(row) {
    const provided = clean(row.estado_salario);
    if (/^(Publicado|Confidencial|A convenir|No informado|No interpretable)$/i.test(provided)) {
        const canonical = {
            publicado: "Publicado",
            confidencial: "Confidencial",
            "a convenir": "A convenir",
            "no informado": "No informado",
            "no interpretable": "No interpretable"
        };
        return canonical[normalize(provided)] || provided;
    }
    if (asNumber(row.salario_minimo) !== null && asNumber(row.salario_maximo) !== null) return "Publicado";
    if (normalize(row.salario).includes("confidencial")) return "Confidencial";
    if (normalize(row.salario).includes("convenir")) return "A convenir";
    if (!clean(row.salario)) return "No informado";
    return "No interpretable";
}

function modalityName(value) {
    const normalized = normalize(value);
    if (/hibrid|mixt/.test(normalized)) return "Híbrida";
    if (/remot|virtual|teletrabajo/.test(normalized)) return "Remota";
    if (/presencial/.test(normalized)) return "Presencial";
    if (/no disponible/.test(normalized)) return "No disponible";
    return "No informada";
}

function uniqueRows(rows) {
    const seen = new Set();
    return rows.filter(row => {
        const key = JSON.stringify(row);
        if (seen.has(key)) return false;
        seen.add(key);
        return true;
    });
}

function safeTableName(name) {
    return name.replace(/[^A-Za-z0-9_]/g, "").slice(0, 255);
}

function addDataSheet(workbook, name, headers, rows, tableName, widths = []) {
    const sheet = workbook.addWorksheet(name, { views: [{ state: "frozen", ySplit: 1, showGridLines: false }] });
    sheet.addRow(headers);
    for (const row of rows) sheet.addRow(row);

    const header = sheet.getRow(1);
    header.height = 30;
    header.font = { bold: true, color: { argb: COLORS.white } };
    header.fill = { type: "pattern", pattern: "solid", fgColor: { argb: COLORS.blue } };
    header.alignment = { vertical: "middle", wrapText: true };

    headers.forEach((_, index) => {
        sheet.getColumn(index + 1).width = widths[index] || 18;
    });

    if (rows.length > 0) {
        sheet.addTable({
            name: safeTableName(tableName),
            ref: "A1",
            headerRow: true,
            totalsRow: false,
            style: { theme: "TableStyleMedium2", showRowStripes: true },
            columns: headers.map(headerName => ({ name: headerName })),
            rows
        });
    }

    return sheet;
}

function styleTitle(sheet, range, text, color = COLORS.blue) {
    sheet.mergeCells(range);
    const cell = sheet.getCell(range.split(":")[0]);
    cell.value = text;
    cell.font = { bold: true, size: 16, color: { argb: COLORS.white } };
    cell.fill = { type: "pattern", pattern: "solid", fgColor: { argb: color } };
    cell.alignment = { vertical: "middle" };
    sheet.getRow(cell.row).height = 34;
}

function buildStructures(vacancies, executions) {
    const factHeaders = [
        "vacante_id", "fecha_extraccion", "cargo", "empresa", "contrato",
        "modalidad_trabajo", "estado_modalidad", "modalidad_texto_original", "url_vacante",
        "salario_texto", "estado_salario", "salario_minimo", "salario_maximo",
        "nivel_ocupacional", "ubicacion", "es_ibague_tolima", "urgente", "fuente_portal",
        "fuente_registro_id", "fecha_publicacion", "departamento", "municipio",
        "grupo_posible_duplicado", "posible_duplicado_entre_fuentes", "ubicacion_id",
        "descripcion", "etiquetas"
    ];

    const sourcesByDuplicateGroup = new Map();
    for (const row of vacancies) {
        const group = possibleDuplicateGroup(row);
        if (!sourcesByDuplicateGroup.has(group)) sourcesByDuplicateGroup.set(group, new Set());
        sourcesByDuplicateGroup.get(group).add(sourceName(row));
    }

    const factRows = vacancies.map(row => [
        vacancyId(row), asDate(row.fecha_extraccion), clean(row.cargo), clean(row.empresa), clean(row.contrato),
        modalityName(row.modalidad_trabajo), clean(row.estado_modalidad) || "Detalle no localizado",
        clean(row.modalidad_texto_original), clean(row.url_vacante), clean(row.salario), salaryState(row),
        asNumber(row.salario_minimo), asNumber(row.salario_maximo), clean(row.nivel_ocupacional) || "No determinado",
        clean(row.ubicacion), asFlag(row.es_ibague_tolima), asFlag(row.urgente), sourceName(row),
        clean(row.fuente_registro_id), clean(row.fecha_publicacion), clean(row.departamento), clean(row.municipio),
        possibleDuplicateGroup(row), sourcesByDuplicateGroup.get(possibleDuplicateGroup(row)).size > 1 ? 1 : 0,
        locationId(row), clean(row.descripcion).slice(0, 12000), clean(row.etiquetas).slice(0, 2000)
    ]);

    const areaMap = new Map();
    for (const row of executions) {
        const code = clean(row.area_codigo);
        const name = clean(row.area_estrategica);
        if (code && code !== "REG" && name) areaMap.set(code, name);
    }
    const bridgeAreaRows = [];
    const bridgeQueryRows = [];

    for (const row of vacancies) {
        const id = vacancyId(row);
        const codes = splitPipe(row.area_codigo);
        const names = splitPipe(row.area_estrategica);
        codes.forEach((code, index) => {
            const name = names[index] || (code === "OTR" ? "Otros perfiles regionales" : "");
            areaMap.set(code, name);
            bridgeAreaRows.push([id, code, codes.length > 1 ? "Clasificación múltiple" : "Clasificación única"]);
        });
        const queries = splitPipe(row.id_consulta);
        queries.forEach(query => bridgeQueryRows.push([
            id,
            query,
            queries.length > 1 ? "Encontrada por varias consultas" : "Consulta única"
        ]));
    }

    const areaRows = [...areaMap.entries()]
        .sort(([a], [b]) => a.localeCompare(b, "es", { numeric: true }))
        .map(([code, name]) => [code, name, code === "OTR" ? "Categoría auxiliar" : "Área estratégica", code === "OTR" ? 0 : 1]);

    const queryMap = new Map();
    for (const row of executions) {
        const id = clean(row.id_consulta);
        if (!queryMap.has(id) || Number(row.pagina) === 1) queryMap.set(id, row);
    }
    const queryRows = [...queryMap.entries()]
        .sort(([a], [b]) => a.localeCompare(b, "es", { numeric: true }))
        .map(([id, row]) => [
            id, clean(row.area_codigo), clean(row.area_estrategica), clean(row.subarea),
            clean(row.alcance_geografico), clean(row.url),
            executions.filter(item => clean(item.id_consulta) === id).length,
            executions.filter(item => clean(item.id_consulta) === id)
                .reduce((sum, item) => sum + (asNumber(item.tarjetas_detectadas) || 0), 0),
            sourceName(row)
        ]);

    const executionHeaders = [
        "ejecucion_id", "id_consulta", "fecha_ejecucion", "area_codigo", "area_estrategica", "subarea",
        "alcance_geografico", "pagina", "url", "estado", "tarjetas_detectadas", "detalles_detectados",
        "modalidades_publicadas", "detalles_con_error", "cupos_publicados", "firma_pagina",
        "pagina_repetida", "validacion_paginacion", "mensaje", "fuente_portal"
    ];
    const executionRows = executions.map(row => [
        executionId(row), clean(row.id_consulta), asDate(row.fecha_ejecucion), clean(row.area_codigo),
        clean(row.area_estrategica), clean(row.subarea), clean(row.alcance_geografico), asNumber(row.pagina),
        clean(row.url), clean(row.estado), asNumber(row.tarjetas_detectadas), asNumber(row.detalles_detectados),
        asNumber(row.modalidades_publicadas), asNumber(row.detalles_con_error), asNumber(row.cupos_publicados),
        clean(row.firma_pagina), asFlag(row.pagina_repetida), clean(row.validacion_paginacion), clean(row.mensaje), sourceName(row)
    ]);

    const levelRows = [
        [1, "Práctica o aprendizaje", "Etapa formativa, práctica o contrato de aprendizaje"],
        [2, "Auxiliar u operativo", "Funciones operativas o de apoyo"],
        [3, "Técnico o tecnólogo", "Formación técnica o tecnológica"],
        [4, "Profesional", "Formación profesional universitaria"],
        [5, "Coordinación o especialista", "Especialización, coordinación o liderazgo intermedio"],
        [6, "Directivo", "Dirección, gerencia o alta responsabilidad"],
        [7, "Múltiples niveles aceptados", "La publicación admite más de un nivel educativo u ocupacional"],
        [8, "No determinado", "El texto publicado no permite clasificarlo con seguridad"]
    ];

    const modalityRows = [
        [1, "Presencial", "La publicación indica trabajo en sitio"],
        [2, "Híbrida", "Combina trabajo presencial y remoto"],
        [3, "Remota", "La publicación indica trabajo remoto o virtual"],
        [4, "No informada", "La empresa no publicó una modalidad identificable"],
        [5, "No disponible", "No fue posible consultar el detalle de la vacante"]
    ];

    const sourceRows = [
        [1, "Magneto", "Bolsa de empleo privada", "Consulta nacional y regional"],
        [2, "elempleo.com", "Bolsa de empleo privada", "Consulta nacional y regional"]
    ];

    const locationMap = new Map();
    for (const row of vacancies) {
        const id = locationId(row);
        if (!locationMap.has(id)) {
            locationMap.set(id, [
                id, clean(row.ubicacion), clean(row.departamento) || "No informado",
                clean(row.municipio) || "No informado", asFlag(row.es_ibague_tolima)
            ]);
        }
    }
    const locationRows = [...locationMap.values()].sort((a, b) => `${a[2]}|${a[3]}`.localeCompare(`${b[2]}|${b[3]}`, "es"));

    return {
        factHeaders,
        factRows,
        areaRows,
        bridgeAreaRows: uniqueRows(bridgeAreaRows),
        queryRows,
        bridgeQueryRows: uniqueRows(bridgeQueryRows),
        executionHeaders,
        executionRows,
        levelRows,
        modalityRows,
        sourceRows,
        locationRows
    };
}

async function buildPowerBiModel({ vacancies, executions, outputDir = "/files" }) {
    if (!Array.isArray(vacancies) || vacancies.length === 0) throw new Error("No se recibieron vacantes");
    if (!Array.isArray(executions) || executions.length === 0) throw new Error("No se recibió el control de ejecución");

    const failedExecutions = executions.filter(row => /^(fallida|error|blocked|error_n8n)$/i.test(clean(row.estado)));
    if (failedExecutions.length > 0) {
        const ids = failedExecutions.map(row => `${clean(row.id_consulta)} página ${clean(row.pagina)}`).join(", ");
        throw new Error(`La ejecución contiene ${failedExecutions.length} solicitudes fallidas (${ids}). El modelo oficial no se reemplazó.`);
    }

    const data = buildStructures(vacancies, executions);
    const workbook = new ExcelJS.Workbook();
    workbook.creator = "Dirección de Planeación - Universidad de Ibagué";
    workbook.created = new Date();
    workbook.modified = new Date();

    const summary = workbook.addWorksheet("Resumen", { views: [{ showGridLines: false }] });
    styleTitle(summary, "A1:F1", "Sistema Institucional de Inteligencia de Demanda Laboral");
    summary.mergeCells("A2:F2");
    summary.getCell("A2").value = "Modelo estructurado y actualizado automáticamente para Power BI";
    summary.getCell("A2").font = { italic: true, color: { argb: COLORS.gray } };
    summary.getCell("A2").fill = { type: "pattern", pattern: "solid", fgColor: { argb: COLORS.grayLight } };
    const successfulExecutions = data.executionRows.filter(row => /^exitosa/i.test(clean(row[9]))).length;
    const failedExecutionCount = data.executionRows.filter(row => /^fallida$/i.test(clean(row[9]))).length;
    const summaryRows = [
        [],
        ["Indicador", "Resultado"],
        ["Vacantes únicas", data.factRows.length],
        ["Áreas estratégicas", data.areaRows.filter(row => row[3] === 1).length],
        ["Solicitudes ejecutadas", data.executionRows.length],
        ["Solicitudes exitosas", successfulExecutions],
        ["Solicitudes fallidas", failedExecutionCount],
        ["Salarios publicados", data.factRows.filter(row => row[10] === "Publicado").length],
        ["Salarios a convenir", data.factRows.filter(row => row[10] === "A convenir").length],
        ["Modalidad publicada", data.factRows.filter(row => row[6] === "Publicada").length],
        ["Modalidad no informada", data.factRows.filter(row => row[5] === "No informada").length],
        ["Registros regionales", data.factRows.reduce((sum, row) => sum + row[15], 0)],
        ["Fuentes laborales", new Set(data.factRows.map(row => row[17])).size],
        ["Posibles coincidencias entre fuentes", data.factRows.filter(row => row[23] === 1).length],
        ["Relaciones vacante-área", data.bridgeAreaRows.length],
        ["Relaciones vacante-consulta", data.bridgeQueryRows.length]
    ];
    summary.addRows(summaryRows);
    summary.getRow(4).font = { bold: true, color: { argb: COLORS.white } };
    summary.getRow(4).fill = { type: "pattern", pattern: "solid", fgColor: { argb: COLORS.gray } };
    summary.getColumn(1).width = 32;
    summary.getColumn(2).width = 20;
    for (let row = 5; row <= summaryRows.length + 2; row++) {
        summary.getCell(row, 1).fill = { type: "pattern", pattern: "solid", fgColor: { argb: COLORS.blueLight } };
        summary.getCell(row, 2).font = { bold: true, color: { argb: COLORS.blue } };
        summary.getCell(row, 2).numFmt = "#,##0";
    }

    const model = workbook.addWorksheet("Modelo_PowerBI", { views: [{ showGridLines: false }] });
    styleTitle(model, "A1:F1", "Modelo de datos recomendado para Power BI");
    const modelRows = [
        ["Tabla", "Llave primaria", "Granularidad", "Uso", "Relación", "Dirección"],
        ["Fact_Vacantes", "vacante_id", "Una fila por vacante", "Hechos y atributos", "Centro del modelo", "—"],
        ["Dim_Areas", "area_codigo", "Una fila por área", "Catálogo", "Dim_Areas → Bridge_Vacante_Area", "1:*"],
        ["Bridge_Vacante_Area", "vacante_id + area_codigo", "Una relación", "Clasificación múltiple", "Fact_Vacantes → Bridge", "1:*"],
        ["Dim_Consultas", "id_consulta", "Una fila por consulta", "Catálogo", "Dim_Consultas → Bridge y Fact_Ejecuciones", "1:*"],
        ["Bridge_Vacante_Consulta", "vacante_id + id_consulta", "Una relación", "Hallazgos múltiples", "Fact_Vacantes → Bridge", "1:*"],
        ["Fact_Ejecuciones", "ejecucion_id", "Una solicitud", "Control técnico", "Dim_Consultas → Fact_Ejecuciones", "1:*"],
        ["Dim_Nivel_Ocupacional", "nivel_ocupacional", "Una fila por nivel", "Clasificación laboral", "Dim_Nivel → Fact_Vacantes", "1:*"],
        ["Dim_Modalidad", "modalidad_trabajo", "Una fila por modalidad", "Modalidad laboral", "Dim_Modalidad → Fact_Vacantes", "1:*"],
        ["Dim_Fuentes", "fuente_portal", "Una fila por fuente", "Portal de origen", "Dim_Fuentes → Fact_Vacantes y Fact_Ejecuciones", "1:*"],
        ["Dim_Ubicaciones", "ubicacion_id", "Una fila por ubicación", "Geografía laboral", "Dim_Ubicaciones → Fact_Vacantes", "1:*"]
    ];
    model.addRows([[], ...modelRows]);
    model.getRow(3).font = { bold: true, color: { argb: COLORS.white } };
    model.getRow(3).fill = { type: "pattern", pattern: "solid", fgColor: { argb: COLORS.gray } };
    [28, 27, 28, 28, 45, 14].forEach((width, index) => model.getColumn(index + 1).width = width);

    const fact = addDataSheet(workbook, "Fact_Vacantes", data.factHeaders, data.factRows, "tblFactVacantes", [20, 20, 48, 30, 23, 18, 20, 42, 62, 22, 18, 16, 16, 28, 30, 18, 12, 16, 22, 20, 20, 28, 22, 20, 20, 70, 36]);
    fact.getColumn(2).numFmt = "yyyy-mm-dd hh:mm";
    fact.getColumn(12).numFmt = '"$"#,##0';
    fact.getColumn(13).numFmt = '"$"#,##0';

    addDataSheet(workbook, "Dim_Areas", ["area_codigo", "area_estrategica", "tipo_area", "es_area_estrategica"], data.areaRows, "tblDimAreas", [15, 55, 24, 22]);
    addDataSheet(workbook, "Bridge_Vacante_Area", ["vacante_id", "area_codigo", "tipo_asignacion"], data.bridgeAreaRows, "tblBridgeVacanteArea", [22, 15, 28]);
    addDataSheet(workbook, "Dim_Consultas", ["id_consulta", "area_codigo", "area_estrategica", "subarea", "alcance_geografico", "url_base", "paginas_ejecutadas", "tarjetas_detectadas", "fuente_portal"], data.queryRows, "tblDimConsultas", [15, 15, 50, 28, 24, 64, 20, 20, 18]);
    addDataSheet(workbook, "Bridge_Vacante_Consulta", ["vacante_id", "id_consulta", "tipo_asociacion"], data.bridgeQueryRows, "tblBridgeVacanteConsulta", [22, 15, 34]);
    const executionsSheet = addDataSheet(workbook, "Fact_Ejecuciones", data.executionHeaders, data.executionRows, "tblFactEjecuciones", [22, 15, 20, 15, 48, 28, 24, 10, 64, 24, 20, 20, 22, 20, 18, 16, 18, 25, 36, 18]);
    executionsSheet.getColumn(3).numFmt = "yyyy-mm-dd hh:mm";
    addDataSheet(workbook, "Dim_Nivel_Ocupacional", ["orden", "nivel_ocupacional", "definicion"], data.levelRows, "tblDimNivel", [12, 30, 70]);
    addDataSheet(workbook, "Dim_Modalidad", ["orden", "modalidad_trabajo", "definicion"], data.modalityRows, "tblDimModalidad", [12, 22, 68]);
    addDataSheet(workbook, "Dim_Fuentes", ["orden", "fuente_portal", "tipo_fuente", "cobertura"], data.sourceRows, "tblDimFuentes", [12, 22, 28, 40]);
    addDataSheet(workbook, "Dim_Ubicaciones", ["ubicacion_id", "ubicacion", "departamento", "municipio", "es_ibague_tolima"], data.locationRows, "tblDimUbicaciones", [20, 35, 22, 30, 20]);

    await fs.mkdir(outputDir, { recursive: true });
    const historyDir = path.join(outputDir, "Historico");
    await fs.mkdir(historyDir, { recursive: true });
    const stamp = new Date().toISOString().replace(/[-:]/g, "").replace("T", "_").slice(0, 15);
    const historyPath = path.join(historyDir, `Modelo_Estructurado_Vacantes_PowerBI_${stamp}.xlsx`);
    const outputPath = path.join(outputDir, "Modelo_Estructurado_Vacantes_PowerBI.xlsx");

    await workbook.xlsx.writeFile(historyPath);
    await fs.copyFile(historyPath, outputPath);

    return {
        outputPath,
        historyPath,
        vacancies: data.factRows.length,
        areas: data.areaRows.length,
        executions: data.executionRows.length,
        modalitiesPublished: data.factRows.filter(row => row[6] === "Publicada").length
    };
}

module.exports = {
    buildPowerBiModel,
    buildStructures,
    vacancyId,
    salaryState,
    sourceName,
    possibleDuplicateGroup,
    modalityName,
    locationId
};

<p align="center">
  <a href="README.ja.md">日本語</a> | <a href="README.zh.md">中文</a> | <a href="README.md">English</a> | <a href="README.fr.md">Français</a> | <a href="README.hi.md">हिन्दी</a> | <a href="README.it.md">Italiano</a> | <a href="README.pt-BR.md">Português (BR)</a>
</p>

<p align="center">
  <img src="https://raw.githubusercontent.com/mcp-tool-shop-org/brand/main/logos/housekeeping/readme.png" alt="housekeeping" width="400" />
</p>

<h1 align="center">housekeeping</h1>

<p align="center">
  An operational-health warehouse for a GitHub organization.<br>
  One sweep, one SQLite database, findings you can argue with.
</p>

<p align="center">
  <a href="https://github.com/mcp-tool-shop-org/housekeeping/actions/workflows/ci.yml"><img src="https://github.com/mcp-tool-shop-org/housekeeping/actions/workflows/ci.yml/badge.svg" alt="CI" /></a>
  <a href="LICENSE"><img src="https://img.shields.io/badge/license-MIT-blue" alt="MIT License" /></a>
  <a href="https://mcp-tool-shop-org.github.io/housekeeping/"><img src="https://img.shields.io/badge/Landing_Page-live-blue" alt="Landing Page" /></a>
  <a href="https://mcp-tool-shop-org.github.io/housekeeping/handbook/"><img src="https://img.shields.io/badge/Handbook-read-blue" alt="Handbook" /></a>
</p>

Una sola ejecución recopila el estado de CI de cada repositorio, los problemas abiertos y las solicitudes de extracción, las versiones, las etiquetas de versión, los archivos de flujo de trabajo, la protección de ramas, las alertas de seguridad, los archivos de bloqueo y la facturación de Actions en SQLite, y luego realiza una auditoría de todo ello en función de las reglas establecidas.

Responde, para toda la organización a la vez:

- ¿Cuáles son las ramas predeterminadas que muestran un estado crítico y se trata de una rama principal defectuosa o de un historial obsoleto?
- ¿Cuáles son las solicitudes de extracción que nunca se pueden fusionar, porque una comprobación requerida que no emite nada las está bloqueando?
- ¿Cuáles son las implementaciones que los propios ajustes del repositorio rechazan?
- ¿Dónde han divergido `package.json`, las etiquetas de Git y el registro de npm?
- ¿Cuáles son los flujos de trabajo que infringen las reglas de coste de Actions, cuánto costaron y qué trabajos los utilizaron?
- ¿Qué repositorios contienen avisos que el recuento de alertas de GitHub no detecta?

Es una herramienta de auditoría, no una herramienta de corrección. Lee GitHub y no realiza ningún cambio.

## Por qué tiene esta estructura

| Capa | Opción | Razón |
|---|---|---|
| Transporte | La CLI `gh` | Ya tiene su token. La herramienta nunca almacena ni solicita credenciales. |
| Recopilación | GitHub GraphQL, con paginación | Una sola consulta devuelve metadatos, problemas abiertos, solicitudes de extracción abiertas, versiones y árboles de archivos para una página de repositorios. Una página que sigue superando el tiempo de espera se divide por la mitad y se vuelve a solicitar desde el mismo cursor. |
| Ejecuciones de Actions | REST | GraphQL no tiene una interfaz de Actions. |
| Coste de Actions | API de facturación más duraciones por trabajo | La factura indica qué repositorio; solo los trabajos indican qué flujo de trabajo. Los puntos finales `/timing` de GitHub devuelven ceros, por lo que la suma por trabajo se reconstruye y luego se concilia con la factura. |
| Tarifas de los ejecutores | Se leen de la factura | Una tarifa facturada puede diferir del precio de lista, y una constante en el código fuente distorsionaría todos los números. |
| Almacenamiento | SQLite a través del `node:sqlite` integrado | No hay un paso de compilación nativo. |
| Fuente de la verdad | `data/snapshots/*.json` | Bruto, con capacidad de comparación y solo para anexar. La base de datos se deriva: `npm run rebuild` la reconstruye sin conexión. |
| Registro de la ejecución | `data/sweeps.jsonl` | Una línea por ejecución, incluidas las ejecuciones que fallaron y las ejecuciones que no encontraron nada nuevo. |

Las instantáneas son inmutables y aditivas, por lo que la desviación entre dos fechas es un `JOIN`.

## Requisitos

- Node.js 22.5 o posterior.
- La [CLI de GitHub](https://cli.github.com/), con la sesión iniciada (`gh auth status`) como una cuenta que puede leer la organización. La lectura de la facturación y las alertas de seguridad requiere los permisos correspondientes; una ejecución sin ellos registra "no medido" y continúa. Nunca registra un permiso faltante como un resultado válido.
- Windows o Linux. Se desarrolla en Windows y sus pruebas se ejecutan en Linux en CI. macOS debería funcionar y no se ha probado.

## Uso

```bash
git clone https://github.com/mcp-tool-shop-org/housekeeping.git
cd housekeeping
npm install
npm link                 # puts `hk` on your path
cp housekeeping.config.example.json housekeeping.config.json   # then set "org"
hk refresh               # collect, load, analyze, write reports/AUDIT-<date>.md
```

Luego, realice una consulta:

```bash
hk summary               # portfolio totals
hk ci                    # repositories whose default branch is red
hk findings              # findings grouped by severity and code
hk health                # per-repository health score, worst first
hk repo <name>           # one repository in full
hk prs                   # every open pull request by age
hk versions              # package.json against git tag against npm
hk actions               # every workflow and its rule flags
hk cost                  # Actions cost, gross and net side by side
hk sql "SELECT ..."      # one read-only statement
hk help                  # every command and flag
```

Sin `npm link`, cada `hk <command>` es `node src/cli.mjs <command>`.

`npm run rebuild` vuelve a derivar la base de datos y el informe a partir de las instantáneas que ya están en el disco, sin acceso a la red.

Una ejecución completa realiza unos pocos cientos de llamadas a la API. No ejecute `refresh` en un bucle.

Los resultados se envían a la salida estándar; el progreso y los errores se envían a la salida de error estándar. Cada error imprime un código y una pista. Códigos de salida: 0 (correcto), 1 (error de usuario), 2 (error de tiempo de ejecución), 3 (parcial; la ejecución se completó, pero con lagunas).

## Configuración

`housekeeping.config.json`, además de `package.json`:

```json
{
  "org": "your-org",
  "metaRepos": [".github"]
}
```

- `org` es la organización que se va a analizar. `hk refresh <org>` lo anula. Si no se especifica ninguno de los dos, la ejecución se niega a iniciarse.
- `metaRepos` son los repositorios que contienen los ajustes predeterminados de la organización, los activos o las herramientas, no un producto comercializado. Están exentos de los resultados que solo tienen sentido para un producto: falta de archivos README, LICENSE y similares, ausencia de flujos de trabajo y ausencia de versiones.

Un archivo con formato incorrecto es un error, nunca un valor predeterminado silencioso: una clave desconocida, un tipo incorrecto o un JSON dañado detienen la ejecución.

Entorno: `HK_CONFIG` (ruta de configuración), `HK_DB` (ruta de la base de datos), `HK_LOG` (`silent`, `normal`, `verbose` o `debug`), `HK_COST_REPOS` y `HK_COST_BUDGET` (límites para el paso del coste por trabajo), `GH_PATH` (ruta a `gh`).

## Mantenga los datos privados

**Lo que escribe una ejecución es confidencial. No incluya `data/` o `reports/` en un repositorio público.**

Una instantánea registra los nombres y las descripciones de los repositorios privados, cada alerta de seguridad abierta con el paquete que menciona, los archivos de flujo de trabajo y la facturación de Actions. GitHub oculta deliberadamente las alertas de seguridad de un repositorio público a todos, excepto a sus mantenedores; una instantánea publicada entregaría esa lista.

El `.gitignore` de este repositorio excluye `data/`, `reports/` y `housekeeping.config.json`. Para mantener el historial, que es el objetivo de las instantáneas, ejecute la herramienta desde un repositorio **privado** y guárdelas allí.

## Servidor MCP

`npm run mcp` sirve el almacén a través de stdio, por lo que un asistente puede hacer preguntas sin leer una instantánea de varios megabytes:

`hk_summary` · `hk_findings` · `hk_ci` · `hk_repo` · `hk_backlog` · `hk_health` · `hk_cost` · `hk_sql` · `hk_schema`

```json
{
  "mcpServers": {
    "housekeeping": { "command": "node", "args": ["/path/to/housekeeping/src/mcp.mjs"] }
  }
}
```

`hk_sql` acepta una sola instrucción `SELECT` o `WITH` y abre la base de datos en modo de solo lectura. Una llamada que falla devuelve un error estructurado, nunca un rastreo de pila.

## Resultados

Las reglas se encuentran en `src/analyze.mjs`. Cada una de ellas cita la regla escrita que aplica, por lo que un resultado puede ser discutido en relación con un estándar y no con el gusto personal. Las reglas que incluye este repositorio se encuentran en [`rules/`](rules/):

- [`rules/github-actions.md`](rules/github-actions.md): filtros de ruta, ejecutores, tamaño de la matriz, límite del archivo de flujo de trabajo, concurrencia.
- [`rules/shipcheck-product-standards.md`](rules/shipcheck-product-standards.md): CI debe pasar, las puertas de envío, las versiones.
- [`rules/repo-first.md`](rules/repo-first.md): la rama predeterminada.
- [`rules/atlas-map.md`](rules/atlas-map.md): un mapa comprometido de cada repositorio, que se comprueba en CI.

Son los estándares de una organización. Si los suyos son diferentes, cambie el archivo de reglas y la regla.

Las reglas se aseguran de mantener separados los elementos que parecen similares, porque combinarlos genera ruido:

- **Una rama predeterminada roja no es una rama de solicitud de incorporación de cambios roja.** Una rama de Dependabot que falla es un elemento pendiente; una ejecución `push` fallida en la rama predeterminada es un problema. El evento de la ejecución decide cuál es.
- **El historial no es un problema.** Un flujo de trabajo que se mueve a un disparador de solo lanzamiento conserva su último fallo en la rama predeterminada para siempre. Un flujo de trabajo eliminado conserva sus ejecuciones. Ninguno de los dos es un defecto activo.
- **Una comprobación obligatoria que nada puede emitir no es una comprobación que no se ejecutó aquí.** Una indica que se elimine el requisito; la otra indica que se corrija el disparador. Las correcciones se contradicen entre sí.
- **Una ejecución fallida no es una ejecución cancelada.** `cancel-in-progress` existe para finalizar las ejecuciones obsoletas, por lo que los minutos cancelados suelen ser la regla de concurrencia en funcionamiento.
- **El costo bruto no es el costo neto.** GitHub calcula los costos de los repositorios públicos a precio completo y los reduce a cero. El costo bruto es el costo real de la computación; el costo neto es el dinero real. Nunca se suman.
- **Lo que no se mide no está limpio.** Un repositorio que GitHub no está analizando informa cero alertas. Un repositorio al que no llegó el proceso de cálculo de costos no tiene fila de costos. Ambos se informan como desconocidos.

La gravedad impulsa una puntuación de estado: crítico 40, alto 15, medio 6, bajo 2, informativo 0, que se deduce de 100. La puntuación clasifica la atención, no la calidad.

El [manual](https://mcp-tool-shop-org.github.io/housekeeping/handbook/) enumera cada hallazgo, comando, código de error y tabla.

## Seguridad

- **Solo lectura.** El recopilador emite consultas GraphQL y solicitudes REST `GET`. Nunca fusiona, envía, lanza, publica ni edita una configuración.
- **Sin credenciales.** La autenticación es lo que `gh` ya tiene. No se escribe nada en el disco al respecto.
- **Sin telemetría.** Los únicos hosts contactados son la API de GitHub, a través de `gh`, y el registro de npm, para buscar versiones y avisos.
- **Lo que almacena** es la parte sensible: consulte "Mantenga los datos privados".

Informe de una vulnerabilidad según lo descrito en [SECURITY.md](SECURITY.md).

## Pruebas

```bash
npm test
```

Cada regla se prueba en ambas direcciones: la forma que debe activarse y la forma vecina que no debe activarse. Un verificador independiente vuelve a derivar una muestra de los hallazgos de GitHub en vivo a través de su propio transporte y omite, ruidosamente, cuando no hay base de datos o red.

## Licencia

MIT. Consulte [LICENSE](LICENSE).

---

Creado por <a href="https://mcp-tool-shop.github.io/">MCP Tool Shop</a>

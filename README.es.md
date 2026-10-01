<p align="center">
  <a href="README.ja.md">日本語</a> | <a href="README.zh.md">中文</a> | <a href="README.md">English</a> | <a href="README.fr.md">Français</a> | <a href="README.hi.md">हिन्दी</a> | <a href="README.it.md">Italiano</a> | <a href="README.pt-BR.md">Português (BR)</a>
</p>

<p align="center">
  <img src="https://raw.githubusercontent.com/mcp-tool-shop-org/brand/main/logos/housekeeping/readme.png" alt="housekeeping" width="400" />
</p>

<h1 align="center">housekeeping</h1>

<p align="center">
  An operational-health warehouse for a GitHub organization.<br>
  One sweep, one SQLite database, findings you can argue with,<br>
  and the whole-organization view an AI agent needs to coordinate every repository.
</p>

<p align="center">
  <a href="https://github.com/mcp-tool-shop-org/housekeeping/actions/workflows/ci.yml"><img src="https://github.com/mcp-tool-shop-org/housekeeping/actions/workflows/ci.yml/badge.svg" alt="CI" /></a>
  <a href="LICENSE"><img src="https://img.shields.io/badge/license-MIT-blue" alt="MIT License" /></a>
  <a href="https://mcp-tool-shop-org.github.io/housekeeping/"><img src="https://img.shields.io/badge/Landing_Page-live-blue" alt="Landing Page" /></a>
  <a href="https://mcp-tool-shop-org.github.io/housekeeping/handbook/"><img src="https://img.shields.io/badge/Handbook-read-blue" alt="Handbook" /></a>
</p>

Una sola ejecución recopila el estado de CI de cada repositorio, los problemas abiertos y las solicitudes de extracción, las versiones, las etiquetas de versión, los archivos de flujo de trabajo, la protección de ramas, las alertas de seguridad, los archivos de bloqueo y la facturación de Actions en SQLite, y luego realiza una auditoría de todo ello en función de las reglas establecidas.

Responde, para toda la organización a la vez:

- ¿Cuáles son las ramas predeterminadas que están en rojo y se trata de una rama principal defectuosa o de un historial obsoleto?
- ¿Cuáles son las solicitudes de extracción que nunca se pueden fusionar, porque una comprobación requerida que no emite nada las está bloqueando?
- ¿Cuáles son los despliegues que los propios ajustes del repositorio rechazan?
- ¿Dónde han divergido `package.json`, las etiquetas de Git y el registro de npm?
- ¿Cuáles son los flujos de trabajo que infringen las reglas de coste de Actions, cuánto costaron y qué trabajos los utilizaron?
- ¿Qué repositorios contienen avisos que el propio recuento de alertas de GitHub no detecta?

Es un instrumento de auditoría, no un corrector. Lee GitHub y no cambia nada.

## Un agente para cada repositorio

Una organización con docenas de repositorios no tiene un único lugar donde se almacene su estado. housekeeping es ese lugar, y su servidor MCP, `hk-mcp`, se lo proporciona a un agente de IA. Con él, un agente puede actuar como coordinador para toda la organización:

1. **Ejecución.** `hk refresh` realiza una instantánea de cada repositorio.
2. **Clasificación.** El agente pregunta qué está en rojo, qué está bloqueado y qué ha empeorado, y obtiene respuestas que ya distinguen una rama principal defectuosa de un historial obsoleto, y una solicitud de extracción bloqueada de una solicitud en conflicto.
3. **Planificación de una ola.** Una consulta `hk_sql` encuentra todos los repositorios con la misma estructura, por lo que una corrección se convierte en una solicitud de extracción por repositorio en lugar de una búsqueda.
4. **Realización del trabajo.** housekeeping nunca escribe. El agente abre solicitudes de extracción con sus propias herramientas, bajo sus propios permisos y con su revisión.
5. **Verificación.** Ejecución de nuevo. El hallazgo desaparece o no, y el cambio entre dos instantáneas es una consulta.

Preguntas a las que un agente responde en una o dos llamadas:

- ¿Cuáles son las ramas predeterminadas que están en rojo y qué trabajo y paso fallaron?
- ¿Cuáles son las solicitudes de extracción que nunca se pueden fusionar y es el desencadenador o un conflicto el culpable?
- ¿Qué repositorios contienen un aviso de producción para el que GitHub no muestra ninguna alerta?
- ¿Qué flujos de trabajo programados infringen las reglas para las programaciones y cómo?
- ¿Cuánto costaron Actions y qué trabajo lo utilizó?
- ¿Qué ha cambiado desde la última ejecución?

| Herramienta | Lo que responde |
|---|---|
| `hk_summary` | Totales de la ejecución más reciente: repositorios, problemas, solicitudes de extracción, flujos de trabajo, hallazgos. |
| `hk_findings` | Hallazgos por código, gravedad, categoría o repositorio; recuentos por código cuando no se filtra. El hallazgo de una rama principal en rojo indica el trabajo y el paso que fallaron. |
| `hk_ci` | Repositorios cuya rama predeterminada está en rojo y los flujos de trabajo que fallaron; también fallan las programaciones, las ramas de solicitud de extracción que fallan y los repositorios sin CI. |
| `hk_repo` | Un repositorio completo: hallazgos, flujos de trabajo, solicitudes de extracción y problemas abiertos. |
| `hk_backlog` | Solicitudes de extracción o problemas abiertos en toda la organización, del más antiguo al más reciente. |
| `hk_health` | Una puntuación de estado por repositorio, del peor al mejor. |
| `hk_cost` | Gasto de Actions por repositorio, flujo de trabajo o trabajo, bruto y neto por separado. |
| `hk_sql` | Una única instrucción de solo lectura `SELECT` o `WITH` contra el almacén. |
| `hk_schema` | Las tablas y las columnas, para escribir consultas `hk_sql`. |

Cada respuesta proviene de la instantánea más reciente, abierta en modo de solo lectura. Una llamada que falla devuelve un error estructurado, nunca un rastreo de pila.

### Conéctelo

```json
{
  "mcpServers": {
    "housekeeping": { "command": "hk-mcp", "env": { "HK_HOME": "/path/to/warehouse" } },
    "atlas": { "command": "atlas", "args": ["mcp"] }
  }
}
```

`HK_HOME` es el directorio desde el que se realiza la ejecución. Desde un clon, utilice `"command": "node", "args": ["/path/to/housekeeping/src/mcp.mjs"]`. El segundo servidor es [Atlas](https://github.com/dogfood-lab/testing-os/tree/main/packages/atlas), que responde al mismo agente sobre un repositorio a la vez (véase más abajo). En Windows, inicie un comando instalado globalmente a través de `cmd /c`.

## housekeeping y Atlas

[Atlas](https://github.com/dogfood-lab/testing-os/tree/main/packages/atlas) (`@dogfood-lab/atlas`) mapea un repositorio: sus partes y sus puertas, lo que significa cada flujo de trabajo con lo que ejecuta, publica y despliega. El mapa se confirma como `atlas/` y se comprueba en CI. housekeeping es la vista de la organización. Ambos están diseñados para funcionar juntos.

- **Cada mapa, ejecutado.** Una ejecución lee el mapa confirmado de cada repositorio junto con todo lo demás, e informa de qué repositorios no tienen ninguno, qué nunca ejecutan `atlas check` y qué contienen un motor detrás del que el resto de la organización utiliza.
- **Dónde una ejecución en rojo falló.** Cuando una rama predeterminada está en rojo, el hallazgo indica el trabajo y el paso que fallaron y, a través del mapa, el comando que ese paso ejecuta, por lo que la reparación comienza en el archivo correcto.
- **Datos de despliegue del mapa.** El entorno en el que un trabajo se despliega se toma del mapa donde lo registra, por lo que ambas herramientas leen un flujo de trabajo de la misma manera.
- **Advertencias en toda la flota.** Atlas marca un paso del flujo de trabajo que fallará antes de ejecutarse, como una herramienta que necesita una versión más reciente del entorno de ejecución que el trabajo instala. El informe los enumera para todos los repositorios a la vez.

Un agente con ambos servidores pasa de "estos doce repositorios están bloqueados" (housekeeping) a "este es el flujo de trabajo, el trabajo y los archivos a los que llegará un cambio" (Atlas), sin tener que abrir cada repositorio manualmente.

## Por qué tiene esta forma

| Capa | Opción | Razón |
|---|---|---|
| Transporte | La CLI `gh` | Ya tiene su token. La herramienta nunca almacena ni solicita una credencial. |
| Recopilación | GitHub GraphQL, paginado | Una consulta devuelve metadatos, problemas abiertos, solicitudes de extracción abiertas, versiones y árboles de archivos para una página de repositorios. Una página que sigue dando tiempo de espera se divide por la mitad y se vuelve a solicitar desde el mismo cursor. |
| Ejecuciones de Actions | REST | GraphQL no tiene una superficie de Actions. |
| Las acciones tienen un costo. | API de facturación más duraciones por tarea. | La factura indica qué repositorio; solo las tareas indican qué flujo de trabajo. Los puntos finales `/timing` de GitHub devuelven ceros, por lo que la suma por tarea se reconstruye y luego se concilia con la factura. |
| Tarifas de los ejecutores. | Se lee de la factura. | Una tarifa facturada puede diferir del precio de lista, y una constante en el código fuente distorsionaría todos los números. |
| Almacenamiento. | SQLite a través del `node:sqlite` integrado. | No hay un paso de compilación nativo. |
| Fuente de la verdad. | `data/snapshots/*.json` | Datos sin procesar, comparables y solo para anexar. La base de datos se deriva: `npm run rebuild` la reconstruye sin conexión. |
| Registro de análisis. | `data/sweeps.jsonl` | Una línea por análisis, incluidos los análisis que fallaron y los análisis que no encontraron nada nuevo. |

Las instantáneas son inmutables y aditivas, por lo que la desviación entre dos fechas es un `JOIN`.

## Requisitos

- Node.js 22.5 o posterior.
- La [CLI de GitHub](https://cli.github.com/), con la sesión iniciada (`gh auth status`) como una
cuenta que puede leer la organización. Para leer la facturación y las alertas de seguridad,
se necesitan los permisos correspondientes; un análisis sin ellos registrará "no medido" y
continuará. Nunca registrará un permiso faltante como un resultado válido.
- Windows o Linux. Se desarrolla en Windows y sus pruebas se ejecutan en Linux en
CI. macOS debería funcionar y no se ha probado.

## Uso

```bash
npm install -g @mcptoolshop/housekeeping   # puts `hk` and `hk-mcp` on your path
mkdir warehouse && cd warehouse            # housekeeping keeps its data here
hk refresh your-org                        # collect, load, analyze, write reports/AUDIT-<date>.md
```

Para mantener la configuración entre los análisis, coloque un `housekeeping.config.json` en ese
directorio (consulte Configuración); luego `hk refresh` no necesita ningún argumento.

O ejecútelo desde un clon, que mantiene sus datos en el clon:

```bash
git clone https://github.com/mcp-tool-shop-org/housekeeping.git
cd housekeeping
npm install
npm link                 # puts `hk` on your path
cp housekeeping.config.example.json housekeeping.config.json   # then set "org"
hk refresh
```

Luego, consulte:

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

En un clon sin `npm link`, cada `hk <command>` es `node src/cli.mjs <command>`.

`npm run rebuild` vuelve a derivar la base de datos y el informe a partir de las instantáneas que ya
existen en el disco, sin acceso a la red.

Un análisis completo realiza unos pocos cientos de llamadas a la API. No ejecute `refresh` en un bucle.

Los resultados se envían a la salida estándar; el progreso y los errores se envían a la salida de error estándar. Cada
error imprime un código y una pista. Códigos de salida: 0 (correcto), 1 (error de usuario), 2 (error en tiempo de ejecución), 3 (parcial; el análisis se completó, con omisiones).

## Configuración

`housekeeping.config.json`, en el directorio en el que funciona la herramienta de limpieza (consulte a continuación):

```json
{
  "org": "your-org",
  "metaRepos": [".github"]
}
```

- `org` es la organización que se va a analizar. `hk refresh <org>` lo anula. Si no se especifica ninguno de los dos, un análisis se negará a comenzar.
- `metaRepos` son los repositorios que contienen los valores predeterminados, los activos o las
herramientas de la organización, no un producto que se va a distribuir. Están exentos de los hallazgos que solo
tienen sentido para un producto: falta de archivos README, LICENSE y similares, no tener
flujos de trabajo y no tener versiones.

Un archivo con formato incorrecto es un error, nunca un valor predeterminado silencioso: una clave desconocida, un
tipo incorrecto o un JSON dañado detienen la ejecución.

Ejecute desde un clon, la herramienta de limpieza mantiene `data/`, `reports/` y el archivo de configuración
en el clon. Ejecute como un paquete instalado; los mantiene en el directorio desde el que
lo ejecuta, o en `HK_HOME` cuando se establece.

Entorno: `HK_HOME` (donde residen los datos, los informes y la configuración),
`HK_CONFIG` (ruta de configuración), `HK_DB` (ruta de la base de datos), `HK_LOG`
(`silent`, `normal`, `verbose` o `debug`), `HK_COST_REPOS` y
`HK_COST_BUDGET` (límites del costo por tarea), `GH_PATH` (ruta a `gh`).

## Mantenga los datos privados

**Lo que escribe un análisis es confidencial. No incluya `data/` o `reports/` en un
repositorio público.**

Una instantánea registra los nombres y las descripciones de los repositorios privados, todas
las alertas de seguridad abiertas con el paquete que nombran, los archivos de flujo de trabajo y la facturación de Actions. GitHub oculta deliberadamente las alertas de seguridad de un repositorio público a todos, excepto a sus mantenedores; una instantánea publicada entregaría esa lista.

El `.gitignore` de este repositorio excluye `data/`, `reports/` y
`housekeeping.config.json`. Para mantener el historial, que es el objetivo de las instantáneas,
ejecute la herramienta desde un **repositorio privado** de su propiedad y guárdelos allí.

## Hallazgos

Las reglas se encuentran en `src/analyze.mjs`. Cada una cita la regla escrita que aplica,
por lo que un hallazgo se puede discutir en relación con un estándar y no con el gusto. Las reglas
que incluye este repositorio se encuentran en [`rules/`](rules/):

- [`rules/github-actions.md`](rules/github-actions.md): filtros de rutas, ejecutores, tamaño de la matriz, el límite del archivo de flujo de trabajo, concurrencia.
- [`rules/shipcheck-product-standards.md`](rules/shipcheck-product-standards.md): CI debe pasar, las puertas de envío, las versiones.
- [`rules/repo-first.md`](rules/repo-first.md): la rama predeterminada.
- [`rules/atlas-map.md`](rules/atlas-map.md): un mapa comprometido de cada repositorio, verificado en CI.

Son los estándares de una organización. Si los suyos son diferentes, cambie el archivo de reglas
y la regla al mismo tiempo.

Las reglas se encargan de mantener separados los elementos que parecen similares, porque combinarlos
genera ruido:

- **Una rama predeterminada roja no es una rama de solicitud de extracción roja.** Una rama de Dependabot que falla es un elemento pendiente; una ejecución de `push` fallida en la rama predeterminada es un problema. El evento de la ejecución determina cuál es.
- **El historial no es un problema.** Un flujo de trabajo que se ha movido a un disparador de solo lanzamiento conserva su última falla en la rama predeterminada para siempre. Un flujo de trabajo eliminado conserva sus ejecuciones. Ninguno de los dos es un defecto activo.
- **Una comprobación requerida que nada puede emitir no es una comprobación que no se haya ejecutado aquí.** Una indica que se elimine el requisito; la otra indica que se corrija el disparador. Las correcciones se contradicen entre sí.
- **Una solicitud de extracción que el disparador omitió no es una solicitud en conflicto.** GitHub no ejecuta ningún flujo de trabajo de solicitud de extracción en una solicitud de extracción con conflictos, por lo que su comprobación faltante no dice nada sobre el disparador. Esta última necesita una rebase.
- **Una ejecución fallida no es una ejecución cancelada.** `cancel-in-progress` existe para eliminar las ejecuciones obsoletas, por lo que los minutos cancelados suelen ser la regla de concurrencia en funcionamiento.
- **El costo bruto no es el costo neto.** GitHub mide los repositorios públicos a precio completo y los descuenta a cero. El costo bruto es la capacidad de cómputo real; el costo neto es el dinero real. Nunca se suman.
- **Lo que no se mide no está limpio.** Un repositorio que GitHub no está analizando informa cero alertas. Un repositorio al que no llegó el paso de costo no tiene fila de costo. Ambos se informan como desconocidos.

La gravedad impulsa una puntuación de estado: crítica 40, alta 15, media 6, baja 2, informativa 0, que se deduce de 100. La puntuación clasifica la atención, no la calidad.

El [manual](https://mcp-tool-shop-org.github.io/housekeeping/handbook/) enumera todos los hallazgos, comandos, códigos de error y tablas.

## Seguridad

- **Solo lectura.** El recopilador emite consultas GraphQL y solicitudes REST `GET`. Nunca fusiona, envía, lanza, publica ni edita una configuración.
- **Sin credenciales.** La autenticación es lo que `gh` ya tiene. Nada se escribe en el disco al respecto.
- **Sin telemetría.** Los únicos hosts contactados son la API de GitHub, a través de `gh`, y el registro de npm, para buscar versiones y avisos.
- **Lo que almacena** es la parte sensible: consulte "Mantenga los datos privados".

Informe una vulnerabilidad según lo descrito en [SECURITY.md](SECURITY.md).

## Pruebas

```bash
npm test
```

Cada regla se prueba en ambas direcciones: la forma que debe activarse y la forma vecina que no debe activarse. Un verificador independiente vuelve a derivar una muestra de los hallazgos de GitHub en vivo a través de su propio transporte y omite, ruidosamente, cuando no hay base de datos o red.

## Licencia

MIT. Consulte [LICENSE](LICENSE).

---

Creado por <a href="https://mcp-tool-shop.github.io/">MCP Tool Shop</a>

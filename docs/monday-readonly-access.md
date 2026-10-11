# Acceso mínimo de lectura a Monday

## Estado actual: OAuth inactivo y preparación autorizada

El usuario autorizó el piloto de lectura de tableros, comentarios e identidad propia mediante OAuth para los tableros llamados **Leads, Deals, Funnel, Form y Quotes**. El alcance autorizado comprende `boards:read`, `updates:read` y `me:read`; el futuro backend deberá aplicar la lista de tableros y campos permitidos. Esta autorización no acredita que una aplicación OAuth esté creada, que existan credenciales configuradas o que se hayan comprobado permisos efectivos en Monday.

El usuario confirmó en la sesión el email de la cuenta Monday elegida y el plugin confirmó los IDs de cuenta y usuario indicados abajo. El email no se publica aquí ni se fijará en código, fixtures o ejemplos de entorno: llegará mediante la política de configuración del servidor. Quedan pendientes workspace, los cinco IDs de tablero y el mapeo de columnas. La identidad comprobada por el plugin no acredita un token OAuth del runtime ni sus permisos. Esta revisión documental no crea aplicaciones, configura credenciales o consulta cuentas; tampoco ejecuta modelos o servicios facturables. El alcance autorizado de ese piloto sigue separado del trabajo actual de Proveedores/Compras en DEMO. Este tramo de Proveedores/Abastecimiento y su publicación en staging no incluye implementar ni activar OAuth. La integración queda para una fase posterior, con configuración y handoff pendientes.

La primera comprobación futura leerá **un único tablero seleccionado de la lista autorizada**, con campos comerciales mínimos. Incorporar los otros cuatro requiere resolver sus IDs y mapeos y validar cada lectura. Los nombres sirven para identificar el objetivo con el usuario; el adaptador deberá fijar IDs comprobados y no buscar por nombre en cada solicitud.

## Lo que existe en el repositorio

| Fuente existente | Comportamiento comprobado en código | Límite para Monday real |
| --- | --- | --- |
| [`contracts.ts`](../src/office/contracts.ts) y [`adapter.ts`](../src/office/adapter.ts) | `CommercialThread` versión 1 admite referencias `fixture`, `gmail` y `monday`; las referencias faltantes tienen evidencia nula. El validador de hilos exige contexto DEMO. | Los datos reales necesitan una nueva versión de contrato y validación de procedencia, permisos e identidad. |
| [`commercial-fixtures.ts`](../src/office/backend/commercial-fixtures.ts) | Monday figura como `missing`, sin tablero conectado ni evidencia real. | Un borrador o aprobación DEMO no constituye evidencia externa. |
| `loadLiveSnapshot` en [`adapter.ts`](../src/office/adapter.ts) | La proyección dormida consulta autenticación staff y leads internos. Admite campos de entrada como `monday_item_url`, `monday_synced_at` y `crm_status`, pero conserva pago y proveedor desconocidos. | No consulta Monday ni verifica una relación entre un ítem y un caso. Un enlace o fecha de sincronización no acredita hechos operativos. |
| [`model.ts`](../src/office/model.ts) y contratos | La ejecución requiere cierre, pago y aceptación del proveedor con evidencia compatible con el caso; el snapshot exige `mondayWrites: 0`. | Una etiqueta editable de Monday no acredita pago, cierre humano o aceptación del proveedor. |

El runtime no dispone de un cliente OAuth Monday ni de un adaptador de lectura de sus tableros. La frontera prevista está descrita en [commercial-flow.md](commercial-flow.md). Los datos reales no deben introducirse en los casos sintéticos ni convertir una aprobación DEMO en permiso de escritura.

## Scopes y permisos efectivos

| Scope | Alcance del piloto | Comprobación pendiente |
| --- | --- | --- |
| `boards:read` | Autorizado para leer metadatos e ítems de los tableros aprobados. | Grant de la aplicación y acceso efectivo del actor al primer ID fijado. |
| `updates:read` | Autorizado para comentarios comerciales mínimos de ítems aprobados. | Qué comentarios se necesitan y cómo excluir contenido personal o sensible antes de proyectarlo. |
| `me:read` | Autorizado para `me { id email }`, identidad propia del actor. | Concordancia del token del runtime con el email y el ID de usuario confirmados en la sesión. |
| `account:read` | Fuera del mínimo propuesto; consultar `account`, incluso dentro de `me`, lo requiere. | Añadirlo solo si se decide y autoriza comprobar la cuenta con esa consulta. |
| `workspaces:read` | No necesario para obtener el ID de workspace desde un tablero autorizado. | No listar workspaces; consultar su objeto completo exigiría ampliar alcance. |
| `users:read` | Fuera del mínimo: no consultar perfiles ni directorio de personal. | No ampliar por conveniencia para resolver autores o contactos. |

Estos requisitos proceden de la API, no de un grant comprobado en la cuenta: [Boards](https://developer.monday.com/api-reference/reference/boards), [Updates](https://developer.monday.com/api-reference/reference/updates), [Me](https://developer.monday.com/api-reference/reference/me), [Account](https://developer.monday.com/api-reference/reference/account), [Workspaces](https://developer.monday.com/api-reference/reference/workspaces) y [Users](https://developer.monday.com/api-reference/reference/users).

Los scopes no restringen por ID de tablero. La lista de cinco tableros y sus columnas debe aplicarse en el servidor a todas las consultas, cursores y respuestas; se rechazará cualquier ID externo a ella. Para comentarios se consultarán `updates` dentro del tablero o ítem autorizado, sin utilizar una consulta raíz que recorra comentarios de la cuenta. [OAuth y permisos](https://developer.monday.com/apps/docs/oauth), [Updates](https://developer.monday.com/api-reference/reference/updates).

Un token personal hereda todos los scopes y los permisos de interfaz de su usuario: no es una credencial técnicamente limitada a lectura. La opción autorizada es OAuth con scopes de lectura explícitos. Aun con OAuth, el actor necesita acceso real al tablero; los tableros privados y compartibles mantienen sus reglas de pertenencia. No se ha comprobado esa pertenencia. [Autenticación](https://developer.monday.com/api-reference/docs/authentication), [Tableros privados](https://support.monday.com/hc/en-us/articles/115005310185-Private-Boards), [Tableros compartibles](https://support.monday.com/hc/en-us/articles/115005309925-Shareable-Boards).

## Identidad y mapeos pendientes

Los IDs son datos de configuración del destino, no credenciales. Se completarán mediante el handoff autorizado; no se inventan ni se infieren de nombres parecidos.

| Identificador | Valor |
| --- | --- |
| Email de la cuenta Monday elegida | Confirmado por el usuario en la sesión; valor reservado a la configuración del servidor, sin OAuth del runtime establecido |
| `account_id` | `29907909`, confirmado por el plugin en la sesión; pendiente de vinculación comprobada con la instalación OAuth del runtime |
| `actor_user_id` | `78158865`, confirmado por el plugin en la sesión; pendiente de concordancia mediante `me { id email }` con el token del runtime |
| `workspace_id` o IDs si los tableros están en varios workspaces | TODO: pendiente de metadatos del tablero autorizado |
| Primer tablero del piloto | TODO: seleccionar uno de los cinco nombres autorizados |

| Nombre autorizado | `board_id` | `workspace_id` | Columna de unión con el caso | Columnas permitidas y tipos | Etiquetas y significado comercial |
| --- | --- | --- | --- | --- | --- |
| Leads | TODO | TODO | TODO | TODO | TODO |
| Deals | TODO | TODO | TODO | TODO | TODO |
| Funnel | TODO | TODO | TODO | TODO | TODO |
| Form | TODO | TODO | TODO | TODO | TODO |
| Quotes | TODO | TODO | TODO | TODO | TODO |

Para cada tablero hay que registrar los IDs reales de columna, sus tipos y, cuando corresponda, el significado comprobado de las etiquetas. No se asignan roles a esos tableros por su nombre ni se presupone una columna `status`, un importe, una relación entre ítems o un identificador de cliente. La unión deberá ser explícita y única; los IDs `demo-*` no identifican clientes reales.

| Dato del modelo actual | Mapeo futuro necesario | Regla de interpretación |
| --- | --- | --- |
| `OfficeCase.id` | Clave de caso aprobada y relación con cuenta/tablero/ítem | No unir por título, email, enlace o coincidencia aproximada. |
| `title` / `subtitle` | Columnas comerciales concretas, aún TODO | Publicar solo el contenido necesario para la función autorizada. |
| Brief comercial | IDs de columnas para datos del evento que se aprueben, aún TODO | Fecha, zona, asistentes o restricciones siguen pendientes si la fuente no los confirma. |
| Referencias y `Evidence` | Identidad de fuente/ítem, fecha de fuente, fecha de lectura y actor, mediante contrato futuro | Distinguir lectura observada de confirmación operativa; una fecha de importación no es fecha del hecho. |
| `CommercialThread.references` y comentarios | Contrato futuro de contexto real; selección y filtrado comercial, aún TODO | No insertar comentarios reales en versión 1 DEMO ni enviar texto bruto al navegador. |
| Pago, proveedor, cierre y llamadas | Evidencia específica de cada hecho, fuera de un simple mapeo de etiquetas | Conservar desconocido cuando falte una fuente fiable y compatible con el caso. |

## Lectura acotada y tratamiento de datos

La futura implementación comprobará primero identidad y un tablero fijo. Leerá únicamente metadatos necesarios de ese tablero y de las columnas seleccionadas; no listará cuentas, todos los workspaces, usuarios, equipos, propietarios o vistas. La selección de ítems se acotará a casos aprobados. Subítems, descripciones, adjuntos y otros tableros quedarán fuera hasta tener una necesidad y mapeo autorizados.

La primera página se diseñará con un límite de 25 ítems. En GraphQL, `boards(ids: ...) { items_page }` y `next_items_page` admiten hasta 500; el cursor caduca 60 minutos desde la primera solicitud y `null` indica final. `query_params` y cursor no se combinan. `items_page` cubre ítems activos; una lectura no acredita inexistencia de ítems archivados. [Items page](https://developer.monday.com/api-reference/reference/items-page), [Next items page](https://developer.monday.com/api-reference/reference/next-items-page).

El adaptador fijará topes de páginas, tiempo y volumen. Vinculará cada cursor con actor, cuenta, tablero, filtros, columnas y versión de API; no reutilizará cursores entre destinos. Una expiración, límite, cambio de esquema o página fallida producirá estado parcial explícito, sin presentar un snapshot completo. Se fijará una versión soportada de `API-Version` y se verificará la utilizada; los límites de complejidad y las esperas de reintento se tratarán según la respuesta real. [Versionado](https://developer.monday.com/api-reference/docs/api-versioning), [Complejidad](https://developer.monday.com/api-reference/reference/complexity), [Límites](https://developer.monday.com/api-reference/docs/rate-limits).

El HTTP 200 no basta para declarar éxito: deben validarse `errors`, estructura, IDs esperados y datos devueltos. Un error de permisos o un resultado parcial no equivale a ausencia de casos ni a autorización acreditada. [Errores de la API](https://developer.monday.com/api-reference/docs/error-handling).

La proyección inicial excluirá contactos personales y datos sensibles: teléfonos, emails de clientes, perfiles de personal, detalles privados de Talento, información financiera ajena al brief y enlaces a archivos con acceso o tokens. Los comentarios también pueden contener esos datos: el mapeo y filtrado deberán estar definidos antes de habilitar su importación. Solo se expondrá contexto comercial mínimo, con permisos por usuario, función y caso. Los logs y recibos contendrán estados, códigos e identidades mínimas necesarias, sin cuerpos de comentarios, respuestas completas o credenciales.

## Autenticación futura y herramientas de Codex

La identidad solicitada por email y los IDs de cuenta/usuario están resueltos en la sesión; Developer Apps y el handoff seguro no están verificados. No se crearon OAuth ni permisos. El navegador cloud no dispone de una sesión utilizable y su continuación quedó limitada por `insufficient_credits`; este encargo no compra créditos ni usa el Mac. La creación y conexión OAuth siguen pendientes de configuración y vinculación comprobada de esa identidad al runtime. El nuevo flujo de Monday exige PKCE con `S256`, comprobación de `state` y renovación con rotación del refresh token; el backend debe conservar el token nuevo y retirar el anterior. Estos son requisitos para una implementación futura, no capacidades configuradas hoy. [Migración al nuevo OAuth](https://developer.monday.com/apps/docs/migrating-to-the-new-oauth-flow), [OAuth y state](https://developer.monday.com/apps/docs/oauth).

Las credenciales se gestionarán fuera del navegador, repositorio, documentos y chat mediante el mecanismo seguro elegido para la integración. No se generan credenciales en este encargo ni se reutilizan los secretos de Coolify para otro destino.

En este entorno hay metadatos de herramientas Monday para consultas GraphQL de lectura, esquema, tipos, tablero e ítems. `mcp__codex_apps__monday_com_all_api_read` declara rechazo de mutaciones; las herramientas de páginas exigen conocer primero las columnas y los filtros aplicables. Su disponibilidad no acredita cuenta conectada, scopes concedidos, acceso a los cinco tableros o un conector dentro del runtime de Office. No se invocó ninguna herramienta Monday durante esta revisión. Los límites anunciados por un wrapper tampoco sustituyen los límites de GraphQL descritos arriba.

Para habilitar el piloto deberán quedar registrados: cuenta y actor comprobados; primer tablero y columnas fijados; grant efectivo con los tres scopes de lectura; permisos del actor; lectura mínima completa o parcial claramente señalada; filtrado del contexto comercial; y ausencia de operaciones de escritura. Los cinco IDs y mapeos permanecen TODO hasta contar con evidencia. La implementación y activación externas requieren la tarea correspondiente y el handoff seguro; la autorización del alcance ya existe.

## Preparación pendiente; sin rutas de integración implementadas

No existe un adaptador OAuth Monday del runtime, un callback implementado y probado ni rutas funcionales de esta integración. Este encargo no ha registrado una URL de callback ni dispone de un registro externo verificado. Su dirección y contrato se documentarán únicamente cuando exista código probado; este documento no ofrece una URL propuesta para registrar.

Antes de una activación posterior quedan pendientes:

- Configurar y verificar la aplicación privada, su versión, el nuevo flujo OAuth y el handoff seguro. La autorización de alcance existe, pero el grant efectivo de los tres scopes y las credenciales del runtime no están comprobados.
- Definir un principal verificable con permiso separado de gestión y lectura por caso/función, con denegación por defecto. El actor compartido y el selector de funciones DEMO no acreditan un administrador humano de la cuenta externa.
- Contrastar la identidad del token del runtime mediante `me { id email }` y comprobar por separado la vinculación con la cuenta e instalación esperadas. Los IDs confirmados por el plugin sirven de política esperada; no son prueba de esa vinculación OAuth. Consultar `account` requiere `account:read`, fuera del alcance autorizado; no se amplían scopes ni se suponen claims de cuenta de un JWT. [Identidad propia](https://developer.monday.com/api-reference/reference/me), [Account](https://developer.monday.com/api-reference/reference/account).
- Diseñar almacenamiento privado cifrado, caducidad verificada, consumo de state de un uso y renovación rotatoria sin llamadas externas dentro de transacciones. Un resultado de renovación incierto requerirá un estado explícito y no una repetición automática.
- Fijar los IDs de tablero, columnas, uniones con casos y filtrado comercial. Hasta tener esos mapeos y permisos, la lectura real permanecerá bloqueada.
- Evaluar la autenticación del futuro retorno HTTPS y demostrarla con pruebas. El servidor actual exige Basic Auth global y usa una cookie DEMO `SameSite=Strict`; no se introdujo ninguna excepción en este tramo. [http.ts](../src/office/backend/http.ts), [session.ts](../src/office/backend/session.ts).

### Nombres previstos para la política de identidad

Son nombres de preparación, sin lector ni valores configurados en el runtime. Los valores esperados llegarán por configuración segura; no se fijarán en código, fixtures o ejemplos de entorno.

```text
MONDAY_EXPECTED_ACCOUNT_EMAIL
MONDAY_EXPECTED_USER_ID
MONDAY_EXPECTED_ACCOUNT_ID
```

OAuth permanece inactivo. Este cambio solo ajusta documentación: no crea rutas, migraciones, credenciales, permisos o conexiones, ni acredita pruebas de un callback.

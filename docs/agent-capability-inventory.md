# Inventario del primer flujo de agente de ventas

Fecha: 2026-10-11. Base histórica inspeccionada: `ef2c9fadad61687e2ed6c184d13d9ae1263ec563`.
Las referencias y números de línea corresponden a ese commit, salvo los apartados
de entrega local y ampliaciones posteriores. Este documento no activa modelos, cuentas, conectores, llamadas,
envíos ni despliegues.
Ampliaciones de alcance: operación remota completa, encargo de 15:22 UTC;
fuentes de sourcing y compras, encargo de 15:49 UTC.
Las tablas base y la propuesta de las 15:49 UTC son cortes históricos. Para
R08/R09/R19/R24 y los procesos 9/10/11 de la matriz, sus clasificaciones quedan
sustituidas por el apartado final de proveedores/abastecimiento: implementación
DEMO persistente con QA local validado. CI del SHA final y despliegue staging
siguen pendientes en este corte; no se acreditan operaciones o conectores reales.

Office tiene persistencia, permisos de demo, contexto comercial sintético y
revisión humana con huella. Su motor actual es un **guion local, sin LLM**.
`src/operations` contiene núcleos útiles de asignación, telefonía, borradores y
pagos; no constituye un servicio operativo conectado de extremo a extremo.

## Estado de entrega local: corte comercial histórico

Corte previo a publicación: durante la inspección base, la referencia de staging
era `ef2c9fa`. Este snapshot no acredita la versión remota posterior a publicar
estos cambios; esa versión requiere SHA y evidencia de despliegue. El checkout
local añade el flujo de lectura comercial y hechos operativos, generación sintética
acotada, deduplicación por contexto, fallos sanitizados persistidos, evaluador de
paradas, ledger parcial/desconocido y cola visible de pago sin proveedor. Sigue
siendo DEMO. Ver [contrato y límites](commercial-flow.md) y
[matriz del recorrido completo](automation-traceability.md).

No hay configuración o ejecutor conectado de LLM, n8n, Slack, Monday, Gmail,
Google Voice, PayPal, calendario o publicación de páginas. Telnyx y pagos tienen
núcleos verificadores/arithmetic locales, sin clientes o gateways activos.
La ubicación del generador existente y los originales HTML siguen pendientes.

Validación del corte comercial anterior: typecheck y compilación Office correctos; 168 pruebas Office
incluyen concurrencia PostgreSQL, permisos, 25 salidas adversariales y errores.
Seis comprobaciones de navegador pasan en escritorio y 320 px: contexto comercial,
aprobación/revisión/replay, dashboard y saldo parcial con scopes. No son pruebas
de cuentas externas ni de envío o cobro real. La validación actual del tramo
proveedores/abastecimiento se registra al final; este resultado histórico no la sustituye.

## Alcance y fuentes

Se inspeccionaron código, contratos, configuración de código y pruebas existentes.
No se leyeron `.env` reales, almacenes de autenticación, secretos ni valores de
variables del entorno; no se ejecutaron pruebas o llamadas externas para este
inventario. Sólo se crea este documento.

No se localizó la especificación original OPERACIONES en el workspace. Existe
[el audit histórico](../../scratch/audit-office-business-operations-20261011.md),
que corresponde a una revisión anterior y no sustituye esa especificación. Las
políticas de recorrido que siguen provienen del encargo actual; la evidencia de
implementación proviene del commit indicado y de
[commercial-flow.md](commercial-flow.md).

## Capacidades y conexión real

| Componente | Comprobado | Límite actual |
| --- | --- | --- |
| Motor de Office | `scriptedResponse` y `commercialScriptedDraft`; mensajes y borradores guardados. [commands.ts:9](../src/office/backend/commands.ts#L9), [commercial-fixtures.ts:54](../src/office/backend/commercial-fixtures.ts#L54) | Sin cliente de modelo, bucle de herramientas, modelo seleccionado, presupuesto ni medición de uso. Los [dependencies](../package.json#L27) tampoco incluyen un SDK LLM. |
| API privada de staging | Fastify: sesión, snapshot y comandos, con autorización antes de ejecutar. [http.ts:48](../src/office/backend/http.ts#L48), [http.ts:66](../src/office/backend/http.ts#L66) | No expone ingreso operativo de leads, disponibilidad, llamadas, pagos, webhooks de conectores ni worker. `OfficeCommand` sólo admite `draft/chat/approve/reject/cancel/revise`. [state.ts:48](../src/office/backend/state.ts#L48) |
| Persistencia | PostgreSQL con transacción, `FOR UPDATE`, historial y comandos append-only. [postgres-store.ts:92](../src/office/backend/postgres-store.ts#L92) | El estado validado es `simulation`, `syntheticOnly`, con tres casos de demo. [state.ts:73](../src/office/backend/state.ts#L73) |
| Contexto comercial | Hilos server-owned, con identidad, revisión, huella, mensajes y referencias; fuentes Gmail/Monday declaradas faltantes. [commercial-fixtures.ts:26](../src/office/backend/commercial-fixtures.ts#L26) | V1 sólo admite modo demo, destinatario `@invalid.test` y referencias simuladas/faltantes. No admite contexto real. [adapter.ts:72](../src/office/adapter.ts#L72) |
| Núcleo de operaciones | Funciones locales/importables y adaptador con actor, rol, evento y origen acotados. [pilot-adapter.mjs:96](../src/operations/pilot-adapter.mjs#L96) | `createPilotAdapter` rechaza modos distintos de `simulation`; una identidad y un closer compartidos. Ninguna función representa por sí sola una herramienta LLM autorizada. [pilot-adapter.mjs:61](../src/operations/pilot-adapter.mjs#L61) |
| Proyección live de leads | Existe `loadLiveSnapshot`: GET de staff y leads, excluye QA/teléfonos y conserva estados desconocidos. [adapter.ts:244](../src/office/adapter.ts#L244) | Está declarada dormida. OfficeApp usa `loadDemoSession/loadDemoSnapshot`, no esa proyección. [OfficeApp.tsx:3](../src/office/OfficeApp.tsx#L3) La presencia del código no prueba acceso al servicio. |
| Runtime | Compose tiene web privado y PostgreSQL de demo; rol por defecto `viewer`. [compose.staging.yml:16](../compose.staging.yml#L16) | No declara proveedor LLM/telefonía/Gmail/Monday ni servicio de seguimiento. Se inspeccionaron nombres y literales de código, no sus valores runtime. El `server.mjs` original sólo sirve estáticos y `/health`. [server.mjs:10](../server.mjs#L10) |

## Recorrido de operaciones: lo reutilizable y lo pendiente

| Etapa | Implementado en código | Pendiente para operación real |
| --- | --- | --- |
| Lead recibido | Captura inmutable, replay y conflicto de procedencia/fecha. [assignment.mjs:131](../src/operations/assignment.mjs#L131) | Ingreso autenticado y fuente fiable de captura. El adaptador piloto utiliza su reloj local para el fixture; `growth_v2.created_at` acredita registro PostgreSQL, no captura del proveedor. [pilot-adapter.mjs:139](../src/operations/pilot-adapter.mjs#L139), [adapter.ts:272](../src/office/adapter.ts#L272) |
| Closer activo y disponible | Perfil explícito: activo, departamento, turno, caducidad y capacidad compartida; reserva con aceptación/revalidación. Sin elegible, cola y excepción local. [assignment.mjs:68](../src/operations/assignment.mjs#L68), [assignment.mjs:96](../src/operations/assignment.mjs#L96) | Roster e identidad reales, estados visibles, servicio de asignación y entrega/acuse de escalamiento. La ausencia de capacidad debe poner la atención en cola; no constituye una prohibición de vender. |
| Intento de llamada y SLA 30 s | Vinculación de call ID a reserva aceptada/actor; verificación Ed25519, eventos idempotentes, ocurrencia y recepción separadas; inicio y respuesta separados. [telephony.mjs:117](../src/operations/telephony.mjs#L117), [telephony.mjs:163](../src/operations/telephony.mjs#L163) | No existe cliente que marque, webhook HTTP real, Google Voice, STT o prueba de contacto humano. La excepción de 30 s se calcula cuando se ejecuta una operación/evento; falta watchdog autónomo y entrega humana. [telephony.mjs:3](../src/operations/telephony.mjs#L3), [pilot-adapter.mjs:124](../src/operations/pilot-adapter.mjs#L124) |
| Seguimiento y cotización | Brief y respuesta guionados; cotización determinista en centavos con catálogo versionado sintético; artefactos y revisión exacta. [commercial-fixtures.ts:54](../src/office/backend/commercial-fixtures.ts#L54), [pilot-adapter.mjs:174](../src/operations/pilot-adapter.mjs#L174) | Sin catálogo/menú/precios reales, máquina de seguimientos, cadencia/planificador, condiciones de parada o canal entrante. La página queda `blocked_missing_generator`, sin HTML/URL. [drafts.mjs:179](../src/operations/drafts.mjs#L179) |
| Anticipo y saldo | Núcleo valida confirmación normalizada, factura/evento/proveedor/moneda e idempotencia; conserva total, pagado, saldo y recibos. [payments.mjs:218](../src/operations/payments.mjs#L218), [payments.mjs:267](../src/operations/payments.mjs#L267) | El caller debe autenticar al procesador; no hay gateway, firma/webhook de pagos o enlace de cobro real. Solicitud de cobro sigue siendo borrador y el saldo desconocido queda `null`. [drafts.mjs:187](../src/operations/drafts.mjs#L187) |
| Venta humana antes de sourcing de chef | Servidor bloquea acciones de Proveedores, salvo chat, si `saleClosed !== true`. [commands.ts:49](../src/office/backend/commands.ts#L49) | Cierre viene del fixture; falta un hecho/comando de cierre humano con identidad/evidencia. Liberar una asignación como completed no debe interpretarse como venta cerrada. No hay búsqueda/contacto/aceptación real de chef. |
| Pago sin chef aceptado | Pago y proveedor son independientes; excepciones y cola locales pueden reutilizarse. [pilot-adapter.mjs:251](../src/operations/pilot-adapter.mjs#L251) | No existe regla transversal que, al confirmar pago sin chef, abra alerta humana inmediata y cola con entrega/acuse. Las excepciones exponen `deliveryStatus: local_record_only`. |
| Coordinación/tasting, logística y supervisión | Funciones y checklists descriptivos/sintéticos. [functions.ts:6](../src/office/functions.ts#L6), [commands.ts:14](../src/office/backend/commands.ts#L14) | Sin calendario/tasting confirmado, rutas, inventario, proveedores logísticos, ejecución de checklist o supervisor conectado. La descripción de una función no acredita operación. |
| Calidad y finanzas | Checklists de calidad y reporte de conciliación semanal humana de sólo lectura. [commands.ts:18](../src/office/backend/commands.ts#L18), [payments.mjs:315](../src/operations/payments.mjs#L315) | Sin audio/transcripción permitidos, auditoría IA, evidencias de servicio/reseñas, conexión bancaria o cierre automático de excepciones. |

Hay dos métricas que deben permanecer explícitas: el núcleo Telnyx mide captura
→ inicio verificado, mientras `callTiming().met` exige captura → contacto humano
verificado. `call.answered` sólo demuestra que respondió la pierna del proveedor.
No se puede usar uno como evidencia del otro.
[telephony.mjs:181](../src/operations/telephony.mjs#L181),
[model.ts:20](../src/office/model.ts#L20).

El ledger distingue anticipo y liquidación. La proyección Office es más gruesa:
`readyForExecution` exige venta, `payment: verified` y proveedor aceptado con
evidencia, pero no comprueba importe/saldo. Antes de operación real hace falta una
política explícita sobre anticipo/saldo; `verified` no acredita liquidación.
[model.ts:33](../src/office/model.ts#L33).

## Permisos, contexto y aprobación

- Sesiones `viewer/operator`, caso y función se verifican en el servidor; una
  sesión sin Ventas no recibe contexto comercial. La identidad es un actor DEMO
  constante, no una identidad personal de staff. La sesión dura cuatro horas y
  su registro es en memoria. [session.ts:6](../src/office/backend/session.ts#L6),
  [session.ts:31](../src/office/backend/session.ts#L31),
  [session.ts:52](../src/office/backend/session.ts#L52).
- Basic de staging, proxy/host/HTTPS y Origin protegen este staging sintético. No
  constituyen IAM de ventas ni autorización de cuentas externas. El rol máximo
  se aplica al crear sesión. No se inspeccionaron sus valores de configuración.
  [http.ts:16](../src/office/backend/http.ts#L16),
  [http.ts:90](../src/office/backend/http.ts#L90).
- La política del piloto sólo concede `sales/finance` al actor DEMO, con los tres
  eventos de fixture, departamento `sales`, capacidad compartida de uno y
  proveedor `OFFICE_FIXTURE_PAYMENTS`. Las nueve funciones de interfaz no son
  nueve identidades o departamentos autorizados para ejecutar acciones reales.
  [pilot-core.ts:24](../src/office/backend/pilot-core.ts#L24).
- El navegador elige identidad/revisión/huella de un hilo; el servidor resuelve
  el contexto dentro del caso. No admite texto/destinatario/contexto arbitrarios
  para ese draft. [state.ts:54](../src/office/backend/state.ts#L54),
  [commercial-flow.md](commercial-flow.md).
- Cuenta, canal, destinatario, contenido, adjuntos, revisión y contexto completo
  quedan unidos a la huella. Editar requiere otra revisión/aprobación. Aprobar
  sólo registra `approved_demo`: el trabajo queda bloqueado y nunca acredita
  envío, pago, venta o aceptación de chef.
  [pilot-core.ts:20](../src/office/backend/pilot-core.ts#L20),
  [commands.ts:75](../src/office/backend/commands.ts#L75),
  [commands.ts:93](../src/office/backend/commands.ts#L93).
- Idempotencia de comando + digest y transacción impiden duplicar estados
  locales; payload diferente bajo la misma clave produce conflicto. Eso no
  resuelve por sí solo reintentos de consumo facturable de un proveedor.
  [commands.ts:35](../src/office/backend/commands.ts#L35).

No se encontraron las políticas de detener todos los seguimientos ante
respuesta, pago, rechazo o baja. Rechazar/cancelar sólo termina ese borrador.
`CommercialThread` no contiene canal; Office fuerza `email`. El núcleo vincula
el canal a la revisión pero no lo compara con el canal de entrada.
[contracts.ts:6](../src/office/contracts.ts#L6),
[commands.ts:64](../src/office/backend/commands.ts#L64),
[commands.ts:99](../src/office/backend/commands.ts#L99).

## Accesos de Codex frente a integraciones de la aplicación

El catálogo callable de esta sesión expone metadatos de herramientas de Gmail,
Monday, ElevenLabs, Autocalls y GitHub. **No se invocaron esas herramientas**.
No prueba identidad de cuenta, permisos, facturación ni conexión del runtime de
Office. No se identificó capacidad de Google Voice en el código o en el catálogo
callable inspeccionado. No hay cliente MCP que transfiera esas capacidades a la
aplicación. La verificación externa de cuentas y autorizaciones sigue pendiente.

## Siguiente implementación mínima y bloqueos de activación

El primer incremento puede integrar el draft comercial existente, una proyección
visible del recorrido y un generador inyectable **sólo sintético**, con DEMO por
defecto. Debe conservar la revisión actual, las nueve funciones y el caso como
unidad operativa; sin configurar proveedor ni crear un chatbot separado.

1. Resolver en servidor contexto y herramientas de lectura acotadas al actor,
   caso y función. Publicar hechos con procedencia/revisión y dependencias del
   recorrido; desconocido sigue desconocido. Un generador puede proponer texto,
   no decidir destinatario, canal, precios, pago, venta o disponibilidad.
2. Mostrar closer/cola, timestamps y métricas separadas, seguimiento,
   cotización, anticipo/saldo, cierre humano y sourcing, y pendientes de
   coordinación/logística/calidad. No bloquear la venta por capacidad ni
   presentar tareas de demo como eventos externos ejecutados.
3. Añadir políticas explícitas de parada de seguimientos y respuesta por el
   mismo canal; la nueva respuesta/pago/rechazo/baja debe detener trabajos
   pendientes. Contexto cambiado requiere nueva revisión. Pago sin chef requiere
   alerta humana inmediata y cola; una fila local no demuestra entrega.
4. Antes de contexto real: nueva versión de contrato, procedencia, autorización
   individual por cuenta/caso/canal y verificación read-only del conector. V1 y
   el agregado actual rechazan datos reales; no basta retirar un texto DEMO.
5. Antes de consumo facturable LLM/telefonía: elección/autorización de proveedor,
   modelo/ruta, cuenta, presupuesto/límites, manejo seguro de secretos en runtime,
   registro duradero de intentos/resultados/coste y política de reintentos. La
   generación externa no debe mantener el lock PostgreSQL durante la red;
   reservar el intento, generar fuera del lock y revalidar contexto al adjuntar.
6. Toda acción externa futura requiere autorización específica y revisión exacta
   de cuenta/canal/destinatario/contenido/artefactos, más estado de ejecución y
   evidencia de resultado. Esta implementación mínima nunca envía automáticamente.

## Cobertura existente consultada

Se revisó el contenido de las pruebas; no se ejecutaron en este inventario:

- [assignment.test.mjs:114](../tests/operations/assignment.test.mjs#L114): cola
  sin closer, capacidad compartida, replays, aceptación/caducidad y revalidación.
- [telephony.test.mjs:42](../tests/operations/telephony.test.mjs#L42): firma sobre
  bytes exactos, SLA con ocurrencia/recepción, límite de 30 s, answer distinto de
  humano, colisiones y atribución.
- [payments.test.mjs:78](../tests/operations/payments.test.mjs#L78): pagos parciales,
  doble entrega sin doble crédito, binding, overpayment y conciliación read-only.
- [drafts.test.mjs:144](../tests/operations/drafts.test.mjs#L144): desconocido distinto
  de cero, revisión exacta, invalidación y ninguna exportación de envío/publicación.
- [commercial.test.ts:74](../tests/office/commercial.test.ts#L74): contexto exacto,
  conflictos/casos cruzados, scope, aprobación y replay autoritativo.

Estas pruebas no demuestran conectores reales, watchdog, entrega de alertas,
contacto humano, parada de seguimientos ni facturación controlada.

## Operación remota completa: clasificación histórica por capacidad

En esta tabla, **implementada** significa código disponible dentro del alcance
indicado, que puede ser sólo núcleo local/DEMO. **Parcial** significa que existe
una pieza pero falta completar el recorrido. **No implementada** significa que
no se encontró una implementación en el checkout inspeccionado. **Bloqueada**
identifica una dependencia o restricción concreta que impide avanzar a esa acción;
no implica que exista un ejecutor listo. Ninguna fila acredita una cuenta remota
conectada o un resultado externo sin su evidencia. Las filas de sourcing y compras
describen el corte base; su alcance DEMO queda sustituido por el tramo actual al final.

| Capacidad | Estado comprobado | Evidencia y dependencia para completar el recorrido |
| --- | --- | --- |
| Calcular y versionar cotización | **Implementada: núcleo DEMO** | Centavos enteros, catálogo, impuesto y anticipo deterministas, revisión inmutable e invalidación de dependencias. [drafts.mjs:146](../src/operations/drafts.mjs#L146), [drafts.test.mjs:247](../tests/operations/drafts.test.mjs#L247). No acredita catálogo vigente, aceptación comercial o cotización real. |
| Convertir cotización a email HTML según los modelos reales | **No implementada; adaptación bloqueada** | El contrato de mensaje guarda `text`, canal, destinatario y artefactos, no un email HTML renderizado ni MIME. [drafts.mjs:223](../src/operations/drafts.mjs#L223). La revisión autorizada recuperó modelos de reunión/reprogramación y recibo; el segundo no es una propuesta pendiente. Sus originales HTML no están en este checkout. |
| Aprobar contenido exacto y dependencias | **Implementada: decisión interna DEMO** | Actor autenticado del piloto, revisión, destinatario/canal/texto y huella; una edición invalida aprobaciones. [drafts.mjs:282](../src/operations/drafts.mjs#L282), [commands.ts:93](../src/office/backend/commands.ts#L93). Aprobar no publica, envía, confirma pago ni cierra venta. |
| Generar y publicar página de propuesta | **Bloqueada: generador faltante; publicación no implementada** | `page_spec` conserva referencia exacta a la cotización pero `rendererStatus: blocked_missing_generator`, `html: null`, `url: null`. Una dependencia de esa página bloquea aprobación del mensaje. [drafts.mjs:179](../src/operations/drafts.mjs#L179), [drafts.test.mjs:259](../tests/operations/drafts.test.mjs#L259). |
| Enviar email y observar resultado de entrega | **No implementada; activación externa bloqueada** | No hay sender ni exportación de envío/publicación; el job aprobado permanece bloqueado. [drafts.test.mjs:287](../tests/operations/drafts.test.mjs#L287), [commands.ts:98](../src/office/backend/commands.ts#L98). Falta cuenta autorizada, acción separada, ejecución idempotente y resultado del proveedor. |
| SMS y seguimiento multicanal | **Parcial: borrador local** | Núcleo admite email/SMS/Slack y valida la forma del destinatario, pero no envía ni recibe mensajes. [drafts.mjs:204](../src/operations/drafts.mjs#L204). Office comercial genera email y no guarda canal de entrada. Faltan historial entrante autorizado, canal respondido, cadencia/horarios, recepción y entrega. |
| Detener seguimientos por respuesta/pago/rechazo/baja | **No implementada en la base inspeccionada** | Rechazo/cancelación terminan ese borrador; `followup` es un hilo inventado. [commands.ts:99](../src/office/backend/commands.ts#L99), [commercial-fixtures.ts:11](../src/office/backend/commercial-fixtures.ts#L11). Requiere estado de seguimiento, señales de parada y cancelación atómica de pendientes/reintentos. |
| Preparar solicitud de anticipo/saldo | **Parcial: borrador local** | Importe limitado por cotización/contexto financiero del servidor; saldo desconocido nulo, sin factura o URL emitida. [drafts.mjs:187](../src/operations/drafts.mjs#L187), [drafts.test.mjs:144](../tests/operations/drafts.test.mjs#L144). No equivale a cobrar ni a liquidación. |
| Generar página de pago y adjuntar el link correcto | **Bloqueada: generador/procesador no localizados** | El único page spec encontrado no genera HTML/URL; el payment request devuelve `invoiceId: null` y `paymentUrl: null`. No se encontró un generador existente reutilizable en fuente/docs/scratch permitidos. Falta su ubicación, contrato y evidencia de un link emitido para la cuenta/factura/evento/importe/moneda correctos. |
| Calendario y página de tasting | **No implementada** | La función describe organización y confirmaciones, pero el guion declara calendarios reales desconectados. [functions.ts:6](../src/office/functions.ts#L6), [commands.ts:14](../src/office/backend/commands.ts#L14). No hay adaptador de calendario, entidad de tasting, página renderizada o contrato de fecha/hora/zona/lugar verificados. |
| Sourcing continuo y base filtrada de chefs/coordinadores/closers | **No implementada como operación remota; parcial para elegibilidad local de closer** | Existe perfil de closer y selección por actividad, departamento, turno, vencimiento y capacidad. [assignment.mjs:68](../src/operations/assignment.mjs#L68). No existe directorio real conectado, búsqueda continua, filtros de chefs/coordinadores, verificación de aceptación ni worker de sourcing. La función Proveedores sólo describe el plan y exige venta humana. [functions.ts:8](../src/office/functions.ts#L8), [commands.ts:49](../src/office/backend/commands.ts#L49). Facebook Marketplace, Facebook Groups, outreach forms y MeetAChef son fuentes solicitadas, sin API o conector acreditado; su recorrido y aprobaciones se describen abajo. |
| Compras por Instacart y servicios similares | **No implementada; integración y ejecución externa bloqueadas** | Opciones solicitadas el 11 de octubre a las 15:49 UTC, no cuentas/API/conectores comprobados. Menú/cantidades validados → lista → opciones con dirección/ventana/coste total → aprobación específica → compra → recepción/recibos. No hay evidencia local de cliente de compras, pedido, recepción o conciliación de estos servicios. |
| Supervisión remota del evento | **No implementada** | Checklists y estados de coordinación/logística son sintéticos; un estado `running` del fixture declara que no hay worker. [fixtures.ts:35](../src/office/backend/fixtures.ts#L35). No hay supervisor asignado, recepción verificable de hitos/incidentes, check-in o confirmación de cierre del evento. |
| Auditoría operativa y de calidad | **Parcial** | Historial/command events append-only y huellas ofrecen trazabilidad local. [postgres-store.ts:108](../src/office/backend/postgres-store.ts#L108). Calidad no tiene audio/transcripción permitidos, evaluador de llamadas, evidencias de servicio ni revisión de resultados real. [functions.ts:10](../src/office/functions.ts#L10), [commands.ts:18](../src/office/backend/commands.ts#L18). |
| Alertas humanas, cola y escalamiento | **Parcial: registros locales** | Cola sin closer y excepción por inicio no verificado en 30 s; `deliveryStatus: local_record_only`. [assignment.mjs:96](../src/operations/assignment.mjs#L96), [pilot-adapter.mjs:124](../src/operations/pilot-adapter.mjs#L124), [pilot-adapter.mjs:252](../src/operations/pilot-adapter.mjs#L252). Falta entrega, acuse, responsable, plazo de escalamiento y regla inmediata de pago sin chef. |
| Finanzas, anticipo/saldo y conciliación | **Parcial: ledger y reporte locales** | Confirmaciones normalizadas, integridad y deduplicación, saldo y recibos; conciliación semanal exige revisión humana. [payments.mjs:83](../src/operations/payments.mjs#L83), [payments.mjs:320](../src/operations/payments.mjs#L320). No hay procesador/banco autenticado conectado, factura/link real ni conciliación bancaria ejecutada. |
| Optimización comercial/operativa | **No implementada como ciclo automático** | Marketing prepara hipótesis y no cambia campañas/presupuesto; faltan datos actuales de anuncios. [functions.ts:11](../src/office/functions.ts#L11), [commands.ts:19](../src/office/backend/commands.ts#L19). No hay métricas reales de envío/entrega/respuesta, pruebas de atribución o ejecución de mejoras. Cualquier recomendación debe seguir siendo borrador con evidencia y revisión humana. |
| Aperturas y clics de email/página | **No implementada** | No se encontró tracking, proveedor de eventos o modelo de métricas para estas señales. La existencia de un borrador/approval no prueba apertura/clic. No generar números, eventos o tasas sintéticos presentados como reales; ausencia de observación queda desconocida. |

## Modelos reales de reunión/recibo y generadores existentes

La búsqueda local no recuperó originales HTML en fuente/docs/tests o scratch
permitidos. Se buscaron también rutas y símbolos de plantillas/email/renderizado,
payment link/page, calendario/tasting, sourcing y supervisión. Esta revisión local
no consultó cuentas externas, Library, archivos de secretos ni adjuntos privados.
La auditoría autorizada de conversaciones/correo aportó posteriormente evidencia
de dos modelos reales: reunión/reprogramación y recibo. Se omiten nombres, correos,
importes y enlaces privados de clientes en el repositorio.

- **Modelos reales identificados por la revisión autorizada.** Estructura
  descrita: ancho 600 px, fondo crema, tarjeta blanca, dorado, títulos Georgia,
  cuerpo Arial y alternativa de texto plano. Esta descripción no sustituye la
  lectura de los originales. El modelo de recibo no debe utilizarse para afirmar
  un cobro en una propuesta pendiente.
- **Los ejemplos existentes son inventados.** `createCommercialThreads` crea
  hilos brief/followup con `Cliente sintético`, referencia `fixture:office-demo`,
  destinatario `@invalid.test` y Gmail/Monday faltantes.
  [commercial-fixtures.ts:9](../src/office/backend/commercial-fixtures.ts#L9).
  Aurora/Cedar/Harbor no sustituyen los modelos reales solicitados.
- **Generador de páginas existente: ubicación/evidencia faltante.** El código
  localizado conserva explícitamente `blocked_missing_generator` y URLs nulas.
  Esto no descarta que exista un generador en otro sistema; no hay evidencia
  local suficiente para adaptarlo o conectarlo. Un constructor de SPA o una
  página de formulario no acredita un generador de propuestas/pagos/tastings.

**Bloqueo concreto para adaptar esos modelos:** faltan los archivos HTML originales
en este entorno y la ubicación del generador reutilizable, con su contrato de uso.
No resolver el bloqueo fabricando una plantilla atribuida a un modelo real,
importando datos arbitrarios del navegador o declarando conectado un servicio que
sólo está mencionado. Puede continuar el vertical sintético autorizado, claramente
DEMO, sin afirmar que reproduce los modelos reales.

## Separación de acciones y evidencias exigidas

1. **Cotización y email:** la revisión debe unir brief, catálogo/revisión,
   cantidades, impuestos, anticipo/saldo, contenido HTML/texto renderizados y
   enlaces/adjuntos exactos. Preparar y aprobar son estados internos. Publicar
   requiere otra acción/resultado; enviar requiere cuenta/canal/destinatario y
   autorización específica. Cada resultado conserva su ID, tiempo y procedencia;
   `approved`, `published`, `sent` y `delivered` no son intercambiables.
2. **Seguimientos:** guardar el canal del último mensaje respondido y dirigir la
   siguiente respuesta a ese canal autorizado. Respuesta/pago/rechazo/baja detienen
   pendientes, incluso si ya estaban en cola para reintentar. No inferir permiso
   para otro canal porque exista teléfono/email. Parada y nueva revisión deben
   comprobarse inmediatamente antes de cualquier ejecución externa futura.
3. **Link y página de pago:** sólo usar una URL emitida/verificada por el sistema
   autorizado y ligada a cuenta, factura, evento, importe/moneda y revisión.
   Verificar estado/vigencia y representación del anticipo/saldo; enlazar otro
   evento, una URL inventada o una página sin factura verificada no es cobrar.
   Conservar el saldo desconocido como desconocido y esperar confirmación
   autenticada del procesador para acreditar fondos.
4. **Calendario/tasting:** el contrato necesita fecha, hora, zona IANA y lugar
   con fuente y confirmación verificables, además de disponibilidad y revisión.
   Las opciones propuestas permanecen pendientes. Generar una página, aprobarla,
   crear una reserva y enviar una invitación son acciones separadas; ninguna
   demuestra que el cliente o el responsable confirmó asistencia.
5. **Sourcing y supervisión:** vender precede al sourcing de chef; ausencia de
   capacidad genera cola/escalamiento sin prohibir venta. La base necesita roles,
   ciudad/área de servicio, criterios del evento, disponibilidad verificada,
   identidad y aceptación; desconocido no equivale a no disponible. Sourcing
   continuo necesita cadencia, deduplicación, stop/revisión y responsable. Una
   solicitud no equivale a aceptación y una asignación no acredita ejecución.
   Pago sin chef aceptado exige alerta humana inmediata con cola y acuse.
6. **Auditoría, métricas y optimización:** conservar hechos y resultados con
   trazabilidad y permisos; una evaluación IA de calidad sería provisional.
   Aperturas/clics sólo pueden publicarse con telemetría real y sus límites de
   interpretación; no equivalen a lectura humana, aceptación o pago. Proponer
   mejoras es independiente de aprobarlas/aplicarlas. La conciliación semanal
   sigue siendo humana; no cerrar excepciones financieras por una narrativa IA.

## Fuentes de sourcing y compras solicitadas a las 15:49 UTC

**Sourcing: no implementado como operación remota.** Facebook Marketplace,
Facebook Groups, outreach forms y MeetAChef son fuentes declaradas por el usuario.
No se ha verificado aquí su acceso, API, conector, cuenta o permiso de uso. El
recorrido exigido es fuente/link → candidato → evaluación humana → disponibilidad
verificada para el evento → condiciones aprobadas → asignación aceptada. La base
debe filtrar rol, área de servicio y criterios del evento, con procedencia y fecha
de cada dato. Un perfil encontrado no acredita identidad, disponibilidad ni
aceptación; un dato ausente permanece desconocido. Buscar chefs después de vender
sigue siendo la regla vigente y no impide la venta por falta de capacidad previa.

**Compras reales: no implementadas en este corte histórico ni activadas ahora.** Instacart y servicios similares son opciones
solicitadas, sin integración o cuenta acreditada. Primero se valida menú y
cantidades; después se prepara la lista revisionada y se comparan opciones con
dirección, ventana y coste total verificados. La aprobación específica precede a
la compra; recepción y recibos necesitan su propia evidencia. No se asumen
existencias, precios, sustituciones, entregas o condiciones aún no comprobados.
Un pedido aprobado no acredita compra, recepción ni gasto conciliado.

La presentación de formularios, el envío de mensajes y cada pedido requieren
aprobación específica ligada al contenido, destinatario/cuenta y condiciones
exactas. En compras incluye cesta, dirección, ventana, coste total y condiciones;
un cambio requiere otra revisión. Aprobar el plan o el borrador no ejecuta esas
acciones ni concede permiso permanente a una fuente o servicio.

## Corte histórico: porción propuesta a las 15:49 UTC

Documentos, contratos de datos y borradores sintéticos para los procesos de
sourcing y logística/compras de la [matriz](automation-traceability.md). Cada
registro conserva procedencia, revisión, responsable, estados separados y datos
faltantes. Los candidatos, links, menús, cantidades, direcciones y opciones del
ejemplo serán sintéticos y estarán marcados DEMO; los costes y la disponibilidad
no observados serán desconocidos. Formularios, mensajes y pedidos se preparan
como borradores para revisión humana. Esta porción no añade integración ni
realiza llamadas, visitas a fuentes, envíos o compras, y no se presenta como
capacidad terminada de aquel corte. La clasificación de propuesta pendiente queda
sustituida por el tramo DEMO persistente implementado que se documenta a continuación;
las integraciones y ejecuciones externas siguen pendientes.

## Tramo local actual: proveedores y abastecimiento DEMO persistente

Estado de este corte: **implementado en DEMO; QA local PASS**. Esta
ampliación sustituye las clasificaciones históricas de R08/R09/R19/R24 y procesos
9/10/11 de la base `ef2c9fa` para el alcance DEMO persistente; no acredita la versión
desplegada ni conectores activos. Se reutilizan
`OfficeState.office`, comandos, aprobaciones, historial y transacción PostgreSQL;
no se crea otro backend y las nueve funciones Office se conservan.

| Capacidad del tramo | Estado comprobado localmente | Cobertura y límites |
| --- | --- | --- |
| Contratos de cola, digests y candidatos | **Implementados en DEMO; QA local PASS** | [supply-contracts.ts](../src/office/supply-contracts.ts), [supply-fixtures.ts](../src/office/backend/supply-fixtures.ts) y [supply-workflow.ts](../src/office/backend/supply-workflow.ts). Cola de venta cerrada sin proveedor, ingestión/deduplicación y discrepancias de conteo visibles. Identidad sintética común entre casos; fuente/link, ciudad/cobertura, tarifa anunciada, moneda/unidad y fecha de lectura. Evaluación humana, disponibilidad y condiciones separadas. Límites de colecciones y recorrido de navegador cubiertos. |
| Selección revisable y asignación interna | **Implementadas en DEMO; backend PASS** | Snapshot de candidato/evento/condiciones en `supplyContext`, incluido por [computeApprovalDigest](../src/office/backend/pilot-core.ts). Revisión pendiente → decisión DEMO → registro separado de asignación interna; sin contratación externa. Motor revalida dependencias y bloquea solapamientos entre casos y una segunda asignación por caso bajo la transacción existente. Concurrencia, bindings y obsolescencia cubiertos; liberación/reprogramación no implementadas. |
| Menú/recetas/cantidades → lista → opción → revisión | **Implementado en DEMO; backend PASS** | Menú y cantidades requieren validación humana; la opción conserva dirección ficticia, ventana, moneda, cargos, total calculado y condiciones de sustitución. La revisión vincula menú/lista/opción completos; cambios y ventanas vencidas bloquean aprobación anterior. Cálculo, datos ausentes, invalidación y rollback cubiertos; aprobar nunca ejecuta pedido, pago o recepción. |
| Comandos y persistencia compatibles | **Integrados en Office; backend PASS** | [commands.ts](../src/office/backend/commands.ts), [state.ts](../src/office/backend/state.ts) y [postgres-store.ts](../src/office/backend/postgres-store.ts). Operación `supply` tipada bajo `action: draft`; decisiones usan los verbos existentes. Upgrade del agregado anterior sin reseedear. Permisos, durabilidad, idempotencia, rollback y concurrencia cubiertos. |
| Revisión visible y procedencia | **Panel y scopes integrados; QA local PASS** | [SupplyWorkflowPanel.tsx](../src/office/SupplyWorkflowPanel.tsx) muestra estados separados y datos exactos de selección/abastecimiento. [session.ts](../src/office/backend/session.ts) filtra sourcing y compras por función; lectura y revisiones obsoletas cubiertas en navegador. No se acredita contacto, disponibilidad real, contratación, pedido, entrega ni recibo. |

Las nuevas pruebas de [workflow](../tests/office/supply-workflow.test.ts) y
[PostgreSQL](../tests/office/supply-postgres.test.ts) cubren venta
previa, datos faltantes, scoping, digest, aprobación independiente de asignación,
compras sin ejecución, replay, upgrade y concurrencia. La ejecución local de QA
confirmó **198/198 pruebas backend Office PASS, cero skips**, **89/89 operaciones
PASS, cero skips**, typecheck final con salida **0** y ambas compilaciones **PASS**.
La revisión estática no encontró P0/P1.
Los reporters JSON confirman navegador base **8/8 PASS, cero skips** y navegador
sobre staging compilado **10/10 PASS, cero skips**. La suite de navegador Office
terminó con **72 casos recogidos, 71 PASS y un único skip preexistente**: referencia
de escritorio 1586×992 en el proyecto móvil. Resultado final: **cero fallos, cero
flaky y salida 0**. Las **8 pruebas de proveedores/abastecimiento** en escritorio
y móvil pasaron todas. `browser-qa-proof.json` y `source-freeze.json` del registro
local de QA conservan la evidencia y el freeze del código productivo. Se usaron
puertos aislados 4176/4181, estado legado único por corrida y estado de cada nueva
prueba de proveedores único por test; los ajustes del harness de historial no
modificaron el código productivo.
Esta edición sólo documenta resultados confirmados por QA; no ejecutó pruebas.
CI del SHA final y despliegue exclusivamente staging siguen pendientes de evidencia
posterior en este corte. Estos resultados no acreditan acceso a proveedores reales.

Los comandos del tramo aceptan IDs y decisiones sobre datos sintéticos propiedad
del servidor, no datos reales arbitrarios del navegador. La tarifa anunciada no
se convierte en condiciones aprobadas; asignación interna no acredita aceptación
externa y conserva `externalHired: false`. En compras, `externalOrdered`,
`externalPaid` y `externalReceived` permanecen falsos. Una fuente ausente sigue
desconocida, nunca se presenta como conectada por aparecer en un fixture.

Límites del tramo: 1000 selecciones y 1000 opciones históricas por caso. Un nuevo
registro por encima del límite devuelve `SUPPLY_RECORD_LIMIT`; no se borra ni
restaura historial para superar el límite. La reutilización de registros existentes
sigue permitida. Liberación/reprogramación de asignaciones y archivo de revisiones
no están implementados. Los fixtures de recetas y costes no acreditan inventario,
precios, impuestos o disponibilidad de un comercio real.

**Bloqueos de operación real:** siguen faltando acceso autorizado y datos reales
de las fuentes, cuentas/conectores, identidad y aceptación verificables, políticas
vigentes y ejecutores autorizados. Formularios, mensajes, contratos y pedidos
requieren aprobación específica. El usuario identificó una cuenta para preparar
OAuth de Monday después del tramo; identificarla no conecta OAuth ni concede
scopes. Ese trabajo queda separado, sin activación en esta ampliación.

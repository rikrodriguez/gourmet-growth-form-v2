# Monday: lectura y continuidad dentro del acceso existente

Base desplegada al iniciar: `cd72bc191a74fda67a6a7ee76b807ebd7361d7e3`. El lote prepara código y pruebas. La autorización posterior permite publicar y desplegar correcciones ordinarias exclusivamente en staging, tras pruebas y revisión, hasta el 12 de octubre de 2026 a las 14:00 UTC. La renovación automática permanece desactivada.

## Evidencia y límites

Ricardo observó conexión de Info (`78158865`), exactamente `boards:read`, `updates:read`, `me:read`, acceso de metadata a los cinco IDs y expiración el 13 de octubre de 2026 a las 03:19 UTC. La cuenta `29907909` continúa configurada sin acreditarse por OAuth. Una lectura real devolvió 100 ítems, cuatro páginas y `partial/page_limit` a las 03:20 UTC del 12 de octubre. Esto no acredita la oficina completa ni el total de Monday.

Los nombres fueron consultados mediante metadata de los cinco IDs el 12 de octubre de 2026: Lead Management, Deals, Catering Funnel, Catering Form y Quotes & Invoices. El digest de la proyección coincide con el mapping documentado: Lead tiene etapa, fecha, estado de cotización e importe; Quotes & Invoices sólo importe; los demás arrays están vacíos. El código debe derivar capacidades del mapping validado del runtime, nunca convertir este ejemplo en una ampliación de configuración.

## Restricciones

- Mantener cinco IDs para verificar metadata y sólo cuatro para registros: Deals `18411103560` está excluido de registros y actualizaciones.
- No ampliar los tres scopes, columnas comerciales ni datos sensibles; no consultar servicios reales en las pruebas.
- Mantener owner, CSRF, host/TLS, state, nonce, PKCE y validaciones de grants existentes.
- Campo mapeado nulo/blanco significa vacío; redacted significa oculto; campo fuera del mapping significa no consultado. Un formato incompatible permanece error.
- Ninguna etiqueta, incluida Conversion o Enviada, acredita pago, cierre, envío o documento. Un importe vacío no es cero y un importe sin moneda no acredita cobro.
- Los datos Monday conservan tablero/ítem, versión de mapping, lectura y actualización de origen; no se convierten en casos DEMO.
- Cada lote conserva 25 ítems por página, cuatro páginas y 100 ítems. Continuar requiere acción explícita, una sola lectura concurrente y un máximo de diez lotes por recorrido (40 páginas/1000 ítems); al agotarse, indicar cobertura parcial y detenerse.
- El cursor del proveedor nunca sale del servidor. Un handle aleatorio canónico de 43 caracteres sólo identifica un checkpoint cifrado y ligado a propietario, grant, tablero, tipo, mapping y plazo. No da acceso sin sesión/CSRF.
- Checkpoint con TTL local de cinco minutos, sin extenderse por continuación, y nunca posterior a la expiración del token. Como máximo un checkpoint por tablero/tipo; no crear claves ilimitadas por entrada del navegador.
- Mantener deduplicación y detección de ciclos entre lotes; invalidar continuidad al cambiar grant, mapping, tipo o tablero.
- No reintentar lecturas automáticamente. Ante rate limit, conservar sólo un checkpoint seguro y respetar el tiempo de espera; no ampliar tamaño de página ni lote.
- La espera del proveedor se conserva además en un único registro cifrado de lectura por propietario/configuración. Rige para lecturas nuevas y continuaciones de los cuatro tableros, incluso sin checkpoint o tras caducar su cursor. El servidor conserva el plazo real; el intervalo mostrado al navegador se limita a un día sin adelantar nuevas peticiones al proveedor.
- Renovación preparada pero desactivada en runtime de este lote. Caducidad tomada de `exp`, no un plazo fijo de 24 horas.

## Contratos

`MondayBoardCapability` contiene `id`, nombre verificado, fecha de verificación del nombre, `mappingVersion`, `commercialRead { enabled, reason, columns }` y `updatesRead { enabled, reason }`. Los motivos son fijos: disabled, forbidden_board o columns_unconfigured. Las columnas son sólo las validadas ya presentes en el mapping.

La disponibilidad de cada campo comercial es available, empty, redacted o not_queried, derivada de columnas recibidas y capacidades. La cobertura conserva status/reason/pages/readAt; el total del tablero permanece desconocido. `lastReadAt` sólo avanza si se verificó al menos una página del proveedor.

El cliente de lectura añade métodos de lote internos que devuelven `{ result, checkpoint }`. `checkpoint` nunca se devuelve al navegador. El servicio traduce ese checkpoint a `paging { nextBatch, expiresAt, pagesRead, itemsRead }`, sin cursor, tokens ni errores crudos. `nextBatch` nulo significa que no hay continuación admitida, no necesariamente que los datos estén completos: manda status/reason.

El POST de lectura acepta exactamente `{ boardId }` o `{ boardId, continuation }`. El resto, incluida una query o cursor suministrados por el navegador, sigue rechazándose antes de consultar el proveedor.

## Renovación preparada

Un scheduler server-only, por defecto `enabled:false`, revisa la caducidad de un grant conectado y verificado. Margen de renovación: 15 minutos; revisión cada minuto; una sola ejecución local y claim cifrado CAS compartido entre procesos. El servicio existente conserva el bloqueo de conexión y guarda la pareja nueva atómicamente tras validar scopes, identidad y tableros. Nunca reutiliza un refresh token cuyo resultado sea incierto.

Backoff acotado para contención o indisponibilidad antes de una acción admitida: 60 s, 120 s, 240 s, hasta 15 minutos. Cada intento requiere leer otra vez un estado válido; estados inciertos, tokens ausentes, cambio de grant o expiración suspenden el trabajo. Sin extensión de expiración tras éxito, detener renovaciones repetidas. El scheduler tiene cierre explícito y no expone una ruta para activarlo.

La activación futura requiere revisar el comportamiento y autorizarla por separado. Hasta entonces el grant desplegado mantiene renovación manual y su expiración observada sigue siendo operativamente relevante.

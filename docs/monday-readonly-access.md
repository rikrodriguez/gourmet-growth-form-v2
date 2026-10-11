# Acceso mínimo de lectura a Monday

## Estado del piloto

El piloto dispone de código para OAuth, almacenamiento cifrado, gestión del propietario y lectura acotada. El flag `MONDAY_OAUTH_ENABLED` está desactivado por defecto; habilitarlo exige una configuración válida. La preparación del código no acredita consentimiento efectivo, identidad comprobada con un token real ni acceso OAuth a los tableros. El 11 de octubre de 2026 Ricardo completó la configuración manual y autorizó habilitar staging, pero el runtime siguió indisponible después del despliegue. El diagnóstico de arranque descrito abajo permite identificar el primer campo rechazado sin revelar su contenido.

**Validación con fixtures:** las 16 pruebas HTTP pasan sobre las fuentes finales, incluido el callback HTTPS, el retorno sin Basic sólo para ese GET, host/TLS/peer, state, nonce y PKCE `S256`. Usan respuestas simuladas de OAuth y del lector; no acreditan consentimiento ni un recorrido OAuth remoto real en staging.

La autorización comprende exclusivamente `boards:read`, `updates:read` y `me:read` para los cinco IDs de tablero fijados abajo. La identidad elegida es **Info**, usuario `78158865`, email `info@gourmet-corp.com`. El plugin corroboró esos metadatos y la cuenta `29907909`; esa corroboración no es una conexión OAuth del runtime.

Los cinco IDs están fijados en el servidor: `18403945258`, `18411103560`, `18398057136`, `18396813878` y `18377848804`. El servidor comprueba el acceso efectivo del token a los cinco IDs antes de admitir la conexión y rechaza cualquier tablero ajeno. Los IDs no se resuelven por nombre ni se usan para inferir columnas.

Deals (`18411103560`) queda excluido de la lectura de registros y actualizaciones. Se conserva en la comprobación OAuth de metadata y acceso a los cinco tableros; esa comprobación no habilita sus registros ni comentarios.

## Identidad y alcance

El servidor solicita explícitamente los tres scopes y exige que el grant contenga exactamente ese conjunto, sin duplicados ni permisos adicionales. Consulta `me { id email }` y compara ambos valores con la política esperada. Después verifica los cinco IDs con una consulta fija de acceso a tableros. Estas dos comprobaciones, junto con la lista de campos y el aislamiento del propietario, constituyen la política de acceso del piloto. [OAuth y scopes](https://developer.monday.com/apps/docs/oauth), [Identidad propia](https://developer.monday.com/api-reference/reference/me).

La cuenta `29907909` se conserva como metadata configurada. El estado muestra `configuredAccountId`, `accountId: null` y `accountVerified: false`: no presenta la cuenta como acreditada por OAuth. No se requiere una prueba adicional de cuenta para este piloto. Consultar `account`, incluso dentro de `me`, requeriría `account:read`, que queda fuera del alcance autorizado. Tampoco se solicitan permisos de escritura, directorio o workspaces. [Cuenta](https://developer.monday.com/api-reference/reference/account).

## Configuración manual

Ricardo debe completar estos pasos en la aplicación y en la configuración privada del servidor. No se incluyen valores de credenciales ni comandos que los generen.

1. Crear o preparar la aplicación Monday para **Active For Me** y activar **New OAuth Flow** en la versión utilizada. Configurar únicamente `boards:read`, `updates:read` y `me:read`. El nuevo flujo utiliza PKCE con `S256`; la activación corresponde a cada versión de la aplicación. [Nuevo flujo OAuth](https://developer.monday.com/apps/docs/migrating-to-the-new-oauth-flow).
2. Registrar exactamente esta URL de callback, comprobada con fixtures HTTP, sin cambiar esquema, host, ruta o barra final:

   ```text
   https://office-staging.gourmet-corporation.com/office-api/monday/oauth/callback
   ```

   El servidor reutiliza esa misma URL en autorización y canje. La ruta está comprobada con fixtures; el registro externo y el retorno real aún no están verificados. [OAuth](https://developer.monday.com/apps/docs/oauth).
3. Introducir manualmente las variables siguientes mediante la configuración privada del servidor. Mantener `MONDAY_OAUTH_ENABLED=false` durante la preparación y publicación. Los secretos no deben aparecer en chat, repositorio, documentos, logs o capturas.

   | Variable | Configuración requerida |
   | --- | --- |
   | `MONDAY_CLIENT_ID` | Client ID de la aplicación autorizada. |
   | `MONDAY_CLIENT_SECRET` | Client Secret de esa aplicación; secreto sólo del servidor. |
   | `MONDAY_TOKEN_ENCRYPTION_KEY` | Clave creada y custodiada manualmente: 32 bytes aleatorios, codificados en base64 canónico de 44 caracteres. |
   | `MONDAY_OWNER_USERNAME` | Usuario manual del portal del propietario, separado del usuario Basic de staging; 3–64 caracteres alfanuméricos, punto, guion o guion bajo. |
   | `MONDAY_OWNER_PASSWORD` | Contraseña manual separada de la contraseña Basic de staging; 24–256 caracteres ASCII imprimibles sin espacios. |
   | `MONDAY_EXPECTED_ACCOUNT_EMAIL` | `info@gourmet-corp.com`. |
   | `MONDAY_EXPECTED_USER_ID` | `78158865`. |
   | `MONDAY_EXPECTED_ACCOUNT_ID` | `29907909`, metadata configurada sin verificación OAuth de cuenta. |
   | `MONDAY_BOARD_COLUMNS_JSON` | JSON conservador de cinco claves publicado abajo, con IDs y tipos comprobados; introducirlo como configuración del servidor. |
   | `MONDAY_OAUTH_ENABLED` | `false` durante la preparación y publicación; tras configurar, `true` permite iniciar el consentimiento únicamente en el origen de staging fijado. |

4. Introducir el JSON conservador siguiente en `MONDAY_BOARD_COLUMNS_JSON`, sin añadir campos ni columnas. Sus IDs y tipos ya se comprobaron directamente mediante `get_board_info`. El objeto contiene exactamente los cinco IDs de tablero como claves, cada uno con un array de objetos `{id, type, field}`. Una configuración mal formada mantiene la integración indisponible sin impedir el arranque DEMO. No asociar ítems reales a los casos DEMO.
5. Después de publicar staging con el flag apagado y completar la configuración manual, Ricardo podrá habilitar el flag, entrar en `/office/monday` con Basic de staging y después con la credencial separada del propietario, seleccionar **Conectar Monday** y consentir con la identidad Info. El servidor sólo declarará la conexión tras validar scopes, identidad y acceso a los cinco IDs. Comprobar en el portal las fechas de lectura, caducidad y alcance; una lectura parcial o bloqueada conserva ese estado explícito.

La credencial manual del propietario concede una capacidad de gestión: no verifica por sí sola la identidad personal de Ricardo. El principal interno `ricardo` es una etiqueta de esa capacidad. La identidad Monday seleccionada se comprueba por separado en el servidor mediante `me`.

## Mapeo comercial conservador

Los IDs y tipos de columna de este bloque proceden de lecturas directas de `get_board_info`. Es la configuración conservadora autorizada; documentarla no habilita un conector real ni acredita una lectura OAuth del runtime. Se mantienen las mismas fronteras de identidad y alcance.

```json
{
  "18403945258": [
    { "id": "color_mm1e35nf", "type": "status", "field": "stage" },
    { "id": "date_mm1ehb3s", "type": "date", "field": "event_date" },
    { "id": "color_mm5ggm58", "type": "status", "field": "quote_status" },
    { "id": "numeric_mm5gfyz5", "type": "numbers", "field": "amount" }
  ],
  "18411103560": [],
  "18398057136": [],
  "18396813878": [],
  "18377848804": [
    { "id": "amount", "type": "numbers", "field": "amount" }
  ]
}
```

| Tablero | ID | Lectura comercial configurada |
| --- | --- | --- |
| Lead | `18403945258` | `stage`, `event_date`, `quote_status` y `amount`, únicamente con las columnas del JSON. |
| Deals | `18411103560` | Array vacío; registros y actualizaciones excluidos. Sólo metadata de acceso para OAuth. |
| Funnel | `18398057136` | Array vacío; sin columnas comerciales configuradas. |
| Form | `18396813878` | Array vacío; sin columnas comerciales configuradas. |
| Quotes | `18377848804` | Sólo `amount`, columna `amount` de tipo `numbers`. |

Cada objeto tiene únicamente `id`, `type` y `field`, con IDs y campos únicos por tablero. Este bloque no incluye campos libres, contactos, archivos, enlaces ni otras columnas. Los arrays vacíos no habilitan lectura comercial de ítems. Sin mapeo utilizable, esa lectura devuelve `columns_unconfigured`; esto no impide conectar OAuth ni verificar identidad y acceso a los cinco tableros. La exclusión de registros y actualizaciones de Deals se aplica además del mapeo de columnas. Los valores incompatibles se rechazan y las etiquetas que parecen contactos, enlaces, credenciales o marcado se ocultan.

Las actualizaciones se leen sólo como metadata: IDs y fechas de creación, actualización y lectura. No se solicita ni expone el cuerpo de comentarios, autores o perfiles. Una etiqueta comercial no acredita pago, aceptación de un proveedor o cierre de venta.

## Frontera del servidor

| Componente | Comportamiento |
| --- | --- |
| [monday-runtime.ts](../src/office/backend/monday-runtime.ts) | Flag desactivado por defecto; no lee credenciales ni construye cliente, vault o store mientras está apagado. Una configuración inválida mantiene Monday indisponible y DEMO operativo. |
| [monday-owner.ts](../src/office/backend/monday-owner.ts) y [monday-http.ts](../src/office/backend/monday-http.ts) | Portal del propietario con capacidad separada de Basic, roles y scopes DEMO. Sesión de 15 minutos y desafío de login de 5 minutos; cookies `HttpOnly`, `Secure`, `SameSite=Strict`, control CSRF y límites de intentos. |
| [monday-oauth.ts](../src/office/backend/monday-oauth.ts) | PKCE `S256`, state de un uso de 5 minutos y nonce ligado al navegador. Canje, renovación y desconexión reservados de forma persistente antes de enviar solicitudes externas. |
| [monday-store.ts](../src/office/backend/monday-store.ts) y [003_monday_oauth.sql](../migrations/office/003_monday_oauth.sql) | Registros privados en `office_demo.monday_private_records`, separados del agregado DEMO; contenido cifrado AES-256-GCM con binding autenticado. Compare-and-set con revisiones globalmente crecientes evita carreras y reutilización de revisiones tras borrar y recrear. |
| [monday-read.ts](../src/office/backend/monday-read.ts) | Consultas GraphQL fijas de lectura, cinco tableros permitidos, columnas admitidas y API `2026-07`. No acepta consultas arbitrarias ni mutaciones. |

Una sesión ordinary viewer u operator DEMO, el selector de funciones y Basic por sí solos no autorizan gestionar ni leer Monday. Las rutas privadas exigen sesión del propietario; su ausencia, caducidad o credenciales rechazadas producen `403` con el código fijo `MONDAY_OWNER_UNAUTHORIZED`. La UI muestra el rechazo en la página, vuelve a comprobar la sesión y solicita un desafío CSRF nuevo si hace falta. Una comprobación CSRF inválida también produce `403`, conservando su código distinto. Basic ausente o incorrecto mantiene `401` y su desafío `WWW-Authenticate`; no se reutilizan las credenciales del propietario como Basic. Usar `403` separa el rechazo del propietario de la autenticación Basic del navegador. La tabla privada y sus tokens nunca forman parte de snapshots DEMO, respuestas para viewers o historiales comerciales.

Sólo el `GET` del callback exacto puede prescindir de Basic cuando la integración está habilitada y configurada. Mantiene los controles globales de host, TLS y origen, y exige state más nonce OAuth. Su cookie de nonce tiene `SameSite=Lax` para el retorno del proveedor, expiración de 5 minutos y ruta limitada al callback. El retorno termina con un redirect fijo al portal; no refleja códigos de autorización ni errores del proveedor. Con el flag apagado permanece protegida la frontera Basic. **Este comportamiento pasa las pruebas HTTP con fixtures; el retorno remoto real sigue pendiente del consentimiento.**

## Diagnóstico privado de arranque

[monday-diagnostics.ts](../src/office/backend/monday-diagnostics.ts) permite que el arranque registre una sola línea JSON cuando Monday está desactivado o su configuración resulta inválida. La salida contiene exclusivamente códigos fijos y nombres de campos de una lista cerrada: `code`, `field` y, cuando procede, `reason`. El primer fallo de validación determina el campo; corregirlo puede dejar al descubierto otro fallo en el siguiente arranque. No se registran valores, longitudes, hashes, fragmentos, mensajes de excepción ni stacks.

| Situación | Diagnóstico |
| --- | --- |
| Flag ausente o vacío | `{"code":"disabled","field":"MONDAY_OAUTH_ENABLED","reason":"missing"}` |
| Flag desactivado | `{"code":"disabled","field":"MONDAY_OAUTH_ENABLED"}` |
| Campo requerido ausente | `configuration_invalid`, nombre del campo y `missing`. |
| Formato rechazado | `configuration_invalid`, nombre del campo y `invalid_format`. |
| Credencial del propietario compartida con Basic | `configuration_invalid`, nombre del campo y `not_separate`. |
| Origen o identidad configurada fuera de la política | `configuration_invalid`, nombre del campo y `policy_mismatch`. |
| Excepción sin diagnóstico interno reconocido | `{"code":"configuration_invalid"}`. |

La metadata se asocia privadamente al error existente y se acepta para formato sólo cuando fue creada por el módulo. Un error ajeno, un objeto inventado o un getter hostil produce el código genérico sin inspeccionar su contenido. El flag apagado se diagnostica sin leer credenciales. Una configuración válida no genera una línea adicional ni realiza llamadas al proveedor o a la base de datos durante su construcción.

La línea se emite en el proceso de staging; no existe una ruta nueva para consultarla. Las respuestas HTTP conservan sus códigos y campos anteriores, incluidos Basic, la sesión separada del propietario y los controles de OAuth. Revisar únicamente esa línea en la administración privada permite corregir el campo señalado sin solicitar credenciales en chat. Publicar este cambio requiere un despliegue posterior autorizado; los fixtures no determinan qué campo falla en el proceso ya desplegado.

## Caducidad, errores y lectura limitada

El flujo usa los endpoints del nuevo OAuth para canje, refresh y revoke. El `exp` del JWT de acceso devuelto por el endpoint se utiliza exclusivamente para limitar la caducidad; no se usa un claim de cuenta como prueba de identidad o instalación, ni se afirma verificación de firma JWT. No se presupone una duración fija de acceso o refresh. La identidad y el acceso proceden de consultas autenticadas al proveedor. [Nuevo flujo OAuth](https://developer.monday.com/apps/docs/migrating-to-the-new-oauth-flow).

La renovación requiere tokens nuevos, comprueba de nuevo identidad y cinco tableros, y retira los anteriores. No hay llamadas externas dentro de transacciones SQL. Un resultado incierto de canje, refresh o revocación queda explícito como `code_exchange_uncertain`, `refresh_uncertain` o `revoke_uncertain`; no se repite automáticamente una operación OAuth cuyo resultado se desconoce. Tras reinicio tampoco se vuelve a enviar una operación pendiente.

**Desconectar Monday** retira las credenciales locales antes de pedir la revocación OAuth al proveedor, incluso si éste no confirma el resultado. La renovación y revocación sólo administran la conexión; no escriben tableros, ítems o comentarios. No existe un ejecutor de mutaciones de negocio de Monday.

Las lecturas usan páginas de 25 ítems, como máximo 4 páginas por solicitud, cursors internos de 5 minutos ligados a actor, tablero y versión del mapeo, timeout de 15 segundos y respuesta máxima de 256 KiB. Las actualizaciones se limitan a 20 por ítem; alcanzar ese límite se informa como parcial. El servidor valida estructura, IDs, tipos y errores GraphQL aunque el HTTP sea `200`, y conserva `complete`, `partial` o `blocked` junto con el motivo y, cuando procede, el tiempo de espera recomendado. No reintenta automáticamente las lecturas. [Límites de API](https://developer.monday.com/api-reference/docs/rate-limits).

El portal muestra únicamente la proyección filtrada, sin tokens, cursors, cuerpos de comentarios ni respuestas brutas del proveedor. Distingue `sourceUpdatedAt` de `readAt` y una lectura parcial de una completa dentro del límite consultado. Los datos no se incorporan a casos, aprobaciones o recibos DEMO; los casos sintéticos y su estado `mondayWrites: 0` mantienen su significado. La conexión no activa modelos ni envíos comerciales.

## Evidencia y pendientes

La documentación oficial de OAuth, nuevo flujo, `me` y `account` fue consultada el 11 de octubre de 2026; esa revisión acreditó el contrato público, no una instalación o grant reales. El código fija la URL de callback y las fronteras descritas arriba. Las 16 pruebas HTTP sobre las fuentes finales pasan con fixtures y proveedor simulado, sin llamadas a Monday. El resultado de publicación, CI y despliegue se entrega con evidencia de la revisión exacta; este documento no acredita una conexión real ni un callback remoto probado.

La configuración manual y el JSON conservador ya se guardaron en staging. Quedan identificar el motivo de indisponibilidad del runtime y, una vez resuelto, el consentimiento de Ricardo con Info. Los fixtures del diagnóstico acreditan sanitización y validación, sin leer esa configuración privada ni probar una conexión OAuth remota. La lectura comercial sin configurar sigue bloqueada. La cuenta sin acreditar por OAuth se informa con honestidad y no añade permisos ni una condición adicional al piloto de identidad más acceso a cinco tableros.

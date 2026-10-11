# Acceso mínimo de lectura a Monday

## Estado del piloto

El piloto dispone de código para OAuth, almacenamiento cifrado, gestión del propietario y lectura acotada. Permanece desactivado con `MONDAY_OAUTH_ENABLED=false`. La preparación del código no acredita una aplicación configurada en Monday, consentimiento efectivo, identidad comprobada con un token real ni acceso OAuth a los tableros. La publicación en staging debe conservar el flag apagado hasta que Ricardo complete la configuración manual y consienta la conexión.

**Validación con fixtures:** las 15 pruebas HTTP pasan sobre las fuentes finales, incluido el callback HTTPS, el retorno sin Basic sólo para ese GET, host/TLS/peer, state, nonce y PKCE `S256`. Usan respuestas simuladas de OAuth y del lector; no acreditan consentimiento ni un recorrido OAuth remoto real en staging.

La autorización comprende exclusivamente `boards:read`, `updates:read` y `me:read` para los cinco IDs de tablero fijados abajo. La identidad elegida es **Info**, usuario `78158865`, email `info@gourmet-corp.com`. El plugin corroboró esos metadatos y la cuenta `29907909`; esa corroboración no es una conexión OAuth del runtime.

Los cinco IDs están fijados en el servidor: `18403945258`, `18411103560`, `18398057136`, `18396813878` y `18377848804`. El servidor comprueba el acceso efectivo del token a los cinco IDs antes de admitir la conexión y rechaza cualquier tablero ajeno. Los IDs no se resuelven por nombre ni se usan para inferir columnas.

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
   | `MONDAY_BOARD_COLUMNS_JSON` | Mapeo manual de las columnas permitidas descrito abajo; puede quedar ausente mientras se configura OAuth. |
   | `MONDAY_OAUTH_ENABLED` | `false` durante la preparación y publicación; tras configurar, `true` permite iniciar el consentimiento únicamente en el origen de staging fijado. |

4. Confirmar los IDs y tipos reales de las columnas comerciales, su significado y su correspondencia con los campos permitidos. No inventar columnas ni asociar ítems reales a los casos DEMO. Si se proporciona el JSON, debe incluir exactamente los cinco IDs de tablero como claves, cada uno con un array de objetos `{id, type, field}`. Una configuración mal formada mantiene la integración indisponible sin impedir el arranque DEMO.
5. Después de publicar staging con el flag apagado y completar la configuración manual, Ricardo podrá habilitar el flag, entrar en `/office/monday` con Basic de staging y después con la credencial separada del propietario, seleccionar **Conectar Monday** y consentir con la identidad Info. El servidor sólo declarará la conexión tras validar scopes, identidad y acceso a los cinco IDs. Comprobar en el portal las fechas de lectura, caducidad y alcance; una lectura parcial o bloqueada conserva ese estado explícito.

La credencial manual del propietario concede una capacidad de gestión: no verifica por sí sola la identidad personal de Ricardo. El principal interno `ricardo` es una etiqueta de esa capacidad. La identidad Monday seleccionada se comprueba por separado en el servidor mediante `me`.

## Columnas comerciales pendientes

El mapeo admite como máximo 20 columnas por tablero, con IDs y campos únicos. Cada objeto debe tener únicamente `id`, `type` y `field`; no se admiten campos libres, contactos, archivos ni enlaces. Estos son los campos y tipos compatibles:

| `field` | `type` permitido |
| --- | --- |
| `stage` | `status` o `dropdown` |
| `event_type` | `status` o `dropdown` |
| `guest_count` | `numbers` |
| `event_date` | `date` |
| `service_style` | `status` o `dropdown` |
| `amount` | `numbers` |
| `quote_status` | `status` o `dropdown` |

Los IDs reales y el significado comercial de las etiquetas siguen pendientes de configuración humana. Sin mapeo, la lectura comercial de ítems devuelve `columns_unconfigured`; esto no impide conectar OAuth ni verificar identidad y acceso a los cinco tableros. Los valores incompatibles se rechazan y las etiquetas que parecen contactos, enlaces, credenciales o marcado se ocultan.

Las actualizaciones se leen sólo como metadata: IDs y fechas de creación, actualización y lectura. No se solicita ni expone el cuerpo de comentarios, autores o perfiles. Una etiqueta comercial no acredita pago, aceptación de un proveedor o cierre de venta.

## Frontera del servidor

| Componente | Comportamiento |
| --- | --- |
| [monday-runtime.ts](../src/office/backend/monday-runtime.ts) | Flag desactivado por defecto; no lee credenciales ni construye cliente, vault o store mientras está apagado. Una configuración inválida mantiene Monday indisponible y DEMO operativo. |
| [monday-owner.ts](../src/office/backend/monday-owner.ts) y [monday-http.ts](../src/office/backend/monday-http.ts) | Portal del propietario con capacidad separada de Basic, roles y scopes DEMO. Sesión de 15 minutos y desafío de login de 5 minutos; cookies `HttpOnly`, `Secure`, `SameSite=Strict`, control CSRF y límites de intentos. |
| [monday-oauth.ts](../src/office/backend/monday-oauth.ts) | PKCE `S256`, state de un uso de 5 minutos y nonce ligado al navegador. Canje, renovación y desconexión reservados de forma persistente antes de enviar solicitudes externas. |
| [monday-store.ts](../src/office/backend/monday-store.ts) y [003_monday_oauth.sql](../migrations/office/003_monday_oauth.sql) | Registros privados en `office_demo.monday_private_records`, separados del agregado DEMO; contenido cifrado AES-256-GCM con binding autenticado. Compare-and-set con revisiones globalmente crecientes evita carreras y reutilización de revisiones tras borrar y recrear. |
| [monday-read.ts](../src/office/backend/monday-read.ts) | Consultas GraphQL fijas de lectura, cinco tableros permitidos, columnas admitidas y API `2026-07`. No acepta consultas arbitrarias ni mutaciones. |

Una sesión ordinary viewer u operator DEMO, el selector de funciones y Basic por sí solos no autorizan gestionar ni leer Monday. Las rutas privadas exigen sesión del propietario; su ausencia produce `401` y una comprobación CSRF inválida produce `403`. La tabla privada y sus tokens nunca forman parte de snapshots DEMO, respuestas para viewers o historiales comerciales.

Sólo el `GET` del callback exacto puede prescindir de Basic cuando la integración está habilitada y configurada. Mantiene los controles globales de host, TLS y origen, y exige state más nonce OAuth. Su cookie de nonce tiene `SameSite=Lax` para el retorno del proveedor, expiración de 5 minutos y ruta limitada al callback. El retorno termina con un redirect fijo al portal; no refleja códigos de autorización ni errores del proveedor. Con el flag apagado permanece protegida la frontera Basic. **Este comportamiento pasa las pruebas HTTP con fixtures; el retorno remoto real sigue pendiente del consentimiento.**

## Caducidad, errores y lectura limitada

El flujo usa los endpoints del nuevo OAuth para canje, refresh y revoke. El `exp` del JWT de acceso devuelto por el endpoint se utiliza exclusivamente para limitar la caducidad; no se usa un claim de cuenta como prueba de identidad o instalación, ni se afirma verificación de firma JWT. No se presupone una duración fija de acceso o refresh. La identidad y el acceso proceden de consultas autenticadas al proveedor. [Nuevo flujo OAuth](https://developer.monday.com/apps/docs/migrating-to-the-new-oauth-flow).

La renovación requiere tokens nuevos, comprueba de nuevo identidad y cinco tableros, y retira los anteriores. No hay llamadas externas dentro de transacciones SQL. Un resultado incierto de canje, refresh o revocación queda explícito como `code_exchange_uncertain`, `refresh_uncertain` o `revoke_uncertain`; no se repite automáticamente una operación OAuth cuyo resultado se desconoce. Tras reinicio tampoco se vuelve a enviar una operación pendiente.

**Desconectar Monday** retira las credenciales locales antes de pedir la revocación OAuth al proveedor, incluso si éste no confirma el resultado. La renovación y revocación sólo administran la conexión; no escriben tableros, ítems o comentarios. No existe un ejecutor de mutaciones de negocio de Monday.

Las lecturas usan páginas de 25 ítems, como máximo 4 páginas por solicitud, cursors internos de 5 minutos ligados a actor, tablero y versión del mapeo, timeout de 15 segundos y respuesta máxima de 256 KiB. Las actualizaciones se limitan a 20 por ítem; alcanzar ese límite se informa como parcial. El servidor valida estructura, IDs, tipos y errores GraphQL aunque el HTTP sea `200`, y conserva `complete`, `partial` o `blocked` junto con el motivo y, cuando procede, el tiempo de espera recomendado. No reintenta automáticamente las lecturas. [Límites de API](https://developer.monday.com/api-reference/docs/rate-limits).

El portal muestra únicamente la proyección filtrada, sin tokens, cursors, cuerpos de comentarios ni respuestas brutas del proveedor. Distingue `sourceUpdatedAt` de `readAt` y una lectura parcial de una completa dentro del límite consultado. Los datos no se incorporan a casos, aprobaciones o recibos DEMO; los casos sintéticos y su estado `mondayWrites: 0` mantienen su significado. La conexión no activa modelos ni envíos comerciales.

## Evidencia y pendientes

La documentación oficial de OAuth, nuevo flujo, `me` y `account` fue consultada el 11 de octubre de 2026; esa revisión acreditó el contrato público, no una instalación o grant reales. El código fija la URL de callback y las fronteras descritas arriba. Las 15 pruebas HTTP sobre las fuentes finales pasan con fixtures y proveedor simulado, sin llamadas a Monday. El resultado de publicación, CI y despliegue se entrega con evidencia de la revisión exacta; este documento no acredita una conexión real ni un callback remoto probado.

Para completar la puesta en marcha quedan la configuración manual de la aplicación y secretos, el mapeo de columnas y el consentimiento de Ricardo con Info. El mapeo pendiente bloquea únicamente la lectura comercial sin configurar. La cuenta sin acreditar por OAuth se informa con honestidad y no añade permisos ni una condición adicional al piloto de identidad más acceso a cinco tableros.

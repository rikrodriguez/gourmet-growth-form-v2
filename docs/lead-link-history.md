# Historial de enlaces por lead y apertura explícita: candidato local

Base: PR 2, commit af269082aae51a5476d5345ded5eedb76d2c8682. Este lote compone
el normalizador previo en Guardadas del Dashboard, sin registrar una fuente real,
importar leads ni habilitar destinos reales. Incluye apertura explícita de
referencias autorizadas; sólo los fixtures sintéticos aportan esa composición.

## Qué muestra

- Calculator, AI Notes, AI Closer, FullURL y Quotes se conservan como categorías
  históricas con cuenta, tablero, ítem, columna o actualización, observación y
  fecha del cambio sólo cuando la fuente la aporta.
- Los parámetros originales, duplicados y una capa de sourceUrl permanecen
  exactos en el modelo restringido del servidor. No pasan al JSON ni al DOM del
  panel. Un destino autorizado sólo se entrega en Location tras un POST explícito.
- El panel muestra cantidades registradas en enlaces, una etiqueta de campaña
  únicamente cuando un catálogo confiable la reconoce, y presencia no vacía de
  UTM/identificador de clic Google/identificador de campaña Google, sin valores.
- Las señales no prueban visitas humanas, conversiones, ejecución de etiquetas,
  GA/GTM configurado ni atribución comercial confirmada.
- Missing y quarantined no muestran cantidades, campaña ni indicadores. Las
  discrepancias de identidad se apartan de las proyecciones operativas.

## Consulta conservada y acuerdo verificado

Un valor observado en una columna no demuestra que sea la primera consulta.
Por eso el normalizador usa column_snapshot y la vista recordedGuests, sin
inferir primera fecha o primera versión. Los enlaces de actualizaciones llevan
historical_update_link y no se presentan como solicitud inicial.

El panel separa estas consultas conservadas del último acuerdo verificado y
llama diferencia histórica a sus diferencias. No elige automáticamente una fuente
como correcta ni cambia invitados, menú, importes, cotizaciones o métricas.

VerifiedLeadAgreement es una entrada explícita de un adaptador autorizado que
ya verificó la conversación y seleccionó el último acuerdo. Este lote no lee ni
resuelve conversaciones. Una cotización o un enlace no crea un acuerdo. Hasta que
ese adaptador exista, el acuerdo debe ser null; nunca se completa por inferencia.
La primera consulta real podrá identificarse sólo con evidencia de procedencia
que demuestre ese carácter, manteniendo después las observaciones posteriores.

## Acceso y composición

DashboardPage acepta leadLinkAccessSource y leadLinkClient. Guardadas monta el
panel dentro del shell aprobado, tras las cotizaciones existentes. DEMO no lo
monta. El selector de lead es independiente del selector de evento y no relaciona
registros por nombre, sesión externa o coincidencia visual.

La fuente predeterminada devuelve unconfigured sin red. El usuario verifica una
identidad existente, elige un ID de lead permitido y pulsa Consultar. Seleccionar
un ID no consulta automáticamente. La proyección exige lectura explícita,
identidad opaca, scope completo y caducidad; el modo comercial exige identidad
duradera. La vida visible máxima es de 15 minutos.

Cerrar, cambiar lead, navegación, Back/Forward, ocultar, salir, cambiar fuente o
cliente, caducar o retirar la identidad cancelan solicitudes y retiran datos.
Una respuesta tardía de un adaptador que ignore abort no restaura la vista.
Restablecer identidad requiere otra verificación y consulta explícitas.

El cliente utiliza sólo una ruta de lectura same-origin y compara identidad,
organización, workspace, modo y lead antes de aceptar la respuesta. No transmite
una identidad en headers o query para adquirir autoridad. El contrato cerrado
rechaza propiedades adicionales, URLs en etiquetas, fechas imposibles y
procedencias incoherentes. Estas barreras del navegador son secundarias; el
servidor autentica y autoriza cada lectura. canRead no implica canOpen. El
contrato sólo expone referencias opacas de apertura y el token CSRF efímero de la
sesión autenticada cuando canOpen está habilitado; el cliente puede reducir ese
permiso, nunca ampliarlo.

registerLeadLinkRoutes/createLeadLinkApi ofrecen únicamente GET de un lead en
/api/office/lead-links/:leadId. El resolver debe pertenecer al mismo propietario
de identidad de la proyección Dashboard. Comprueba permiso, scope, lead y vigencia;
no tiene sesión, grant, lista pública, escritura, importación ni listener propio.
La identidad se comprueba otra vez después de esperar a la fuente. Los errores
son estáticos y las respuestas privadas usan no-store/no-referrer/nosniff.
La ruta NO se registra en los servidores DEMO ni staging. Para componer rutas
en otra instancia Fastify se debe instalar frameworkErrors:
leadLinkFrameworkErrors al construirla; createLeadLinkApi ya lo instala para
mantener estáticos también los errores de URL malformada previos al router.

## Privacidad y límites pendientes

El modelo normalizado contiene URLs, firmas, parámetros y posibles datos
personales. Debe guardarse exclusivamente en almacenamiento restringido del
servidor con cifrado, retención e idempotencia definidos. No se debe incluir en
logs, telemetría, fixtures reales, repositorios, bundles o respuestas sin filtrar.
Este lote no implementa almacenamiento ni migraciones para ese modelo.

La fuente read(scope, leadId) debe usar el mapeo autenticado exacto de
organización/workspace/modo y cuenta/tablero/ítem. El contrato HTTP no sustituye
ese mapeo. El normalizador y el proyector conservan la separación exacta de
cuenta/tablero/ítem; una sesión externa nunca es un UUID de lead interno.

Pendientes para datos reales: adaptador autorizado de columnas y actualizaciones,
keyword textual independiente, identificación fiable de consulta inicial,
resolución del último acuerdo verificado, mapeo interno por tenant/lead,
almacenamiento restringido append-only y composición con identidad existente.
Nada de esto se simula como completado por el panel.

## Apertura explícita de un registro exacto

Cada botón Abrir Calculator / AI Notes / AI Closer / Quotes es un formulario nativo
POST same-origin a /api/office/lead-link-open, target=_blank y
rel=noopener noreferrer. No usa fetch ni XHR para seguir destinos. Sólo envía
identityKey esperado, leadId, referenceId opaco, revision y csrfToken. No envía un
URL suministrado por el cliente. La identidad esperada evita reutilizar una vista
vieja en una sesión distinta y nunca otorga autoridad por sí misma.

El servidor exige identidad existente, canRead y canOpen, tenant y lead exactos,
CSRF ligado a esa sesión/scope y metadata de navegación same-origin/document con
activación de usuario. Como noreferrer/no-referrer puede generar Origin:null en
POST, null se acepta únicamente junto al token válido y toda esa conjunción;
no se acepta por sí solo. Navegadores sin esos encabezados fallan cerrados.

La observación se resuelve desde almacenamiento restringido mediante ID opaco y
revisión exacta; cuenta/tablero/ítem deben concordar con el mapeo interno confiable.
Se comprueban dos lecturas actuales, huella interna del contenido y tres lecturas
de identidad, con permisos, revocación y caducidad. Cambiar revisión, destino,
procedencia, tenant, lead o sesión bloquea la respuesta. El adaptador real debe
ofrecer una lectura consistente de revisión vigente e inmutable; este módulo no
inventa una transacción, un almacén ni un bloqueo que no existan. No puede revocar
un redirect ya emitido ni garantizar inmutabilidad después de la última comprobación.

La respuesta es 303, cuerpo vacío y Location con la cadena original aprobada:
no reordena parámetros, reconstruye firmas, agrega UTM ni reenvía el POST/CSRF al
proveedor. Incluye no-store, no-referrer y nosniff. El panel bloquea el segundo
submit de la misma fila hasta una nueva consulta, y muestra «Apertura solicitada»;
no afirma que el proveedor haya cargado correctamente.

### Política exacta de destinos

La auditoría guardada confirmó estas combinaciones públicas de categoría/origen/ruta:

- Calculator: https://monday.gourmet-corporation.com y /
- AI Notes: https://gourmet-corporation.com y /lead-ai/
- AI Closer: https://gourmet-corporation.com y /aisalescloser/
- Quotes: https://gourmet-corporation.com y cada archivo PDF exacto bajo /quote/

Los nombres reales de PDFs pueden contener datos personales. No están en el
repositorio, paquete ni fixtures: se deben cargar como entradas exactas de
configuración privada autorizada. No existe autorización de carpeta ni comodines.
Se comprobaron localmente 24 pares origen/ruta de la evidencia guardada sin red y
sin emitir sus nombres o valores privados; todos cumplen estas formas. Esto no
verifica vigencia de enlaces, firmas, consulta de páginas o sus efectos.

Sólo HTTPS y esas combinaciones configuradas son elegibles. Se rechazan
credenciales URL, hosts parecidos/subdominios extra/IP/localhost, puertos no
estándar, rutas ambiguas, traversal, caracteres de control/CRLF, parámetros
exteriores de redirección y claves doblemente codificadas. sourceUrl permanece
como evidencia y nunca se sigue ni se promueve a destino. Las URLs aceptadas se
emiten intactas. FullURL/atribución, enlaces de actualizaciones, missing y
quarantined no reciben controles de apertura.

### Límites de navegación y composición

No hay fetch de destinos, resolución DNS, previews, iframes, tracking, prefetch,
beacons ni métricas de clic añadidos. Una apertura voluntaria sí transmite al
proveedor la URL original y sus parámetros; ese sitio puede registrar la visita,
usar sus propias cookies y redirigir. El navegador puede conservarla en historial.
La lista de destinos controla el primer salto, no el DNS ni redirects futuros de
un sitio ajeno. La interfaz lo explica antes de abrir.

createLeadLinkOpenApi/registerLeadLinkOpenRoutes son opt-in. La factory usa logger
false y errores estáticos; un host que componga la ruta debe aplicar
leadLinkOpenFrameworkErrors y excluir cuerpos, CSRF y Location del logging,
proxy y APM. No se guardan URLs, firmas o parámetros en errores.

No se han registrado estas rutas en DEMO/staging. El host existente exige JSON y
Origin exacto en sus POST, su cookie DEMO tiene otro Path y su CSP incluye
form-action 'self'. Esos controles permanecen intactos. La composición operativa
requiere una identidad compatible y comprobar navegación con la CSP real; no se
amplía CSP a comodines ni se cambian cookies o autenticación. La apertura no queda
habilitada en runtime por añadir el código.

No se modifican workflows, cuentas, credenciales, Monday, clientes, cobros ni
despliegues. Los datos reales siguen sin importar ni persistir.

### Referencias técnicas

HTML define noreferrer/noopener también para formularios:
https://html.spec.whatwg.org/multipage/links.html#link-type-noreferrer

Fetch explica Origin:null bajo política no-referrer:
https://fetch.spec.whatwg.org/#append-a-request-origin-header

303 cambia la navegación a recuperación del recurso indicado, sin reenviar el body POST:
https://www.rfc-editor.org/rfc/rfc9110.html#name-303-see-other

La política Referrer-Policy del redirect se aplica al siguiente salto:
https://www.w3.org/TR/referrer-policy/#set-requests-referrer-policy-on-redirect

## Pruebas

Los fixtures usan exclusivamente datos, firmas y tokens ficticios. El
normalizador usa dominios reservados; la validación de destinos usa los orígenes
públicos revisados con parámetros y rutas sintéticos, sin contactarlos. Las pruebas unitarias,
SSR y Fastify inject cubren preservación, aislamiento, cuarentena, separación
histórica/acuerdo, parámetros Google vacíos, permiso por lead, respuestas
cerradas, expiración, retiro y cancelación. La matriz de apertura agrega
IDOR/tenant/sesión, CSRF, revisión obsoleta/cambiada, open redirect, CRLF, URLs
de usuario y destinos no permitidos. No necesitan sockets.

    npm run typecheck
    npm run build
    npm run office:build
    npm run test:operations
    node --import tsx --test tests/office/lead-link*.test.ts* tests/office/dashboard-lead-links.test.tsx

El fixture explícito /office/lead-link-history-demo.html monta DashboardPage real
con fuente/cliente sintéticos; no es una ruta de autenticación comercial ni entra
en el bundle de producción. Sus pruebas están incorporadas al testDir existente
sin cambiar workflow. El caso de apertura utiliza formulario nativo → handler
Fastify real mediante inject → 303 → destino sintético interceptado, con todo
tráfico externo bloqueado. Ningún proveedor se contacta durante la prueba:

    npm run test:dashboard:e2e -- lead-link-history.spec.ts

Las nuevas interacciones de navegador no se ejecutaron localmente porque
Chromium ya tenía un bloqueo de sockets; no se reintentó por otra ruta. Listar
las pruebas sólo valida descubrimiento, no comportamiento. La validación de CI y
las capturas nuevas requieren publicar este alcance autorizado. El CI verde de
la base af269082 no verifica este lote local.

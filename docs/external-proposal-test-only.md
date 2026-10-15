# Propuesta externa: primer corte TEST_ONLY

Base verificada: PR2 abierto y en borrador, head `faa7001ef26b8aa8ca0419b191b59c57ffba13ff`. Este corte añade un contrato de documento, un servicio opt-in y un panel de revisión. No añade otro editor ni convierte la propuesta en `QuoteVersion`, tarifas, importes, aprobación comercial o métricas.

## Flujo y límites

1. Verificar la identidad existente del fixture y consultar un lead explícito en `LeadLinkHistorySection`.
2. La composición de prueba proporciona el evento exacto. El servicio comprueba la revisión activa del vínculo de `CanonicalBridge`, sus referencias lead/evento y la procedencia normalizada con `lead-link-history.ts`. No se empareja por nombre ni por sesión externa.
3. `PersistedQuoteWorkspace` conserva su brief/editor existente. Un slot opcional inserta el panel separado de propuesta; cambiar el brief retira la revisión. Los consumidores existentes sin slot conservan su comportamiento.
4. Consultar y asociar manualmente la versión de un proveedor sintético confiable. El servicio recibe texto UTF-8 y calcula SHA-256; el navegador verifica de nuevo esos bytes y los muestra como texto escapado, sin HTML ejecutable.
5. Revisar contenido, versión, destinatario y vínculo, y aprobar exclusivamente de forma interna. Aprobar no envía documentos, acredita aceptación, confirma disponibilidad ni autoriza ninguna acción externa.

Una URL no se consulta ni se previsualiza. Si el proveedor no ofrece contenido verificable se conserva `reference_only`, con hash nulo y aprobación bloqueada. Una URL histórica con IDs contradictorios se rechaza incluso si el proveedor proporciona texto. Las URLs no salen en la respuesta del servicio ni en el panel.

## Corrección de integridad de la revisión

La revisión independiente encontró un defecto en `1f104a6de3c07f651abddc5b6d58dfcecdfaa6ed`, reproducido antes de corregirlo con el cuerpo real del validador del panel y el servicio real del fixture: cambiar sólo `snapshot.intendedRecipient` a `shown-to-reviewer@example.test`, conservando contenido, SHA-256 y reviewKey, devolvía `true`. El servicio aceptaba approve y conservaba `client@example.test` como destinatario aprobado. El hash de contenido no vinculaba por sí solo todos los campos mostrados al revisor.

Ahora el parser exige las claves y tipos exactos de respuesta, scope, snapshot, procedencia y aprobación; rechaza campos extra/ausentes, getters, estados imposibles y permisos incoherentes. Construye valores separados antes de cualquier await. El servicio y el navegador comparten `serializeExternalProposalReview` en el contrato: JSON UTF-8 sin espacios, orden fijo de IDs lead/evento/propuesta, proveedor, versión, contenido, hash, procedencia completa, bindingDigest, briefDigest, destinatario y revisión de asociación. reviewKey se excluye del payload y debe coincidir con SHA-256 de esos bytes. También se verifica el hash independiente del contenido. El panel sólo muestra la copia validada y habilita la revisión de esa copia.

Las regresiones alteran destinatario, versión, cada campo de procedencia, briefDigest y bindingDigest manteniendo la clave original. En navegador deben cerrar el panel, retirar la casilla y el botón y no emitir approve; el servicio sigue pendiente. Se cubren también respuestas válidas, orden distinto de claves en transporte, reference_only, esquema inválido y mutaciones del adaptador durante el hash. Una huella pública no autentica al proveedor: si alguien recalcula una clave para un snapshot alterado, el servicio debe rechazarla por no coincidir con su snapshot confiable. Esta corrección no añade identidad, transporte comercial ni persistencia.

La huella de revisión incluye IDs explícitos de lead/evento/propuesta, versión del proveedor, hash del texto, procedencia, digest de vínculo canónico, digest del brief guardado, destinatario y revisión de asociación. Cualquier diferencia deja obsoleta la aprobación; una nueva asociación exige otra revisión aunque los bytes sean iguales. Reutilizar una versión del proveedor con bytes diferentes se rechaza. Antes de escribir se releen documento, vínculo e identidad; un permiso retirado o vencido durante I/O impide el commit. Las revisiones esperadas y claves idempotentes controlan concurrencia y reintentos exactos.

El servicio sólo admite ámbitos `test`. Recibe proyecciones de las identidades existentes de historial y cotizaciones, además de una asignación de evento y fuente del servidor. No crea accesos ni credenciales. El store de memoria serializa escrituras y permite recuperación al reconstruir el servicio y después de perder una respuesta de commit. **No persiste tras reiniciar el proceso**. No se afirma durabilidad productiva ni atomicidad distribuida entre autoridad, proveedor y puente: la composición real necesitará transacciones/locks o revisiones condicionales equivalentes. El proveedor sintético es una dependencia confiable; no se acepta texto ni hash desde un formulario del cliente.

## Demostración reproducible

```
npm ci --cache /tmp/gourmet-npm-cache --no-audit --no-fund
node --import tsx tests/external-proposal-browser/server.ts
```

Abrir `http://127.0.0.1:4196/tests/external-proposal-browser/index.html`. La página y su middleware existen sólo bajo `tests`; no se incluyen en los builds comerciales. Usar «Verificar acceso al historial», elegir `demo-history-a`, consultar el historial y luego la propuesta externa. Asociar, revisar y aprobar. Los controles superiores simulan documento v2, referencia sin contenido, retirada de permiso, respuesta tardía, pérdida de respuesta y reconstrucción del servicio. También se puede cambiar y guardar el destinatario en el editor existente. Todos los datos son sintéticos y los servicios de la demo escuchan sólo en loopback.

```
node --import tsx --test tests/office/external-proposal.test.tsx
npm run test:external-proposal:e2e
```

Las pruebas de navegador ejecutan el flujo en escritorio y móvil, verifican ausencia de solicitudes a otros hosts y conservan PNG de aprobación, versión obsoleta y `reference_only` en `test-results/dashboard-visual/`. La prueba del adaptador tardío ignora AbortSignal a propósito: cambiar de lead o retirar acceso debe impedir que su respuesta restaure contenido.

## Conexión real pendiente

No se consultó ni modificó Hostinger, Monday, Gmail, Voice o Payments. Tampoco se cambian los servidores normales, su registro de rutas, configuración de proveedores o secretos. El workflow de publicación de form2 permanece idéntico; la rama nueva sólo se incorpora a los guards explícitos del CI de verificación con permisos de lectura.

Antes de conectar Hostinger hace falta, con autorización separada:

- Verificar cómo exporta/entrega el documento existente y su versión estable. Una URL o captura no prueba el contenido; se necesita una fuente autenticada y revisada de los bytes, con contrato de versión inmutable. No se ha supuesto que exista una API concreta.
- Mapear organización, workspace, actor, lead y evento a IDs de fuente comprobados; reutilizar identidad, CSRF y permisos existentes con revocación y vencimiento. El adaptador debe ejecutar la autorización y la escritura en una transacción durable o con condiciones equivalentes, y proteger los cambios simultáneos del vínculo y brief.
- Añadir un store durable con auditoría, inmutabilidad, CAS/idempotencia, aislamiento, cifrado y recuperación tras caída real del proceso; probar autorización y documento exactos a través del transporte real. El store de memoria de este corte no satisface esos requisitos.
- Revisar el formato real y límites del documento, el transporte de sólo lectura, la retención y las políticas de navegación. Seguir sin fetch ni preview automático de URLs arbitrarias. La integración no necesita duplicar el editor de origen.

Envío, aceptación del cliente y cualquier integración de Payments quedan fuera de este corte. No se fusiona ni despliega.

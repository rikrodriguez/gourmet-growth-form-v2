# Propuesta externa dentro del Dashboard existente · TEST_ONLY

Corte mínimo sobre PR7 `72029ce465516871a1d386cb52552cb3217f6794`. El recorrido ahora se compone dentro de `DashboardPage`, en `/office/dashboard#quotes` y Guardadas. No añade un editor ni otro panel de propuesta. `LeadLinkHistorySection.renderForLead` monta una sola instancia de `PersistedQuoteWorkspace`; su slot `externalProposal` muestra `ExternalProposalPanel`. Con la composición presente se omite el montaje independiente de cotizaciones guardadas. El resto de la navegación conserva sus cierres existentes.

`createTestProposalDashboardIntegration` es una dependencia optativa. No inicia sesiones ni hace lecturas al crearse o al montar el Dashboard. Después de la verificación manual consume el acceso existente de PR7: exige identidad durable, modo test, un solo lead autorizado, sin apertura de URLs, y los tres IDs explícitos del servidor. El lead del target debe coincidir con el grant; no deriva evento/propuesta por nombre o sufijo. Copia la proyección y liga cada operación a identidad, ámbito, target, caducidad y generación vigentes. Una respuesta tardía no puede reponer un contexto retirado. Reutiliza la validación del historial y la verificación completa de contenido, metadatos y hash del panel.

El host aporta el transporte de lectura del brief y la suscripción a retirada de acceso. La composición bloquea todas sus escrituras de cotización y sólo admite status test de lectura, sin efectos externos. El panel se desmonta cuando el brief está modificado y su revisión se reinicia al cambiar el digest guardado. La autoridad transaccional de PR6/PR7 sigue siendo la que decide associate/approve y rechaza revisión, permiso, destinatario, documento o vínculo obsoletos. La aprobación sigue siendo interna, sin envío ni aceptación del cliente. Las pruebas de regresión previas cubren reference_only, hash, destinatario, brief, vínculo, idempotencia y recuperación.

## Entrada normal y fixture

`src/office/main.tsx` continúa montando `<DashboardPage />` sin esta dependencia. Los servidores normales no registran `createTestProposalApi`; no se cambian cookies, credenciales, roles, permisos ni bases comerciales. No hay una bandera de producto que convierta una sesión DEMO en identidad durable.

El supervisor de prueba ya existente se reutiliza con `PROPOSAL_DASHBOARD_FIXTURE=1`. Esa opción selecciona exclusivamente el HTML de fixtures y el segundo expediente sintético en el servidor local; no otorga autoridad a las APIs. En 127.0.0.1:4194, `/office/dashboard` carga el Dashboard real con la dependencia inyectada; `?plain=1` carga el entrypoint normal, cerrado. Los únicos endpoints de propuesta siguen siendo los cuatro de PR7, `/api/office/test-proposals/{access,history,proposal,commands}`, con origen loopback, CSRF y revisión de identidad existentes. Los endpoints `__durable-*` son controles/lecturas del harness, nunca rutas del producto.

Cada expediente A/B tiene los mismos fixtures de autoridad preexistentes, en namespaces aleatorios separados, reutilizando la prueba de sesión y vault sintéticos existentes. Cambiar lead en el control del servidor cierra el proceso API y selecciona el otro target/namespace; el navegador retira el contexto y exige verificar otra vez. Se prueba ese cambio explícito de contexto, no un listado comercial de múltiples leads en una sesión. No se amplía la API de caso único para convertirla en un directorio. Cada lectura/escritura vuelve a pasar por las comprobaciones SQL de sesión, membresía y grants del expediente activo.

Reiniciar conserva los namespaces del expediente activo, espera salida 0 y Pool cerrado y abre un PID/Pool nuevos. Reset y cierre final limpian ambos fixtures por separado. La revisión antigua recibe 403 incluso si el documento/aprobación recuperados son idénticos. Los controles de versión y permisos sólo alteran esos fixtures.

## Ejecutar y aceptar

```
npm run office:db -- start
PROPOSAL_DASHBOARD_FIXTURE=1 node --import tsx tests/external-proposal-durable-browser/server.ts
```

Abrir `http://127.0.0.1:4194/office/dashboard#quotes`. Verificar historial, elegir el ID autorizado y consultar historial. En el mismo workspace, consultar propuesta, asociar versión, revisar contenido/destinatario/vínculo y aprobar internamente. Usar los controles sintéticos para cambiar de lead, versión o permiso y para reiniciar la API. Todos los clientes y documentos son ficticios. No se consultan Hostinger, Monday, Gmail, Voice ni Payments.

```
node --import tsx --test tests/office/dashboard-external-proposal.test.tsx
npm run test:external-proposal:dashboard:e2e
```

Las 16 pruebas del Dashboard en escritorio/móvil verifican: entrada normal cerrada y sin petición de integración; una sola instancia; cierre existente al actualizar muestra; cambio A→B con respuestas tardías de propuesta e historial; rechazo de aprobación A en B; versión obsoleta; retirada/restauración de permisos; y recuperación exacta tras un PID distinto. Seis pruebas adicionales cubren el contrato y la retirada del adaptador, incluyendo 12 proyecciones inválidas. Capturas en `test-results/dashboard-visual/*-dashboard-proposal-*.png`; logs `DASHBOARD_PROPOSAL_LEAD_ISOLATION`, `DASHBOARD_PROPOSAL_RESTART_EVIDENCE` y `DASHBOARD_PROPOSAL_POST_RESTART_INVALIDATION`, sin tokens.

## Dependencias comerciales pendientes

Para conectar Hostinger de verdad falta identificar y aprobar el adaptador del dueño de la sesión durable existente hacia `ExistingQuoteSession`, con tenant/workspace/actor y retirada/expiración reales. `/office-api/session` es DEMO y su cookie usa Path=/office-api; no prueba esa identidad ni se debe reutilizar a ciegas para `/api/office`. También faltan el vínculo autorizado de IDs, contenido/versiones inmutables de un proveedor confiable autorizado, y la revisión de schema/vault/lifecycle comercial. La composición actual y su almacenamiento rechazan modo comercial.

Cualquier acceso a datos/proveedor reales, habilitación de rutas comerciales, cambio de credenciales/permisos, merge o despliegue exige un alcance adicional. Este PR sólo publica código y pruebas en borrador y ejecuta CI de lectura, sin publicar artefactos de form2 ni modificar su workflow.

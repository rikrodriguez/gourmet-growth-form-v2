# HTTP y panel durable: recorrido TEST_ONLY

Corte sobre PR6 `72b4d9bf6b57ab887a74a91e15555e5f07bd4c06`. Conecta la composición durable al panel y slots existentes, exclusivamente en un harness aislado. Los servidores normales no registran el adaptador y las rutas comerciales siguen cerradas.

## Hallazgos verificados antes del cambio

- El contexto fijo `synthetic-test-identity` de la demo de memoria no coincide con la identidad durable: el validador real rechaza la respuesta.
- Se obtuvo una revisión HMAC real que empezaba por `-`; incluso con contexto coincidente, el parser la rechazaba. Base64url también admite `_` al principio. No se relajan los parsers.
- El control anterior reconstruye el servicio de memoria en el mismo PID y conserva el mismo store. No prueba reinicio de proceso. `durableProposalFixture.close()` efectivamente elimina los schemas antes de cerrar el Pool.

La proyección nueva usa `proposal-<accessRevision>` en acceso, historial y propuesta. El prefijo es una identidad no secreta de aislamiento/caché y no concede permisos. La revisión raw existente de cotizaciones no cambia. Las pruebas cubren los 64 caracteres iniciales posibles de base64url, incluidas `-` y `_`, y confirman que los valores raw inseguros siguen rechazados por los parsers estrictos.

## Conexión mínima

`createTestProposalApi` es opt-in, exige origen HTTP de loopback y un resolver de prueba de sesión existente. No crea sesiones, cookies, claves, permisos ni schemas. El target fijo sigue siendo del servidor; el cliente no puede enviar actor, ámbito o target alternativo.

- `GET /api/office/test-proposals/access`: acceso autorizado, target fijo y el CSRF de la sesión sintética existente.
- `GET .../history`: historial normalizado sin URLs, con la misma identidad; no hay apertura de destinos.
- `GET .../proposal`: snapshot durable para revisión explícita.
- `POST .../commands`: sólo associate/approve; origen, tipo JSON, CSRF existente y revisión de identidad obligatorios. La comparación de identidad se realiza dentro de la transacción de autorización antes de escribir.

Las respuestas usan no-store y no hay fetch/preview automático de URLs externas. Una versión nueva invalida la revisión exacta del documento; cambios de grant invalidan también la identidad. Una instancia API nueva cambia la identidad aunque recupere el mismo documento/aprobación. La interfaz debe cerrar y verificar de nuevo, no reutilizar el checkbox o contexto anterior.

El harness reutiliza LeadLinkHistorySection, PersistedQuoteWorkspace y ExternalProposalPanel. El brief y workspace existente son de sólo lectura en esta demo; no hay rutas para generar/modificar cotizaciones ni para Payments. La aprobación de propuesta continúa exclusivamente interna, sin envío ni aceptación del cliente. La demo anterior de memoria se conserva como regresión independiente y no se presenta como durable.

## Reinicio real y limpieza separada

El supervisor sirve la página en 127.0.0.1:4194 y levanta la API en un proceso hijo en 127.0.0.1:4195. Después de sembrar fixtures cierra el Pool del sembrador con `stop()`, sin eliminar schemas. La API recibe configuración de namespaces/target, no documentos ni objetos del proceso anterior.

«Reiniciar proceso de prueba» envía SIGTERM a la API, que cierra Fastify y espera a Pool.end antes de salir con código 0. Sólo entonces se inicia otro PID con otro Pool sobre los mismos schemas. El test comprueba ambos PID, cierre limpio, nueva identidad, rechazo HTTP del contexto anterior y recuperación idéntica del snapshot, hash, aprobación y revisión. Si no termina limpiamente, no se informa un reinicio exitoso.

Reset y cierre final del supervisor son operaciones distintas: limpian únicamente los namespaces aleatorios de ese fixture. No se invoca close/cleanup durante el reinicio API. El hijo también cierra su Pool al perder el IPC del supervisor, para no dejar procesos huérfanos. La autoridad sintética caduca a los diez minutos; no se renueva automáticamente.

## Ejecutar y revisar

```
npm run office:db -- start
node --import tsx tests/external-proposal-durable-browser/server.ts
```

Abrir `http://127.0.0.1:4194/tests/external-proposal-durable-browser/index.html`. Verificar historial, elegir el único lead autorizado, consultar historial y propuesta, asociar y revisar. Los controles simulan nueva versión, retirada/restauración de permisos y reinicio real de API. Todos los datos son ficticios y el proveedor sigue siendo synthetic, scope test.

```
node --import tsx --test tests/office/external-proposal-http.test.ts
npm run test:external-proposal:durable:e2e
```

Seis pruebas servidor cubren identidad, CSRF/origen, aislamiento de comandos, retries y cambio de permisos/instancia. Ocho pruebas de navegador ejecutan el flujo en escritorio y móvil, con red limitada a loopback. Guardan capturas de aprobación, recuperación, versión obsoleta y permiso de aprobación retirado en `test-results/dashboard-visual/*-durable-proposal-*.png`. El log DURABLE_RESTART_EVIDENCE conserva PID anterior/nuevo y resultados de recuperación, sin tokens ni credenciales.

Este recorrido se detiene aquí: HTTP/panel y recuperación están conectados sólo en el harness sintético. No se registra un servidor comercial ni se conecta Hostinger, Monday, Gmail, Voice o Payments. Cualquier uso real, formato externo o despliegue sigue fuera del corte. Sin merge ni despliegue.

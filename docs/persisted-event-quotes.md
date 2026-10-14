# Expediente y cotización persistentes: composición explícita

Este lote añade código funcional con persistencia real probada en PostgreSQL aislado. No registra rutas en los servidores existentes de Office o staging. El Dashboard monta el componente en Propuestas/Eventos con acceso cerrado por defecto, según [dashboard-persisted-quotes.md](dashboard-persisted-quotes.md). Reutiliza los estilos aprobados; los ejemplos anteriores siguen siendo DEMO y no adquieren autoridad comercial.

## Vertical implementada

1. Crear expediente manual dentro de organización/workspace asignados por servidor. Guardar mensaje original íntegro, destinatario previsto, asistentes, fecha/lugar propuestos y requisitos.
2. Guardar nuevas versiones del brief sin sobrescribir las anteriores.
3. Resolver itemId y cantidad desde un catálogo inyectado por servidor. El navegador no suministra precio, etiqueta, impuesto ni anticipo.
4. Calcular subtotal, impuesto, total y anticipo con el mismo núcleo BigInt half-up extraído de drafts.mjs. Los wrappers históricos permanecen sintéticos e intactos en su comportamiento.
5. Generar y persistir HTML determinista e inerte desde brief, catálogo y cotización reales del registro. Se guardan los bytes, tamaño y SHA-256. No se usa el PDF fijo del ejemplo.
6. Aprobar internamente la versión exacta: destinatario, brief, catálogo, cotización y archivo. No envía, no implica aceptación del cliente ni genera factura/cobro/reserva.
7. Recuperar registro, documento y decisión tras reiniciar conexiones, servicio y un proceso Node separado.

Un cambio de brief, catálogo o versión de cotización deja la revisión anterior obsoleta. Las decisiones históricas se conservan; no se reutilizan silenciosamente. Cada comando lleva revisión esperada y clave de idempotencia. Dos ediciones concurrentes no pueden sobrescribirse.

## Fronteras de activación

- `createEventQuoteService` requiere store y proveedor de catálogo explícitos. No hay catálogo ni precio por defecto en código de producto.
- `commercial` exige identidad duradera, deadline vigente, permisos y catálogo `owner_authorized` con referencia de aprobación/fuente. `test` solo acepta `test_only`; los fixtures viven en tests.
- El catálogo se vuelve a resolver bajo el lock antes de mutar. Caducidad de catálogo e identidad se comprueban de nuevo después de esperas; los reads tardíos tampoco revelan registros tras caducar la identidad.
- La API requiere resolver una sesión ya autenticada; no crea login, usuarios ni permisos. Scope y actor no se aceptan del navegador. POST exige origen exacto y CSRF. GET es de solo lectura; el HTML autenticado lleva CSP sandbox, no-store y bloqueo de recursos externos.
- `PersistedQuoteWorkspace` exige cliente e identityKey explícitos. Arranca vacío, descarta respuestas tardías y borra estado privado al cerrar/cambiar identidad, expirar o rechazar acceso. Un resultado incierto exige recargar antes de otra acción; no reintenta una mutación automáticamente.
- No se integra este ledger con el de Comunicaciones. Aprobar una cotización no aprueba ningún email/SMS: ese paso conserva su propia revisión exacta y permisos.

## Almacenamiento

`PostgresEventQuoteStore` recibe un pool y vault existentes. Cifra el agregado con AES-GCM reutilizando MondayVault y AAD de scope/evento/revisión; la tabla no guarda contactos, mensajes ni HTML en claro. Usa locks y transacción para agregado, recibos y auditoría. La validación repite los comandos en orden y comprueba hashes y bytes, no solo la forma JSON. La auditoría SQL solo conserva hashes y es append-only.

`005_event_quotes.up.sql` es una migración preparada independiente de office_demo. No modifica 001–004 ni es aplicada por el arranque existente. initialize() únicamente admite namespaces quote_test_* nuevos en loopback para pruebas. No se creó ni configuró una clave comercial. Las claves y actores de pruebas no sirven para activar usuarios reales.

Límites intencionados de esta primera vertical: USD con dos decimales, cantidades enteras 1–1000, precios unitarios hasta 1.000.000 centavos, total hasta 1.000.000.000 centavos, 100 comandos/50 briefs/20 cotizaciones y 512 KiB por expediente. No se asume que USD, ningún porcentaje ni los valores sintéticos sean la política comercial Gourmet. Otra moneda/modelo fiscal, descuentos, opciones o capacidad mayor requieren contrato y pruebas adicionales.

## Verificación reproducible

Con Node24 y la base aislada del README:

    npm ci --no-audit --no-fund
    npm run typecheck
    npm run build
    npm run office:build
    npm run test:operations
    npm run office:db -- start
    npm run test:office
    npm run test:event-quotes:e2e
    npm run office:db -- stop

Los tests event-quote-* cubren cálculo, contexto, permisos, CSRF, cifrado, concurrencia, rollback, replay, archivo inerte, revisiones e inicio de un proceso independiente que recupera la aprobación y los mismos bytes. El harness de navegador usa React→HTTP→PostgreSQL con datos únicamente sintéticos, y borra solo su namespace temporal al finalizar.

En el executor local se verifican las pruebas de dominio/HTTP/UI SSR/cliente y PostgreSQL. Chromium falla al arrancar por `socket() failed: Operation not permitted`; la interacción y las capturas de esta nueva vista quedan pendientes. Docker tampoco está disponible, por lo que sus cuatro contratos y la imagen necesitan CI. El workflow existente ya ejecuta el harness, sin ampliar triggers, permisos, secretos ni publicación de imágenes; el nuevo montaje no modifica ese workflow. Los resultados anteriores de CI no validan este nuevo lote.

## Inputs necesarios para operación comercial

La fuente única para preparar los campos y límites es [catalogue-contract.md](catalogue-contract.md), con su esquema JSON sin precios de ejemplo.

Catálogo autorizado, moneda y reglas tributarias/anticipo/servicio/logística/vigencia; propietario y usuarios con acceso; identidad y vault duraderos configurados mediante canal seguro; revisión/aplicación de migración y autorización de despliegue. Sin ello, el módulo permanece cerrado en la interfaz y la API sin registrar en los servidores existentes. No se requieren cuentas de Gmail, Monday, pagos o Regus para desarrollar y probar esta vertical.

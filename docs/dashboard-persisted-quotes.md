# Dashboard: cotizaciones guardadas con acceso explícito

Propuestas y Eventos montan el componente persistente dentro del diseño aprobado. Guardadas es la vista inicial y permanece cerrada sin una fuente de acceso configurada. El botón Verificar acceso no inicia sesión: consulta exclusivamente la proyección inyectada de una identidad existente. El ejemplo DEMO requiere una selección distinta y nunca otorga permisos sobre registros guardados.

## Contrato de composición

DashboardPage recibe opcionalmente quoteAccessSource y quoteClient. La fuente debe pertenecer al mismo propietario de identidad que el resolver de la API y proporcionar:

- identityKey opaco, no secreto, renovado cuando cambia la identidad
- scope completo de organización, workspace y modo
- durableIdentity verdadero para uso comercial; no deducido de storage.durable ni de una sesión DEMO
- expiración y permisos explícitos de lectura, escritura y aprobación
- IDs exactos de eventos autorizados, incluidos IDs autorizados para creación manual
- digest, autoridad y vigencia del catálogo del servidor
- subscribe(onWithdraw), que avisa sincrónicamente ante cierre, cambio de identidad/scope/permisos o retiro de catálogo

No se implementa un proveedor de identidad, índice de eventos, alta de usuarios ni configuración de credenciales. La fuente predeterminada devuelve unconfigured sin red. La API y sus credenciales siguen fuera de los servidores existentes; la conexión comercial requiere una composición posterior autorizada.

## Fronteras y ciclo de vida

La vista copia y acota la proyección, exige canRead y limita su vigencia a 15 minutos. Seleccionar un ID permitido no carga automáticamente: Consultar evento seleccionado abre el componente. No se resuelven identidades o eventos por nombres.

El cliente vinculado comprueba organización/workspace/modo de cada respuesta de expediente y digest/autoridad/modo/vigencia del estado de catálogo. El estado actual de la API no incluye organización/workspace; no se afirma verificar esos campos en status. La fuente confiable y el resolver deben ser de la misma identidad. La seguridad definitiva está en la API y la transacción del servidor, nunca en las propiedades React. Las escrituras conservan origen y CSRF; la interfaz no transmite una identidad para adquirir autoridad.

Cambiar de sección, seleccionar otro evento, cerrar, ocultar, salir, Back/Forward, retirar la identidad o vencer el acceso limpia la vista y cancela solicitudes. Las respuestas antiguas no pueden restaurarla aunque el adaptador ignore abort. Restablecer una identidad exige otra consulta explícita. Errores 401/403 o una respuesta incompatible retiran la conexión; los resultados de mutación inciertos conservan el requisito existente de recargar antes de continuar.

Guardar/aprobar una cotización no actualiza métricas financieras, no equivale a una venta, pago ni aceptación del cliente y no autoriza Comunicaciones. Los valores del resumen permanecen desconocidos; la vista visual DEMO conserva selección independiente.

## Catálogo comercial pendiente

Fuente única: [catalogue-contract.md](catalogue-contract.md) y [esquema](catalogue-authority.schema.json). No contienen tarifas ni reglas comerciales inferidas. El catálogo sintético y la identidad temporal inyectada existen únicamente en pruebas.

## Verificación de este cambio

Pruebas de contrato/SSR cubren cierre inicial, navegación, IDs, permisos, contexto, copias aisladas, caducidad, cancelación y respuestas tardías. El harness de navegador monta DashboardPage real con React → HTTP → PostgreSQL temporal; conserva creación, generación HTML, aprobación interna, recuperación y obsolescencia. Agrega selección explícita, retiro/restablecimiento de identidad, Back, métricas desconocidas y capturas dentro del shell aprobado.

Las interacciones/capturas de este montaje se ejecutarán en CI tras aprobación de publicación. El CI verde cc846f7a verificó el componente anterior aislado; no acredita este cambio local. Chromium local sigue restringido por sockets y no se reintenta con otra ruta. No cambian workflow, triggers, permisos, secretos ni retención.

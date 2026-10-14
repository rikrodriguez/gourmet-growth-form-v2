# Catálogo autorizado: contrato único para preparar la activación

Esquema estructural: [catalogue-authority.schema.json](catalogue-authority.schema.json).
Contrato de código: CatalogSnapshot y validateQuoteCatalog. Las pruebas de catálogo verifican que sus límites coinciden con este esquema. No se incluyen precios, porcentajes ni condiciones comerciales inventados.

## Información que debe identificar o aprobar el propietario

- Fuente exacta y versión del catálogo; referencia a la aprobación de ese contenido
- Moneda, impuestos y cómo se aplican; política de anticipo y vigencia
- ID estable de cada partida, nombre, unidad y precio exacto
- Tratamiento de servicios/logística, mínimos, exclusiones y condiciones

La versión actual soporta USD con centavos, cantidades enteras, un impuesto aplicado al subtotal y un anticipo sobre el total. No convierte moneda, infiere impuestos, añade mínimos ni calcula descuentos. Si el catálogo real usa otras reglas, se deben ampliar explícitamente contrato y pruebas antes de activar. Un campo ausente bloquea; no se interpreta como cero.

## Procedencia y autorización

El navegador únicamente envía itemId/cantidad. El adaptador del servidor obtiene la versión autorizada y resuelve precio, texto, unidad y reglas. Declarar owner_authorized o escribir una approvalRef en un archivo no otorga autorización: el adaptador tiene que verificar su procedencia aprobada. source es texto visible e inerte; no activa búsquedas ni descargas.

El esquema no sustituye las comprobaciones dinámicas: identidad duradera, permisos, scope comercial, vigencia posterior al reloj de ejecución, IDs únicos, límites de importes, hash de catálogo/brief y transacción. Catálogos de prueba test_only nunca se aceptan en ámbito comercial.

## Integración y estado actual

Guardar un expediente o aprobar una cotización no envía, genera un enlace de pago, factura, cobra, reserva ni contrata. El primer componente persiste y calcula correctamente en pruebas aisladas. El Dashboard debe mostrar el módulo bloqueado mientras no exista la identidad y fuente autorizadas; no convierte la sesión DEMO en operador real.

La preparación del código y sus pruebas puede continuar sin datos reales. Configurar identidad/vault, aplicar la migración a un entorno real y desplegar requieren el paso seguro y la autorización correspondientes. Nunca incluir claves o credenciales en este catálogo.

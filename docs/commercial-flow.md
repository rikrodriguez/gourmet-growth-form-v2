# Respuesta comercial sintética

En Ventas, cada caso DEMO ofrece dos hilos inventados. El operador selecciona un hilo, lee sus mensajes y referencias y prepara una respuesta para revisión interna. El destinatario termina en `@invalid.test`. El hilo y el borrador indican datos simulados, Gmail y Monday faltantes y respuesta sin enviar. El contenido inicial es un guion local; no consulta un modelo ni una cuenta externa.

## Contexto y revisión exactos

El comando reutiliza `action: "draft"` con `functionId: "sales"`. Incluye únicamente `commercialThreadId`, `commercialThreadRevision` y `commercialThreadDigest`, además del caso y la clave de idempotencia existentes. Los tres campos son obligatorios juntos. Se rechazan texto, destinatario o contexto aportados por el cliente cuando selecciona un hilo. El servidor resuelve el hilo dentro del caso autorizado y comprueba versión y huella antes de generar el borrador.

`CommercialThread` versión 1 contiene caso, identidad, revisión, SHA-256, asunto, destinatario, mensajes con fecha, referencias y evidencia. Cada referencia declara origen (`fixture`, `gmail` o `monday`), estado (`simulated` o `missing`), descripción y evidencia; una fuente faltante tiene evidencia nula. Esta versión de la demo admite únicamente contexto sintético validado por el servidor.

La aprobación captura el hilo completo en `commercialContext`; los mensajes y referencias capturados permanecen visibles aunque se seleccione otro hilo o se edite la respuesta. La huella de aprobación incluye ese contexto junto al contenido y los campos ya revisados. Editar crea otra revisión pendiente e invalida la aprobación anterior. Aprobar registra sólo la decisión interna; el envío permanece bloqueado. El historial conserva identidad, revisión, huella y referencia de evidencia del hilo.

El agregado JSON existente en PostgreSQL guarda el contexto en la misma transacción que el borrador y el historial. No hay migraciones nuevas. Las aprobaciones anteriores que carecen de `commercialContext` conservan su cálculo de huella; los hilos se derivan de la inicialización persistida sin resembrar oficinas guardadas. Una sesión sin permiso de Ventas no recibe hilos ni aprobaciones comerciales.

## Límite para futuras lecturas de Gmail y Monday

Un futuro adaptador del servidor podrá convertir lecturas autorizadas de Gmail y Monday en contexto normalizado: mensajes del hilo, asunto y destinatario, datos del brief y referencias verificables con fecha y origen. Antes de habilitarlo deberá definir una nueva versión de contrato, validación de procedencia y permisos por usuario y caso. El contrato actual rechazará datos reales; no es un conector preparado para recibirlos.

La interfaz solicitará identidades y versiones del contexto publicado por ese servidor, sin recibir credenciales ni aceptar contexto arbitrario del navegador. La revisión deberá capturar el resultado normalizado completo; una nueva lectura que cambie contenido o referencias requerirá otra versión y huella. Fuentes ausentes o no verificadas seguirán declaradas faltantes, sin inferir precios, disponibilidad, pago o cierre de venta.

El adaptador tendrá alcance de lectura. Ninguna aprobación de este flujo autoriza envíos, escrituras en Monday o efectos externos. Conexión de cuentas y ejecución comercial quedan para una tarea posterior expresamente autorizada.

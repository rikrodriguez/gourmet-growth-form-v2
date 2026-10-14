# Gourmet Dashboard y expediente de evento

## Referencia visual vigente

La pantalla completa aceptada por el propietario el 13 de octubre de 2026 es
`docs/design-approved/gourmet-dashboard-20261013.png`. El JSON adjunto fija sus
hashes, dimensiones y tokens. Sustituye las propuestas visuales anteriores.

El marco React usa fondo blanco/gris, sidebar compacto, tres tarjetas, cuatro
celdas de publicidad, gráfico de seis barras, asistentes y actividad breve.
La tipografía y los tokens CSS son reutilizables mediante `brandName` y variables
`--ga-*`. Inter es la fuente elegida en la propuesta aceptada; no se afirma haber
identificado la fuente ni recuperado el CSS original del video.

La referencia visual fue aceptada como diseño estático. El nuevo componente real
necesita todavía ejecución y revisión visual de navegador en CI. Un build o
una prueba SSR no demuestra identidad píxel a píxel ni calidad visual final.

## Rutas y datos separados

- `/office/dashboard` contiene el Dashboard y el expediente temporal.
- `/office/` mantiene su escena y comportamiento. Su resumen interno sigue
  llamándose Operaciones; el Dashboard es una aplicación separada.
- `/office/communications` conserva el backend local de revisión exacta.
- La navegación del Dashboard usa secciones y pestañas locales en el hash,
  admite Atrás/Adelante y conserva el mismo expediente entre módulos.
- Datos fuente es el modo inicial. Cuatro oportunidades sintéticas y los
  buzones separados se leen de la muestra fija. Dinero, conversión, publicidad,
  reservas, cobros y conexiones reales permanecen desconocidos.
- Vista DEMO se activa explícitamente. Sus cifras son el escenario visual de la
  pantalla aceptada, no un agregado del expediente ni resultados del negocio.
  No se mezclan con la cola local de revisión.
- `DEMO-EVT-042` es un tercer escenario identificado. No se vincula con una
  oportunidad, una cuenta o un hilo por coincidencia de nombre.

## Cobertura por módulo

| Acceso | Funciona en código local | Alcance real pendiente |
| --- | --- | --- |
| Dashboard | Marco aprobado, modo fuentes, modo visual DEMO, navegación responsive | Métricas y conectores del negocio |
| Oportunidades | Cuatro tarjetas de muestra, etapas de solo lectura | Sincronización comercial, cambios duraderos |
| Bandeja | Canales, detalle, buzones separados, enlace a Comunicaciones | Leer cuentas reales y enlazar cada hilo con evidencia |
| Propuestas | v1 obsoleta/v2, tabla DEMO, total/anticipo, PDF fijo y revisión | Catálogo autorizado, generador general, persistencia de propuestas reales |
| Revisión exacta del expediente | Mensaje íntegro, identidad, destinatarios, campos editables, adjunto y contexto; invalidación y aprobación simulada | No guarda ni autoriza una aprobación productiva |
| Revisión local | GET explícito de la cola cifrada existente; validación de contexto, cuenta, versión y caducidad | Sesión real, cuentas y permisos operativos |
| Enlaces de pago | Secuencia local preparar/revisar/referencia/revisión de mensaje/compartir; timeout y caso alternativo | Proveedor de pago, URL real, envío, verificación/conciliación |
| Eventos / Calendario | Ficha del mismo evento, fecha propuesta, dependencias | Calendario real, disponibilidad y reservas |
| Tastings | Ficha editable Regus por ciudad/zona, tipo y fecha propuesta | Centro/sala/coste/permiso de alimentos/reserva/invitación |
| Proveedores | Candidato sin aceptar; sourcing habilitado solo tras cierre humano DEMO | Directorio, contacto, aceptación y contratación |
| Logística | Notas/checklist local del evento | Compras, recepción, transporte, calidad y cierre real |
| Seguimientos | Pendientes legibles y navegación al expediente | Programador y mensajes revisables por cada envío |
| Conocimiento | Reglas Gourmet de solo lectura | Editor de fuentes y configuración real de agentes |
| Oficina | Aplicación anterior preservada | No se prueba su conexión productiva en este lote |
| Costes / Catálogo / Analítica / Contactos / Equipo | Entradas visibles deshabilitadas | Módulos todavía no implementados en el nuevo Dashboard |

## Invariantes del expediente

El cambio de 20 a 24 personas deja v1 obsoleta. La propuesta v2 usa exclusivamente
un catálogo de laboratorio: 3.000 unidades DEMO y 900 de anticipo, impuestos no
modelados. No representa precio, deuda ni obligación comercial de Gourmet.

La aprobación simulada compara una captura exacta en memoria de identidad,
texto, destinatarios, adjunto y contexto. Editarlos invalida la aprobación y las
etapas dependientes. Las URL locales y descriptores del PDF/vista previa también
forman parte de esa identidad; su reemplazo exige revisión nueva. El SHA-256 del
PDF se comprueba contra bytes empaquetados, no se presenta como digest de fuentes
externas. La página completa del PDF se revisa dentro de la misma pantalla para
no perder el borrador; la descarga es separada.

Preparado, revisado, referencia simulada, compartido en simulación y cobro son
estados distintos. Nunca se fabrica una URL. Un timeout mantiene cobrado y saldo
desconocidos y la misma solicitud; no habilita reenvío ni un segundo cobro. El
caso alternativo de 900/2.100 está rotulado y no cambia el principal. Conciliación
y proveedor siguen pendientes. No hay recibos, checkout ni pagos reales.

Un cierre humano DEMO habilita sourcing. El chef candidato sigue sin contactar,
sin disponibilidad verificada, sin aceptación ni asignación. Una nota marcada
no convierte el evento en listo, comprado, recibido o reservado.

Reuniones y tastings siguen la preferencia Regus por ciudad/zona. Centro, marca,
dirección, sala, aforo, alimentos externos, coste, condiciones y confirmación
se verifican por separado. No se asume que cualquier sede permita comida.

## Lecturas, seguridad y privacidad

La cola existente sigue usando solo GET `/office-api/communications`, únicamente
al pulsar. No inicia sesiones, crea borradores, aprueba ni despacha. Conserva
identidad de organización/cuenta/hilo, validación de contexto y versiones,
HttpOnly, CSRF en mutaciones y composición local explícita. Las rutas no se
habilitan automáticamente en staging.

Los datos y el expediente temporal se retiran al ocultar/salir de la página o
tras 15 minutos. Cada recarga cambia una generación de sesión React, por lo que
el estado se reinicia incluso si la fuente responde de inmediato. Volver a
mostrar datos requiere pulsar Cargar muestra; la cola se consulta por separado.
No se usan localStorage, sesiones nuevas automáticas ni proveedores externos.

El texto se escapa con React. No se ejecuta HTML de mensajes. No hay OAuth,
credenciales, permisos ampliados, envíos email/SMS, importaciones, modificaciones
Monday, reservas, contratación o cobros. Las acciones reales están deshabilitadas.

## Verificación y límites

Los tests de reducer/SSR comprueban estado, invalidación, desconocidos,
idempotencia local, escaping, identidad, bytes del adjunto y contraste declarado.
La suite de navegador define 52 ejecuciones escritorio/móvil para Dashboard y
expediente, incluidos Atrás/Adelante, repetición, foco, vista previa del PDF,
refresh, caducidad y retiro por ocultación. No se considera pasada sin ejecución.

Chromium local aborta antes de cargar una página por la restricción de sockets.
Las cuatro pruebas Compose requieren Docker, ausente aquí. CI, capturas e imagen
se ejecutarán únicamente después de autorizar la publicación del cambio exacto.
No se fusiona ni despliega este lote.

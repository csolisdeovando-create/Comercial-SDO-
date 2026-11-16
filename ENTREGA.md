# Entrega de SDO Comercial

**Propiedad de S&V SpA · Desarrollado por José Cano**

Este documento resume qué es el sistema, dónde vive, cómo se mantiene y qué revisar si algo falla. No contiene claves: las claves están solo en Render (Environment).

---

## 1. Qué es

Un solo sistema con dos negocios separados, que se eligen con la barra de arriba del panel:

| | 🏠 SDO Rent · Arriendos | 🏢 SDO Capital · Ventas |
|---|---|---|
| Formulario para interesados | `/postular` | `/comprar` |
| Panel | `/admin` | `/admin/ventas` |
| Indicadores | `/admin/indicadores` | `/admin/ventas/indicadores` |
| Extra | — | `/admin/ventas/propiedades` (departamentos en venta) |

Lo que comparten:

- **Calendario de visitas** (`/admin/calendario`): uno solo, para que las visitas de Julio nunca se crucen. Arriendo en turquesa («RENT · arriendo»), venta en azul («CAPITAL · venta»).
- **WhatsApp**: el mismo número para los dos (cuando se conecte la API de Meta).
- **Usuarios del panel** y casilla de correo de envío (sdopropiedades@sdorent.cl).

## 2. Flujo

1. **Lead** → el interesado llega por un aviso o anuncio. Con WhatsApp conectado, el sistema le responde solo con su link (de arriendo o de compra).
2. **Postulación** → completa datos y sube documentos. Pregunta obligatoria «¿Dónde viste el aviso?» para medir cada canal.
3. **Revisión** → al equipo le llega un correo con los documentos y botones **Aprobar / Rechazar**.
   - Ventas: además muestra la **calificación** (pie mínimo, preaprobación del banco y dividendo hasta 25% de la renta).
4. **Agenda** → al aprobar, el interesado recibe el calendario y elige hora (lun–vie 9 a 18; sábados solo las horas que el equipo abre).
5. **Confirmación** → se le pide confirmar al agendar y el día anterior; desde el calendario se puede «Pedir confirmación» o «Confirmar visita».
6. **Post-visita** → 30 minutos después, a Julio le llega un correo para registrar el resultado (continúa / no asistió / no continúa con motivo de Breal).
7. **Ventas**: negociación en la ficha (oferta → reserva → promesa → escritura). La propiedad pasa a «reservada» y «vendida».
8. **Papelera** → quien cancela, no asiste o no continúa sale de las listas sin borrarse; vuelve sola si reagenda.

## 3. Dónde vive

- **Código**: repositorio de GitHub `Comercial-SDO-` (Node.js 22, Express, SQLite).
- **Servidor**: Render, servicio **sdo-comercial** (plan Starter con **disco persistente** en `/var/data`). Ahí están la base de datos y los documentos de los interesados: **nunca borrar el servicio ni el disco**.
- **Publicación**: cada cambio que llega a la rama `main` se publica solo (1–2 minutos sin servicio). Si Render no lo toma: Deploys → **Manual Deploy → Deploy latest commit**.
- **Correo**: Gmail de sdopropiedades@sdorent.cl con una *contraseña de aplicación* (variable `SMTP_PASS`).

## 4. Variables de Render (Environment)

| Variable | Para qué |
|---|---|
| `BASE_URL` | Dirección pública (https://sdo-comercial.onrender.com) |
| `APP_SECRET` | Firma de links y sesiones (no cambiar: invalida links enviados) |
| `ADMIN_USUARIO` / `ADMIN_CLAVE` | Usuario principal del panel |
| `PANEL_USUARIOS` | Otros usuarios: `usuario:clave,usuario2:clave2` |
| `INDICADORES_TOKEN` | Clave del JSON `/api/indicadores` (panel Operativo) |
| `SMTP_USER` / `SMTP_PASS` | Casilla que envía los correos |
| `EMAIL_DOCUMENTOS` | Quién revisa las postulaciones de arriendo |
| `EMAIL_VISITAS` | Equipo que recibe las visitas (evento de calendario) |
| `EMAIL_EJECUTIVO_VISITAS` | Quien hace las visitas (recibe el post-visita) |
| `EMAIL_VENTAS` | Equipo de ventas (postulaciones de compra y negociación) |
| `WHATSAPP_TOKEN`, `WHATSAPP_PHONE_NUMBER_ID`, `WHATSAPP_APP_SECRET`, `WHATSAPP_VERIFY_TOKEN` | Conexión a la API de WhatsApp (Meta) |
| `AGENDA_HORAS`, `AGENDA_FERIADOS`, `AGENDA_HORAS_SABADO_HABILITABLES`… | Horarios de visita |
| `ARCHIVO_MAX_MB` | Máximo por archivo (50 MB por defecto) |
| `VENTA_PIE_TRAMOS` | Pie por precio: `1500:0.1` = hasta 1.500 UF pide 10% (sobre eso, `VENTA_PIE_MINIMO`, 20%) |
| `VENTA_CARGA_MAXIMA`, `VENTA_TASA_ANUAL`, `VENTA_PLAZO_ANIOS`, `VALOR_UF` | Cálculo del dividendo |
| `REVISION_AUTOMATICA`, `ANTHROPIC_API_KEY` | Lectura automática de liquidaciones/AFP (en pausa) |

Todas tienen un valor por defecto en `src/config.js`; el ejemplo completo está en `.env.example`.

## 5. Conexiones externas

- **WhatsApp (Meta)**: pendiente. Pasos: crear la app en developers.facebook.com con la cuenta comercial de sdopropiedades, agregar el número, generar un token permanente (usuario del sistema) y configurar el webhook `https://sdo-comercial.onrender.com/webhook/whatsapp` con el campo **messages**. Las 4 claves van en Render.
- **Panel Operativo (Cristian)**: lee `/api/indicadores` con `INDICADORES_TOKEN`. La copia cada 2 horas a ese panel es una tarea programada de Claude en la cuenta de José: si se deja de usar, debe recrearse en la cuenta de quien administre el panel.
- **Breal**: no hay escritura automática. El equipo registra las visitas en Breal y marca la casilla «Registrado en Breal».

## 6. Cómo hacer un cambio

1. Editar el código y correr las pruebas: `npm ci` y luego `npm test` (todas deben pasar).
2. Subir el cambio a `main` en GitHub → Render publica solo.
3. Revisar en Render → **Deploys** que el nuevo deploy quede ✅ **Live**.

Reglas del proyecto:
- Las migraciones de la base de datos son solo **aditivas** (agregar columnas/tablas, nunca borrar): publicar no borra interesados.
- Nunca subir `.env` ni claves al repositorio.
- Avisar al equipo antes de publicar (1–2 minutos sin servicio).

## 7. Si algo falla

| Síntoma | Qué revisar |
|---|---|
| El sitio no carga / error 502 | Render → Events / Logs. Si recién se publicó, esperar 2 minutos. |
| No llegan correos | `SMTP_PASS` vigente (la contraseña de aplicación pudo revocarse) y Logs con «[correo]». |
| Un cambio no aparece | Render → Deploys: si no hay deploy nuevo, **Manual Deploy → Deploy latest commit**. |
| WhatsApp no responde solo | Que la API esté conectada (4 variables en Render) y el webhook suscrito a **messages**. |
| Un aviso de venta responde con link de arriendo | Cargar la propiedad en SDO Capital → Propiedades con su **link del aviso**. |

## 8. Estructura del código

```
src/
  server.js          arranque y tareas cada 15 min (recordatorios, post-visita)
  app.js             rutas (formularios, panel, ventas, webhook, API)
  views.js           páginas de SDO Rent y comunes (calendario, ficha, panel)
  vistasVentas.js    páginas de SDO Capital (formulario de compra, panel, propiedades, indicadores)
  notificaciones.js  correos y WhatsApp (marca SDO Rent o SDO Capital según el interesado)
  db.js              base de datos SQLite y migraciones
  agenda.js          horarios, sábados habilitables, eventos de calendario (.ics)
  calificacion.js    reglas de compra (pie, preaprobación, dividendo, UF del día)
  indicadores.js     embudos e indicadores de arriendo y venta
  origen.js          origen de cada interesado (canal, campaña)
  requisitos.js      documentos por tipo de postulante y forma de compra
public/              estilos, logos, scripts del formulario
test/                pruebas automáticas (npm test)
```

# SDO Comercial – Leads de WhatsApp → Postulación → Agenda de visitas

Sistema para el área comercial de **SDO Rent**. Responde automáticamente a los interesados que escriben al
WhatsApp comercial **+56 9 6121 6962** (desde el botón "Contactar por WhatsApp" de Mercado Libre, Yapo,
Portal Inmobiliario, etc.), les envía un link para completar sus datos y subir sus documentos, y después
les envía un calendario para agendar la visita.

## Flujo

```
Interesado ve aviso (Mercado Libre / Yapo / Portal Inmobiliario…)
        │  botón "Contactar por WhatsApp"
        ▼
WhatsApp +56 9 6121 6962 ──► respuesta automática con requisitos + link personal
        │
        ▼
Formulario web (/postular/<token>)
  • Dependiente o independiente/empresa
  • Nombre, RUT (validado), correo, teléfono, propiedad
  • Sube los 4 documentos según su tipo
        │
        ▼
Correo a sdopropiedades@sdorent.cl (Bárbara Díaz)
  • Ficha del interesado + documentos adjuntos
  • Botones: ✅ Aprobar y enviar calendario  |  ❌ Rechazar / pedir documentos
        │ Aprobar
        ▼
Automáticamente: correo + WhatsApp al interesado con el link del calendario
        │
        ▼
Calendario (/agendar/<token>) – lunes a viernes, 9:00 · 11:00 · 13:00 · 15:00 · 17:00
        │ elige horario
        ▼
Aviso con invitación de calendario (.ics) a:
  julio.mendoza@sdorent.cl · barbara.diaz@sdorent.cl · csolisdeovando@sdocapital.cl
+ confirmación al interesado por correo y WhatsApp
```

**Requisitos que se piden**

| Dependientes | Independientes o empresas |
|---|---|
| 1️⃣ Cédula de identidad | 1️⃣ Carnet del representante legal |
| 2️⃣ 3 últimas liquidaciones de sueldo | 2️⃣ Carpeta tributaria o reporte de boletas de honorarios |
| 3️⃣ Certificado de cotizaciones (AFP) | 3️⃣ Declaraciones de renta |
| 4️⃣ Certificado Dicom u otro reporte de deuda | 4️⃣ Reporte Dicom (empresa y representante legal) |

Se editan en [`src/requisitos.js`](src/requisitos.js).

### Detalles incluidos

- Detecta el portal de origen (Mercado Libre, Yapo, Portal Inmobiliario, TocToc, Marketplace) y guarda el link del aviso.
- No responde dos veces al mismo mensaje ni vuelve a mandar el link al mismo número antes de 12 h, para no interrumpir conversaciones del equipo.
- Si el interesado vuelve a escribir, se le responde según su estado (documentos en revisión, link de agenda, visita ya agendada).
- Los links de aprobación/rechazo están firmados; abrir el link solo muestra una página de confirmación (los antivirus de correo que "visitan" links no aprueban nada).
- Rechazo con motivo: el interesado lo recibe por correo y WhatsApp y puede volver a subir documentos.
- Un bloque ocupado deja de aparecer; si dos personas eligen el mismo horario a la vez, solo uno queda.
- El interesado puede cambiar su horario (se avisa al equipo como "reagendada").
- Feriados configurables, anticipación mínima, cupos por bloque.
- Si los archivos son muy pesados para adjuntar, el correo lleva links de descarga.
- Panel interno en `/admin` (usuario y clave) con todos los leads, estados y próximas visitas.
- Opción `AGENDA_AUTOMATICA=true` para enviar el calendario apenas se suben los documentos, sin esperar la revisión.

## Puesta en marcha

Requiere **Node.js 22.13 o superior** (usa la base de datos SQLite incluida en Node; no necesita instalar una base de datos aparte).

```bash
npm install
cp .env.example .env   # completar los datos
npm start
npm test               # pruebas automáticas
```

Sin SMTP ni WhatsApp configurados funciona en **modo prueba**: los correos quedan en `data/outbox/*.eml` y los
mensajes de WhatsApp se muestran en la consola.

### 1. Publicarlo en internet

Necesita una URL pública con https (ej. `https://comercial.sdorent.cl`). Opciones: Render, Railway, Fly.io o un
VPS con Nginx. **Importante:** la carpeta `data/` (base de datos y documentos) debe estar en un disco persistente
y respaldarse, porque contiene información personal de los postulantes.

### 2. Correo (Google Workspace)

El dominio sdorent.cl usa Google Workspace. **La clave normal de la cuenta no sirve para enviar desde un
sistema**: Google exige una *contraseña de aplicación*.

1. Entrar a https://myaccount.google.com con `sdopropiedades@sdorent.cl`.
2. **Seguridad → Verificación en 2 pasos** → activarla (si no lo está).
3. Ir a https://myaccount.google.com/apppasswords, nombre "SDO Comercial" → **Crear**. Google muestra una clave de
   16 letras (ej. `abcd efgh ijkl mnop`); se muestra una sola vez.
   - Si dice "La opción no está disponible", el administrador de Workspace debe permitir la verificación en 2 pasos
     (admin.google.com → Seguridad → Autenticación).
4. En `.env`:
   ```
   SMTP_HOST=smtp.gmail.com
   SMTP_PORT=465
   SMTP_USER=sdopropiedades@sdorent.cl
   SMTP_PASS=abcdefghijklmnop     # la contraseña de aplicación, sin espacios
   EMAIL_FROM=SDO Rent <sdopropiedades@sdorent.cl>
   ```
5. Probar: `npm run probar-correo` (envía un correo de prueba a sdopropiedades@) o
   `npm run probar-correo otro@correo.cl`.

La contraseña de aplicación va **solo** en el `.env` del servidor (nunca en GitHub ni por chat). Si se filtra, se
revoca en la misma página sin afectar la clave normal de la cuenta.

### 3. WhatsApp Business (Meta Cloud API)

1. Crear una app en [developers.facebook.com](https://developers.facebook.com) de tipo **Business** y agregar el producto **WhatsApp**.
2. Registrar el número **+56 9 6121 6962** en la cuenta de WhatsApp Business.
   - Si hoy el número se usa en la app **WhatsApp Business** del celular, Meta permite la **coexistencia**
     (seguir usando la app en el teléfono y además la API) al conectarlo desde el registro integrado
     ("Embedded Signup") o a través de un proveedor (BSP). Si se registra directamente en la API sin coexistencia,
     el número deja de funcionar en la app del celular. **Revisar esto antes de migrar.**
3. Crear un **token de acceso permanente** (usuario del sistema en Business Manager con permiso `whatsapp_business_messaging`) → `WHATSAPP_TOKEN`.
4. Copiar el **Phone number ID** → `WHATSAPP_PHONE_NUMBER_ID`.
5. Configurar el webhook en la app de Meta:
   - URL: `https://<tu-dominio>/webhook/whatsapp`
   - Token de verificación: el mismo valor que pusiste en `WHATSAPP_VERIFY_TOKEN`
   - Suscribirse al campo **messages**.
6. Copiar la **clave secreta de la app** → `WHATSAPP_APP_SECRET` (valida que los mensajes vengan de Meta).
7. (Opcional) Crear y aprobar una plantilla de "utilidad" para enviar el link de la agenda cuando pasaron más de
   24 h desde el último mensaje del cliente, con dos variables: `{{1}}` nombre y `{{2}}` link. Ej:
   > Hola {{1}}, revisamos tus documentos y ya puedes agendar tu visita aquí: {{2}}

   y poner su nombre en `WHATSAPP_PLANTILLA_AGENDA`. Sin plantilla, el link igual llega por correo.

> **Mientras se configura la API:** como solución inmediata se puede poner el mensaje de bienvenida con el link
> `https://<tu-dominio>/postular` en *WhatsApp Business → Herramientas para la empresa → Mensaje de bienvenida*.
> El formulario funciona igual sin el link personalizado (el lead se asocia por teléfono).

## Rutas

| Ruta | Uso |
|---|---|
| `GET/POST /webhook/whatsapp` | Webhook de Meta |
| `GET/POST /postular[/<token>]` | Formulario de postulación y subida de documentos |
| `GET/POST /revision/<id>/aprobar` · `/rechazar` | Acciones de Bárbara (links firmados del correo) |
| `GET /revision/<id>/documento/<docId>` | Descarga de un documento (link firmado) |
| `GET/POST /agendar/<token>` | Calendario de visitas |
| `GET /admin` | Panel interno (usuario/clave) |
| `GET /salud` | Chequeo de estado |

## Estructura

```
src/
  server.js          arranque
  app.js             rutas (webhook, postulación, revisión, agenda, panel)
  config.js          variables de entorno
  db.js              SQLite (leads, documentos, visitas, mensajes)
  requisitos.js      documentos por tipo de postulante
  agenda.js          bloques lun-vie, feriados, .ics
  notificaciones.js  textos de WhatsApp y correos
  whatsapp.js        cliente WhatsApp Cloud API
  mailer.js          envío de correos (SMTP o modo prueba)
  views.js           páginas HTML
public/              estilos y scripts del navegador
test/                pruebas (npm test)
```

## Datos personales

El sistema guarda cédulas, liquidaciones y reportes de deuda. Recomendaciones: publicar solo con https, usar
`APP_SECRET` y `ADMIN_CLAVE` robustas, respaldar y restringir el acceso a `data/`, y definir un plazo para
eliminar documentos de postulaciones que no avanzaron (Ley 19.628 / Ley 21.719).

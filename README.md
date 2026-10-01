# Romeo

El asistente open source que contesta tus WhatsApp con tu voz. Aprende cómo escribís de tus chats, sabe qué hiciste hoy leyendo tu Vault de Obsidian y tu calendario, y solo contesta los chats que vos le habilitás.

Corre en tu compu, con tu propio WhatsApp. Nada pasa por un servidor ajeno.

## Qué necesitás

- Node.js 24 o más nuevo, y git
- WhatsApp en el celular (Romeo se vincula como un dispositivo más, igual que WhatsApp Web)
- Un cerebro, cualquiera de estos tres:
  - **API key** de Anthropic ([console.anthropic.com](https://console.anthropic.com)): Claude Sonnet 5.5, contesta en segundos
  - **Tu suscripción de Claude**, a través de Claude Code instalado en tu compu (`claude -p`). Solo para uso personal
  - **Un modelo local** con [LM Studio](https://lmstudio.ai) u [Ollama](https://ollama.com): Qwen, Gemma… Nada sale de tu compu
- Opcional: tu Vault de Obsidian y la dirección secreta iCal de tu calendario

## Instalar en una compu nueva

```bash
git clone https://github.com/Jeluva/romeo.git
cd romeo
npm install
npm run configurar
npm start
```

`npm run configurar` te pregunta quién sos, dónde está tu Vault y qué cerebro usar, y escribe dos archivos que **no se suben al repo**:

- `romeo.config.json`: tu nombre, tu Vault, qué notas puede leer, cómo se nombra tu laburo y tu estilo de respaldo. Ejemplo en `romeo.config.example.json`.
- `.env`: el cerebro y las credenciales. Ejemplo en `.env.example`. Las keys y tokens los pegás vos en ese archivo.

Si tu Vault se sincroniza con su propio repo, clonalo primero y en `configurar` poné la carpeta donde quedó.

Al correr `npm start` aparece un QR en la terminal: escanealo desde WhatsApp › Dispositivos vinculados › Vincular un dispositivo. Vinculá con tiempo: la primera vez baja tu historial para aprender cómo escribís. El tablero queda en http://localhost:4545.

## Cerebros

| Cerebro | En el `.env` | Velocidad | Notas |
| --- | --- | --- | --- |
| API | `ROMEO_PROVEEDOR=api` + `ANTHROPIC_API_KEY` | segundos | Claude Sonnet 5.5 |
| Suscripción | `ROMEO_PROVEEDOR=suscripcion` + `CLAUDE_CODE_OAUTH_TOKEN` (de `claude setup-token`) | segundos | usa tu Claude Code; uso personal |
| Local | `ROMEO_PROVEEDOR=local` + `LOCAL_BASE_URL` + `LOCAL_MODEL` | depende de tu compu | LM Studio `:1234/v1`, Ollama `:11434/v1` |

Se puede cambiar en vivo desde el tablero (tarjeta Conexión › cerebro).

**Modelos chicos** (por ejemplo Qwen 2B): Romeo usa solo un prompt compacto, con menos historial, y arma la memoria con el filtro por código, sin pasar por el modelo. En LM Studio cargá el modelo con 8k de contexto o más:

```bash
lms load <modelo> -c 8192
```

Romeo le apaga el razonamiento (thinking) a los modelos que lo traen, porque si no, una respuesta corta tarda casi un minuto.

## Cómo protege tu privacidad

- **Solo contesta chats nuevos que se anotan solos**: el primer mensaje, después de abrir el "balcón" en el tablero, tiene que traer la frase "Hola Romeo". Un chat donde vos ya escribiste nunca entra solo. Tu mamá queda afuera.
- **Lee una lista cerrada de notas**: el diario de los últimos días y las notas que pongas en `romeo.config.json`. Nunca recorre el Vault entero, y las carpetas prohibidas no se abren aunque estén en la lista.
- **Del calendario solo toma título y horario**, nunca la descripción ni el lugar.
- **Filtro doble**: un paso con el modelo arma una memoria pública, y un filtro por código tapa nombres de personas, el nombre de tu empresa, links, teléfonos y montos, tanto en la memoria como en cada respuesta.
- **El tablero escucha solo en `localhost`**, enmascara los números y nunca muestra el QR de vinculación.
- **No se suben nunca**: `auth/` (tu sesión de WhatsApp), `.env`, `romeo.config.json`, `data/`.

## Probar sin celular

```bash
npm run simulate
```

Levanta Romeo con un WhatsApp falso y tres chats de prueba: uno que se anota con "Hola Romeo", una mamá con historial que no tiene que recibir respuesta, y uno que pregunta si es un bot.

## Aviso

Romeo usa [Baileys](https://github.com/WhiskeySockets/Baileys), una librería no oficial de WhatsApp. Automatizar una cuenta personal va contra los términos de WhatsApp y puede terminar en un bloqueo. Usalo con cuidado y con un número que puedas perder.

## Licencia

MIT

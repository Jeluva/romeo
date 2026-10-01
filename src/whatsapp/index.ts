// Agente WhatsApp: conexión Baileys, solo privados, envío con demora de tipeo, marca invisible, historial para estilo.
// Habla con el resto SOLO por el bus y src/db. El QR va únicamente a la terminal.
import {
  Browsers,
  DisconnectReason,
  fetchLatestWaWebVersion,
  makeWASocket,
  useMultiFileAuthState,
  type WAMessageKey,
  type WASocket,
  type WAVersion,
  type proto,
} from 'baileys';
import pino from 'pino';
import qrcode from 'qrcode-terminal';
import { config } from '../config.js';
import type { AppContext, EnviarTexto, Eventos } from '../contract.js';
import { completarNombres, emitir as emitirEn, guardarHistorial, mensajeError, procesarMensaje } from './entrada.js';
import { crearSalida } from './salida.js';
import { codigoCierre, dormir, soloDigitos } from './util.js';

let ctx: AppContext;
let encolar: (e: EnviarTexto) => Promise<void>;
/** socket actual (cambia en cada reconexión) */
let sock: WASocket | null = null;
let abierto = false;
/** true si no hay que reconectar más (sesión cerrada o reemplazada) */
let detenido = false;
let intentos = 0;
let timerReconexion: NodeJS.Timeout | undefined;
let version: WAVersion | undefined;

/** claves de mensajes entrantes, para marcarlos como leídos al responder */
const claves = new Map<string, WAMessageKey>();
/** mensajes que mandó Romeo, por si WhatsApp pide reenviarlos (reintentos de cifrado) */
const enviados = new Map<string, proto.IMessage>();

const logger = pino({ level: 'warn' });

const emitir = <K extends keyof Eventos>(evento: K, ...args: Eventos[K]) => emitirEn(ctx.bus, evento, ...args);

export async function start(c: AppContext): Promise<void> {
  ctx = c;
  instalarRedDeSeguridad();
  encolar = crearSalida({ ctx, socketListo, claves, enviados });

  // Los oyentes del bus van una sola vez (no por socket) para no duplicar envíos al reconectar.
  ctx.bus.on('respuesta_lista', (r) => {
    if (r.modo !== 'enviar') return;
    void encolar({ jid: r.jid, texto: r.texto, disparadoPor: r.disparadoPor, propone_cita: r.propone_cita });
  });
  ctx.bus.on('enviar_texto', (e) => void encolar(e));

  // No esperamos la conexión: vincular puede tardar minutos y el resto de Romeo tiene que arrancar igual.
  void conectar().catch((err) => {
    console.error('[whatsapp] no pude arrancar la conexión:', mensajeError(err));
    reconectarLuego();
  });
}

// ---------- conexión ----------

async function conectar(): Promise<void> {
  if (detenido) return;
  const { state, saveCreds } = await useMultiFileAuthState(config.authDir);
  // Código de vinculación pedido pero nunca confirmado (me sin account): si lo dejamos, Baileys intenta
  // loguearse con un dispositivo que no existe y WhatsApp lo da por sesión cerrada. Volvemos a registrar.
  // (No usar creds.registered para esto: con QR queda en false aunque la sesión sea válida.)
  if (state.creds.me && !state.creds.account) {
    state.creds.me = undefined;
    state.creds.pairingCode = undefined;
  }
  version ??= await versionWhatsapp();

  const s = makeWASocket({
    auth: state,
    // ojo: pasar version: undefined pisa el default de Baileys y rompe; solo la mandamos si la tenemos
    ...(version ? { version } : {}),
    logger,
    // 'Desktop' (lo que sugiere el README para más historial) hoy WhatsApp lo corta con 428 al vincular
    browser: Browsers.macOS('Chrome'),
    syncFullHistory: true,
    // por defecto Baileys descarta el historial FULL; lo queremos para aprender el estilo
    shouldSyncHistoryMessage: () => true,
    markOnlineOnConnect: false,
    getMessage: async (key) => (key.id ? enviados.get(key.id) : undefined),
  });
  sock = s;
  abierto = false;

  // estado de vinculación de este socket
  let pidioCodigo = false;
  let codigoFallo = false;

  s.ev.on('creds.update', () => {
    saveCreds().catch((err) => console.error('[whatsapp] no pude guardar la sesión:', mensajeError(err)));
  });

  s.ev.on('connection.update', (u) => {
    if (s !== sock) return; // eventos de un socket viejo
    try {
      const { connection, lastDisconnect, qr } = u;

      if (qr) {
        const usarCodigo = Boolean(config.pairingPhone) && !s.authState.creds.registered && !codigoFallo;
        if (usarCodigo) {
          if (!pidioCodigo) {
            // recién con el primer QR el socket está abierto y se puede pedir el código
            pidioCodigo = true;
            void pedirCodigo(s).then((ok) => {
              if (!ok) {
                codigoFallo = true;
                imprimirQr(qr);
              }
            });
          }
        } else {
          imprimirQr(qr);
          emitir('conexion', { estado: 'esperando_vinculo' });
        }
      }

      if (connection === 'connecting') emitir('conexion', { estado: 'conectando' });

      if (connection === 'open') {
        abierto = true;
        intentos = 0;
        const como = s.user?.name ?? undefined;
        console.log(`[whatsapp] conectado${como ? ` como ${como}` : ''}`);
        emitir('conexion', { estado: 'conectado', como });
      }

      if (connection === 'close') {
        abierto = false;
        sock = null;
        manejarCierre(lastDisconnect?.error);
      }
    } catch (err) {
      console.error('[whatsapp] error en connection.update:', mensajeError(err));
    }
  });

  s.ev.on('messaging-history.set', (h) => {
    try {
      guardarHistorial(ctx, h);
    } catch (err) {
      console.error('[whatsapp] error guardando historial:', mensajeError(err));
    }
  });

  s.ev.on('messages.upsert', ({ messages, type }) => {
    // 'append' = historial, mensajes offline o ecos propios: nunca disparan nada
    if (type !== 'notify') return;
    for (const m of messages) {
      try {
        procesarMensaje(ctx, m, claves);
      } catch (err) {
        console.error('[whatsapp] error procesando un mensaje:', mensajeError(err));
      }
    }
  });

  s.ev.on('contacts.upsert', (cs) => completarNombres(ctx, cs));
  s.ev.on('contacts.update', (cs) => completarNombres(ctx, cs));
}

/** Versión actual de WhatsApp Web; si no responde en 5 s, la que trae Baileys. */
async function versionWhatsapp(): Promise<WAVersion | undefined> {
  try {
    const r = await fetchLatestWaWebVersion({ signal: AbortSignal.timeout(5000) });
    return r.isLatest ? r.version : undefined;
  } catch {
    return undefined;
  }
}

function imprimirQr(qr: string) {
  console.log('\n[whatsapp] Escaneá este QR con el teléfono: WhatsApp › Dispositivos vinculados › Vincular un dispositivo');
  qrcode.generate(qr, { small: true });
}

/** Pide el código de vinculación por número (WA_PAIRING_PHONE). */
async function pedirCodigo(s: WASocket): Promise<boolean> {
  try {
    const crudo = await s.requestPairingCode(soloDigitos(config.pairingPhone ?? ''));
    const codigo = crudo.length === 8 ? `${crudo.slice(0, 4)}-${crudo.slice(4)}` : crudo;
    console.log(
      `\n[whatsapp] Código de vinculación: ${codigo}\n` +
        '           En el teléfono: WhatsApp › Dispositivos vinculados › Vincular un dispositivo › Vincular con el número de teléfono',
    );
    emitir('conexion', { estado: 'esperando_vinculo', codigoVinculo: codigo });
    return true;
  } catch (err) {
    console.warn('[whatsapp] no pude pedir el código de vinculación, uso el QR:', mensajeError(err));
    emitir('conexion', { estado: 'esperando_vinculo' });
    return false;
  }
}

function manejarCierre(err: unknown) {
  const codigo = codigoCierre(err);

  if (codigo === DisconnectReason.loggedOut) {
    detenido = true;
    console.error(
      '[whatsapp] La sesión se cerró desde el teléfono. Para vincular de nuevo: borrá la carpeta auth/ y reiniciá Romeo.',
    );
    emitir('conexion', { estado: 'desconectado' });
    return;
  }
  if (codigo === DisconnectReason.connectionReplaced) {
    detenido = true;
    console.error('[whatsapp] Otra instancia abrió esta misma sesión. Cerrá la otra y reiniciá Romeo.');
    emitir('conexion', { estado: 'desconectado' });
    return;
  }
  if (codigo === DisconnectReason.restartRequired) {
    // normal justo después de vincular
    console.log('[whatsapp] vinculado, reiniciando la conexión…');
    emitir('conexion', { estado: 'conectando' });
    // medio segundo para que saveCreds termine de escribir la sesión nueva antes de releerla
    reconectarLuego(500);
    return;
  }

  const espera = Math.min(30_000, 1000 * 2 ** intentos);
  intentos++;
  console.warn(`[whatsapp] conexión cerrada (${codigo ?? '?'}: ${mensajeError(err)}). Reintento en ${espera / 1000} s`);
  emitir('conexion', { estado: 'conectando' });
  reconectarLuego(espera);
}

function reconectarLuego(ms = Math.min(30_000, 1000 * 2 ** intentos++)) {
  if (detenido) return;
  clearTimeout(timerReconexion);
  timerReconexion = setTimeout(() => {
    conectar().catch((err) => {
      console.error('[whatsapp] falló la reconexión:', mensajeError(err));
      reconectarLuego();
    });
  }, ms);
}

// ---------- envío (la lógica está en salida.ts) ----------

/** Devuelve el socket si está abierto; si se está reconectando, espera hasta ms. */
async function socketListo(ms: number): Promise<WASocket | null> {
  const hasta = Date.now() + ms;
  while (!(sock && abierto)) {
    if (detenido || Date.now() >= hasta) return null;
    await dormir(500);
  }
  return sock;
}

let redInstalada = false;
/** Node 24 se cae con promesas rechazadas sin manejar; Baileys a veces las deja. Las logueamos y seguimos. */
function instalarRedDeSeguridad() {
  if (redInstalada) return;
  redInstalada = true;
  process.on('unhandledRejection', (err) => {
    console.error('[romeo] promesa rechazada sin manejar:', mensajeError(err));
  });
}

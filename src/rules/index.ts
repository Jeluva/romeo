import { FRASE_OPT_IN, esChatPrivado, enmascarar, type AppContext, type MensajeEntrante, type PedirRespuesta } from '../contract.js';
import { config } from '../config.js';

// Agente Cerebro: regla por chat, opt-in con "Hola Romeo" después de la hora de corte, pausa, tope por minuto.

const DEBOUNCE_MS = 2_500;

/** minúsculas, sin tildes, sin puntuación ni emojis, espacios colapsados */
export function normalizar(texto: string): string {
  return texto
    .normalize('NFD')
    .replace(/\p{M}/gu, '')
    .toLowerCase()
    .replace(/[^\p{L}\p{N}]+/gu, ' ')
    .trim();
}

const FRASE = normalizar(FRASE_OPT_IN);

function contieneFrase(texto: string): boolean {
  return ` ${normalizar(texto)} `.includes(` ${FRASE} `);
}

/** Si el dueño ya le escribió alguna vez a este chat, es una relación existente: nunca entra solo. */
function tieneHistorialDeJero(ctx: AppContext, jid: string): boolean {
  const row = ctx.db.sql.prepare('SELECT 1 AS x FROM style_samples WHERE jid = ? LIMIT 1').get(jid);
  return row !== undefined;
}

/** Un listener de otro módulo que tire una excepción no puede voltear las reglas. */
function seguro(que: string, fn: () => void) {
  try {
    fn();
  } catch (e) {
    console.warn(`[reglas] un listener de '${que}' falló: ${(e as Error).message}`);
  }
}

function pedir(ctx: AppContext, p: PedirRespuesta) {
  seguro('pedir_respuesta', () => ctx.bus.emit('pedir_respuesta', p));
}

export async function start(ctx: AppContext): Promise<void> {
  const pendientes = new Map<string, { timer: NodeJS.Timeout; disparadoPor: string }>();

  function disparar(jid: string, disparadoPor: string) {
    try {
      if (ctx.db.pausado()) return;
      // la regla puede haber cambiado en el tablero durante la espera: manda la actual
      const chat = ctx.db.getChat(jid);
      if (!chat) return;
      if (chat.regla === 'auto') {
        const enelminuto = ctx.db.countRomeoSince(jid, Date.now() - 60_000);
        if (enelminuto >= config.maxRespuestasPorMinuto) {
          console.warn(`[reglas] ${enmascarar(jid, chat.nombre)}: tope de ${config.maxRespuestasPorMinuto} respuestas por minuto, no contesto`);
          return;
        }
        pedir(ctx, { jid, disparadoPor, modo: 'enviar' });
      } else if (chat.regla === 'sugerir') {
        pedir(ctx, { jid, disparadoPor, modo: 'borrador' });
      }
    } catch (e) {
      console.warn(`[reglas] error al disparar: ${(e as Error).message}`);
    }
  }

  function programar(jid: string, disparadoPor: string) {
    const previo = pendientes.get(jid);
    if (previo) clearTimeout(previo.timer);
    // si llegan varios seguidos, contesta una sola vez, por el último
    const timer = setTimeout(() => {
      pendientes.delete(jid);
      disparar(jid, disparadoPor);
    }, DEBOUNCE_MS);
    pendientes.set(jid, { timer, disparadoPor });
  }

  ctx.bus.on('mensaje_entrante', (msg: MensajeEntrante) => {
    try {
      if (!msg?.jid || !esChatPrivado(msg.jid)) return;
      if (ctx.db.pausado()) return;

      let chat = ctx.db.getChat(msg.jid) ?? ctx.db.ensureChat(msg.jid, msg.nombre ?? null);

      // Opt-in: solo un chat nuevo, después de la hora de corte, que escribe la frase del QR,
      // y con el que el dueño nunca habló (así Romeo no le contesta a la mamá en el escenario).
      const corte = ctx.db.horaCorte();
      if (
        chat.opt_in === 0 &&
        corte !== undefined &&
        Number.isFinite(corte) &&
        msg.at >= corte &&
        contieneFrase(msg.texto ?? '') &&
        !tieneHistorialDeJero(ctx, msg.jid)
      ) {
        ctx.db.updateChat(msg.jid, { opt_in: 1, regla: 'auto' });
        console.log(`[reglas] ${enmascarar(msg.jid, msg.nombre)} entró con la frase del QR: modo auto`);
        seguro('chat_actualizado', () => ctx.bus.emit('chat_actualizado', { jid: msg.jid }));
        chat = ctx.db.getChat(msg.jid) ?? chat;
      }

      if (!(msg.texto ?? '').trim()) return; // sin texto (foto, audio...): no disparo nada
      if (chat.regla === 'auto' || chat.regla === 'sugerir') programar(msg.jid, msg.id);
    } catch (e) {
      console.warn(`[reglas] error con un mensaje entrante: ${(e as Error).message}`);
    }
  });
}

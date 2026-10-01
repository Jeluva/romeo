// Lo que sale hacia WhatsApp: cola por chat, pausa, leído, tipeo simulado, marca invisible y registro en la base.
import type { WAMessageKey, WASocket, proto } from 'baileys';
import { MARCA_ROMEO, enmascarar, type AppContext, type EnviarTexto } from '../contract.js';
import { emitir, guardarAcotado, mensajeError } from './entrada.js';
import { dormir, sinColgarse, typingDelayMs } from './util.js';

/** Lo único del socket que usa el envío (así se puede probar con uno falso). */
export type SocketEnvio = Pick<WASocket, 'readMessages' | 'sendPresenceUpdate' | 'sendMessage'>;

export interface OpcionesSalida {
  ctx: AppContext;
  /** socket abierto, esperando hasta ms si se está reconectando; null si no hay */
  socketListo: (ms: number) => Promise<SocketEnvio | null>;
  /** claves de mensajes entrantes por id (para marcarlos como leídos) */
  claves: Map<string, WAMessageKey>;
  /** mensajes enviados por id (para reintentos de cifrado) */
  enviados: Map<string, proto.IMessage>;
  /** demora de tipeo; se puede acortar en pruebas */
  demora?: (texto: string) => number;
}

/** Devuelve encolar(e): serializa los envíos por chat; un error no traba la cola. */
export function crearSalida(o: OpcionesSalida) {
  const { ctx, claves, enviados } = o;
  const demora = o.demora ?? typingDelayMs;
  const colas = new Map<string, Promise<void>>();

  function encolar(e: EnviarTexto): Promise<void> {
    if (!e?.jid) return Promise.resolve();
    const previa = colas.get(e.jid) ?? Promise.resolve();
    const tarea = previa
      .then(() => enviar(e))
      .catch((err) => console.error(`[whatsapp] no pude enviar a ${enmascarar(e.jid)}:`, mensajeError(err)));
    colas.set(e.jid, tarea);
    void tarea.finally(() => {
      if (colas.get(e.jid) === tarea) colas.delete(e.jid);
    });
    return tarea;
  }

  async function enviar(e: EnviarTexto) {
    const jid = e.jid;
    // la marca se agrega acá; en la base va el texto limpio
    const texto = (e.texto ?? '').replaceAll(MARCA_ROMEO, '');
    if (!texto.trim()) return;
    const quien = enmascarar(jid, ctx.db.getChat(jid)?.nombre);

    if (ctx.db.pausado()) {
      console.log(`[whatsapp] Romeo está en pausa: no envío a ${quien}`);
      return;
    }
    let s = await o.socketListo(15_000);
    if (!s) {
      console.warn(`[whatsapp] sin conexión: descarto la respuesta a ${quien}`);
      return;
    }

    const clave = e.disparadoPor ? claves.get(e.disparadoPor) : undefined;
    if (clave) await sinColgarse(s.readMessages([clave]), 5000);

    // tipeo simulado: sin "available" antes, WhatsApp no muestra "escribiendo…"
    await sinColgarse(s.sendPresenceUpdate('available'), 5000);
    await sinColgarse(s.sendPresenceUpdate('composing', jid), 5000);
    await dormir(demora(texto));
    await sinColgarse(s.sendPresenceUpdate('paused', jid), 5000);

    if (ctx.db.pausado()) {
      console.log(`[whatsapp] Romeo se pausó mientras tipeaba: no envío a ${quien}`);
      return;
    }
    s = await o.socketListo(10_000);
    if (!s) {
      console.warn(`[whatsapp] se cortó la conexión: descarto la respuesta a ${quien}`);
      return;
    }

    const enviado = await s.sendMessage(jid, { text: texto + MARCA_ROMEO });
    const at = Date.now();
    const id = enviado?.key?.id ?? `romeo-${at}-${Math.random().toString(36).slice(2, 8)}`;
    if (enviado?.message) guardarAcotado(enviados, id, enviado.message, 500);

    const origen = e.disparadoPor ? ctx.db.getMessage(e.disparadoPor) : undefined;
    const latencia_ms = origen ? at - origen.at : null;
    ctx.db.insertMessage({
      id,
      jid,
      autor: 'romeo',
      texto,
      at,
      propone_cita: e.propone_cita ? 1 : 0,
      latencia_ms,
      respuesta_a: e.disparadoPor ?? null,
    });
    console.log(`[whatsapp] → ${quien} (${latencia_ms != null ? `${Math.round(latencia_ms / 1000)} s` : 'manual'})`);
    emitir(ctx.bus, 'mensaje_enviado', { jid, id, texto, at, latencia_ms });
    emitir(ctx.bus, 'chat_actualizado', { jid });
  }

  return encolar;
}

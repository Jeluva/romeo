// Lo que entra desde WhatsApp: mensajes en vivo, historial y contactos. No toca el socket (se prueba sin teléfono).
import { jidNormalizedUser, type BaileysEventMap, type Contact, type WAMessage, type WAMessageKey } from 'baileys';
import { MARCA_ROMEO, enmascarar, esChatPrivado, type AppContext, type Bus, type Eventos } from '../contract.js';
import type { Db } from '../db/index.js';
import { esJidPersona, extractText, recortar, toMs } from './util.js';

/** Todo lo anterior a esto es historial: nunca dispara respuestas. */
export const CORTE = Date.now() - 5000;

/** jid normalizado si es un chat privado con una persona; si no, null. */
export function normalizar(jid: string | null | undefined): string | null {
  if (!jid) return null;
  const n = jidNormalizedUser(jid);
  return n && esChatPrivado(n) && esJidPersona(n) ? n : null;
}

/** Emite en el bus sin que un oyente roto de otro módulo nos corte el flujo. */
export function emitir<K extends keyof Eventos>(bus: Bus, evento: K, ...args: Eventos[K]) {
  try {
    (bus.emit as (e: K, ...a: Eventos[K]) => boolean).call(bus, evento, ...args);
  } catch (err) {
    console.error(`[whatsapp] un oyente de '${evento}' falló:`, mensajeError(err));
  }
}

/**
 * Mensaje de messages.upsert 'notify'. Devuelve true si era un mensaje nuevo de un contacto
 * (ya guardado y emitido como mensaje_entrante).
 */
export function procesarMensaje(ctx: AppContext, m: WAMessage, claves: Map<string, WAMessageKey>): boolean {
  const key = m.key;
  const id = key?.id;
  if (!id) return false;
  const jid = normalizar(key.remoteJid);
  if (!jid) return false;
  if (m.messageStubType) return false;
  const texto = extractText(m.message);
  if (!texto) return false;
  const at = toMs(m.messageTimestamp) || Date.now();
  if (at < CORTE) return false; // historial repetido: jamás responder
  if (ctx.db.getMessage(id)) return false; // ya procesado (WhatsApp a veces reenvía con el mismo id)

  if (key.fromMe) {
    if (texto.includes(MARCA_ROMEO)) return false; // eco de Romeo
    // el dueño escribiendo desde el teléfono
    ctx.db.ensureChat(jid, null);
    ctx.db.insertMessage({ id, jid, autor: 'vos', texto, at });
    ctx.db.insertStyleSample(id, jid, texto, at);
    emitir(ctx.bus, 'chat_actualizado', { jid });
    return false;
  }

  const nombre = m.pushName || undefined;
  const chat = ctx.db.ensureChat(jid, nombre ?? null);
  if (chat.primer_mensaje_at == null) ctx.db.updateChat(jid, { primer_mensaje_at: at });
  ctx.db.insertMessage({ id, jid, autor: 'contacto', texto, at });
  guardarAcotado(claves, id, key, 2000);
  console.log(`[whatsapp] ← ${enmascarar(jid, nombre ?? chat.nombre)}: "${recortar(texto)}"`);
  emitir(ctx.bus, 'mensaje_entrante', { jid, id, texto, at, nombre });
  emitir(ctx.bus, 'chat_actualizado', { jid });
  return true;
}

/** messaging-history.set: solo guarda tus mensajes como ejemplos de estilo y los nombres. Nunca emite mensaje_entrante. */
export function guardarHistorial(ctx: AppContext, h: BaileysEventMap['messaging-history.set']) {
  const nombres = nombresDe(h.contacts ?? []);
  for (const ch of h.chats ?? []) {
    const jid = normalizar(ch.id);
    if (jid && ch.name && !nombres.has(jid)) nombres.set(jid, ch.name);
  }

  // chat → mensaje más viejo visto en este lote (0 si ninguno tenía fecha)
  const primeros = new Map<string, number>();
  let muestras = 0;

  transaccion(ctx.db, () => {
    for (const m of h.messages ?? []) {
      try {
        const jid = normalizar(m.key?.remoteJid);
        if (!jid) continue;
        const at = toMs(m.messageTimestamp);
        const previo = primeros.get(jid);
        if (previo === undefined || (at && (previo === 0 || at < previo))) primeros.set(jid, at);

        if (!m.key.fromMe || !m.key.id || m.messageStubType) continue;
        const texto = extractText(m.message);
        if (!texto || texto.includes(MARCA_ROMEO)) continue;
        ctx.db.insertStyleSample(m.key.id, jid, texto, at || Date.now());
        muestras++;
      } catch {
        // un mensaje raro no frena el lote
      }
    }

    for (const [jid, primero] of primeros) {
      try {
        const chat = ctx.db.ensureChat(jid, nombres.get(jid) ?? null);
        // chats viejos: el primer mensaje sale del historial, así no parecen chats nuevos
        if (primero && (chat.primer_mensaje_at == null || primero < chat.primer_mensaje_at)) {
          ctx.db.updateChat(jid, { primer_mensaje_at: primero });
        }
      } catch {
        // seguimos con el resto
      }
    }

    // nombres para chats que ya existen (no creamos un chat por cada contacto de la agenda)
    for (const [jid, nombre] of nombres) {
      if (primeros.has(jid)) continue;
      try {
        const chat = ctx.db.getChat(jid);
        if (chat && !chat.nombre) ctx.db.updateChat(jid, { nombre });
      } catch {
        // idem
      }
    }
  });

  for (const jid of primeros.keys()) emitir(ctx.bus, 'chat_actualizado', { jid });
  if (primeros.size || muestras) {
    console.log(`[whatsapp] historial: ${muestras} mensajes tuyos para estilo, ${primeros.size} chats privados`);
  }
}

/** contacts.upsert / update: solo completa nombres faltantes de chats que ya existen. */
export function completarNombres(ctx: AppContext, contactos: Partial<Contact>[]) {
  try {
    for (const [jid, nombre] of nombresDe(contactos)) {
      const chat = ctx.db.getChat(jid);
      if (chat && !chat.nombre) {
        ctx.db.updateChat(jid, { nombre });
        emitir(ctx.bus, 'chat_actualizado', { jid });
      }
    }
  } catch (err) {
    console.error('[whatsapp] error actualizando contactos:', mensajeError(err));
  }
}

/** Nombre por jid (id, lid y número): el agendado, o el que se puso la persona. */
function nombresDe(contactos: Partial<Contact>[]): Map<string, string> {
  const nombres = new Map<string, string>();
  for (const c of contactos) {
    const nombre = c.name || c.notify || c.verifiedName;
    if (!nombre) continue;
    for (const j of [c.id, c.lid, c.phoneNumber]) {
      const jid = normalizar(j);
      if (jid) nombres.set(jid, nombre);
    }
  }
  return nombres;
}

/** BEGIN/COMMIT alrededor de un bloque sincrónico: miles de inserts del historial sin trabar el proceso. */
function transaccion(db: Db, fn: () => void) {
  let abierta = false;
  try {
    db.sql.exec('BEGIN');
    abierta = true;
  } catch {
    // ya había una transacción abierta: seguimos sin la nuestra
  }
  try {
    fn();
  } finally {
    if (abierta) {
      try {
        db.sql.exec('COMMIT');
      } catch (err) {
        console.error('[whatsapp] no pude cerrar la transacción del historial:', mensajeError(err));
        try {
          db.sql.exec('ROLLBACK');
        } catch {
          // nada más que hacer
        }
      }
    }
  }
}

/** Map con tope: al pasarse, borra el más viejo. */
export function guardarAcotado<V>(mapa: Map<string, V>, k: string, v: V, max: number) {
  mapa.set(k, v);
  if (mapa.size > max) {
    const primero = mapa.keys().next().value;
    if (primero !== undefined) mapa.delete(primero);
  }
}

/** Mensaje de error corto para logs (nunca el objeto entero: puede traer datos de la sesión). */
export function mensajeError(err: unknown): string {
  const t = err instanceof Error ? err.message : String(err);
  return t.length > 200 ? `${t.slice(0, 200)}…` : t;
}

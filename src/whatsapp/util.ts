// Ayudantes puros del agente WhatsApp: se pueden probar sin teléfono (solo importan tipos de Baileys).
import type { proto } from 'baileys';

type Contenido = proto.IMessage | null | undefined;

/** Saca envoltorios (mensajes temporales, enviados desde otro dispositivo, etc.), igual que normalizeMessageContent de Baileys. */
function desenvolver(m: Contenido): Contenido {
  let c = m;
  for (let i = 0; i < 5 && c; i++) {
    const interno =
      c.ephemeralMessage?.message ??
      c.deviceSentMessage?.message ??
      c.viewOnceMessage?.message ??
      c.viewOnceMessageV2?.message ??
      c.viewOnceMessageV2Extension?.message ??
      c.documentWithCaptionMessage?.message;
    if (!interno) break;
    c = interno;
  }
  return c;
}

/** Texto plano del mensaje, o null si es multimedia, reacción, protocolo/edición o vacío. */
export function extractText(m: Contenido): string | null {
  const c = desenvolver(m);
  if (!c) return null;
  // ediciones (editedMessage), protocolo, reacciones y votos no son mensajes nuevos
  if (c.editedMessage || c.protocolMessage || c.reactionMessage || c.pollUpdateMessage) return null;
  const texto = c.conversation ?? c.extendedTextMessage?.text ?? null;
  if (typeof texto !== 'string') return null;
  return texto.trim() ? texto : null;
}

/** Timestamp de WhatsApp (segundos; number, Long, bigint o string) a epoch ms. 0 si no se puede leer. */
export function toMs(t: unknown): number {
  let s = 0;
  if (typeof t === 'number') s = t;
  else if (typeof t === 'bigint') s = Number(t);
  else if (typeof t === 'string') s = Number(t);
  else if (t && typeof t === 'object') {
    const l = t as { toNumber?: () => number; low?: number };
    s = typeof l.toNumber === 'function' ? l.toNumber() : Number(l.low ?? 0);
  }
  return Number.isFinite(s) && s > 0 ? Math.round(s * 1000) : 0;
}

/** Demora de tipeo simulada: 1,5 s + 60 ms por carácter, entre 2 y 9 s, más hasta 800 ms de azar. */
export function typingDelayMs(texto: string, azar: () => number = Math.random): number {
  const base = Math.min(9000, Math.max(2000, 1500 + 60 * texto.length));
  return base + Math.floor(azar() * 800);
}

/** Solo personas: @s.whatsapp.net o @lid (y sus variantes hosted). Deja afuera bots, llamadas y el canal oficial 0@. */
export function esJidPersona(jid: string): boolean {
  if (jid.startsWith('0@')) return false;
  return /@(s\.whatsapp\.net|lid|hosted|hosted\.lid)$/.test(jid);
}

/** Recorta textos para los logs (nunca logueamos mensajes completos de contactos). */
export function recortar(texto: string, n = 40): string {
  const plano = texto.replace(/\s+/g, ' ').trim();
  return plano.length > n ? `${plano.slice(0, n)}…` : plano;
}

/** Solo dígitos, para requestPairingCode (sin +, espacios ni guiones). */
export function soloDigitos(tel: string): string {
  return tel.replace(/\D/g, '');
}

/** Código de cierre de Baileys (Boom.output.statusCode) sin importar @hapi/boom. */
export function codigoCierre(err: unknown): number | undefined {
  const c = (err as { output?: { statusCode?: unknown } } | undefined)?.output?.statusCode;
  return typeof c === 'number' ? c : undefined;
}

/** Espera ms milisegundos. */
export const dormir = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));

/** Corre la promesa pero no espera más de ms; si tarda o falla, sigue de largo (para presencia y leídos). */
export async function sinColgarse(p: Promise<unknown>, ms: number): Promise<boolean> {
  let timer: NodeJS.Timeout | undefined;
  try {
    return await Promise.race([
      p.then(() => true),
      new Promise<boolean>((r) => {
        timer = setTimeout(() => r(false), ms);
      }),
    ]);
  } catch {
    return false;
  } finally {
    clearTimeout(timer);
  }
}

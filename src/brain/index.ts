import {
  MARCA_ROMEO,
  enmascarar,
  type AppContext,
  type Categoria,
  type MensajeEntrante,
  type PedirRespuesta,
  type RespuestaLista,
} from '../contract.js';
import type { Mensaje } from '../db/index.js';
import { memoriaActual, nombresPrivados } from '../memory/index.js';
import { contieneEmpresa, nombresEn } from '../memory/privacidad.js';
import { hayApi, pedirJson } from './claude.js';
import { persona } from '../persona.js';
import { respuestaDePrueba, type Salida } from './mock.js';
import type Anthropic from '@anthropic-ai/sdk';
import {
  CATEGORIAS,
  SCHEMA_RESPUESTA,
  armarHistorial,
  limpiarInvisibles,
  sistemaCompacto,
  sistemaEstable,
  sistemaVolatil,
} from './prompt.js';
import { proveedorActivo } from './proveedores.js';
import { estiloActual } from './style.js';

// Agente Cerebro: estilo, prompt y llamada a Claude Sonnet 5.5 con salida estructurada.

const MAX_CONCURRENCIA = 4;
const HISTORIAL = 20;

// ---------- concurrencia: un pedido por chat, hasta 4 en total ----------

let enCurso = 0;
const enEspera: (() => void)[] = [];

async function tomarCupo(): Promise<void> {
  if (enCurso < MAX_CONCURRENCIA) {
    enCurso++;
    return;
  }
  await new Promise<void>((r) => enEspera.push(r)); // el cupo se pasa directo al que espera
}

function soltarCupo() {
  const siguiente = enEspera.shift();
  if (siguiente) siguiente();
  else enCurso--;
}

/** Chats con un pedido corriendo; `pendiente` es el último que llegó mientras tanto. */
const porChat = new Map<string, { pendiente?: PedirRespuesta }>();

/** Respaldo por si whatsapp todavía no guardó el entrante en la tabla messages. */
const entrantesRecientes = new Map<string, MensajeEntrante[]>();

// ---------- respuesta ----------

const EMOJI_G = /[\p{Extended_Pictographic}\u{1F1E6}-\u{1F1FF}️⃣]/gu;

function escaparRegex(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

export function pulir(texto: string): string {
  return limpiarInvisibles(texto.replaceAll(MARCA_ROMEO, ''))
    .replace(EMOJI_G, '')
    .trim()
    .replace(/^["“'](.*)["”']$/s, '$1')
    .replace(new RegExp(`^\\s*(${escaparRegex(persona.nombre)}|romeo)\\s*:\\s*`, 'i'), '')
    .trim()
    .replace(/\.+$/, '') // nunca termina con punto
    .trim()
    .slice(0, 700);
}

function validar(data: unknown): Salida | undefined {
  if (!data || typeof data !== 'object') return undefined;
  const d = data as Record<string, unknown>;
  if (typeof d.texto !== 'string') return undefined;
  const categoria = (CATEGORIAS as readonly string[]).includes(d.categoria as string)
    ? (d.categoria as Categoria)
    : 'desconocido';
  const n = typeof d.interes === 'number' && Number.isFinite(d.interes) ? d.interes : 0;
  return {
    texto: d.texto,
    propone_cita: d.propone_cita === true,
    categoria,
    interes: Math.max(0, Math.min(100, Math.round(n))),
  };
}

function historialDe(ctx: AppContext, jid: string): Pick<Mensaje, 'autor' | 'texto' | 'id' | 'at'>[] {
  const filas: Pick<Mensaje, 'autor' | 'texto' | 'id' | 'at'>[] = ctx.db.recentMessages(jid, HISTORIAL);
  const ids = new Set(filas.map((f) => f.id));
  const ultimoAt = filas.length ? filas[filas.length - 1].at : -Infinity;
  const faltan = (entrantesRecientes.get(jid) ?? []).filter((m) => !ids.has(m.id) && m.at >= ultimoAt);
  if (!faltan.length) return filas;
  return [...filas, ...faltan.map((m) => ({ id: m.id, at: m.at, autor: 'contacto' as const, texto: m.texto }))]
    .sort((a, b) => a.at - b.at)
    .slice(-HISTORIAL);
}

/** Los últimos n turnos, arrancando siempre con un mensaje del contacto. */
function recortarTurnos(turnos: ReturnType<typeof armarHistorial>, n: number): ReturnType<typeof armarHistorial> {
  const t = turnos.slice(-n);
  while (t.length > 1 && t[0].role !== 'user') t.shift();
  return t;
}

async function generar(ctx: AppContext, turnos: ReturnType<typeof armarHistorial>): Promise<Salida | undefined> {
  const memoria = memoriaActual();
  if (!hayApi()) {
    const ultimo = turnos[turnos.length - 1].content;
    return respuestaDePrueba(typeof ultimo === 'string' ? ultimo.split('\n').pop() ?? '' : '', memoria);
  }
  const estilo = estiloActual(ctx.db);
  // un modelo local chico se pierde con el prompt largo: versión compacta y menos historial
  const compacto = proveedorActivo() === 'local';
  const system: Anthropic.Beta.BetaTextBlockParam[] = compacto
    ? [{ type: 'text', text: sistemaCompacto(estilo, Date.now(), memoria) }]
    : [
        { type: 'text', text: sistemaEstable(estilo), cache_control: { type: 'ephemeral' } },
        { type: 'text', text: sistemaVolatil(Date.now(), memoria) },
      ];
  const r = await pedirJson({
    etiqueta: 'respuesta',
    system,
    messages: compacto ? recortarTurnos(turnos, 6) : turnos,
    schema: SCHEMA_RESPUESTA,
    effort: 'low',
    maxTokens: compacto ? 300 : 4_000,
    timeoutMs: 45_000,
  });
  if (!r.ok) {
    console.warn(`[cerebro] sin respuesta del modelo: ${r.motivo}`);
    return undefined;
  }
  const salida = validar(r.data);
  if (!salida) console.warn('[cerebro] la respuesta no cumple el esquema');
  return salida;
}

async function procesar(ctx: AppContext, req: PedirRespuesta): Promise<void> {
  const quien = enmascarar(req.jid, ctx.db.getChat(req.jid)?.nombre);
  await tomarCupo();
  const t0 = Date.now();
  try {
    if (req.modo === 'enviar' && ctx.db.pausado()) return;

    const mensajes = historialDe(ctx, req.jid);
    const turnos = armarHistorial(mensajes);
    if (!turnos.length) {
      console.log(`[cerebro] ${quien}: no hay mensaje nuevo del contacto, no contesto`);
      return;
    }

    const salida = await generar(ctx, turnos);
    if (!salida) return;
    const texto = pulir(salida.texto);
    if (!texto) {
      console.log(`[cerebro] ${quien}: respuesta vacía, no mando nada`);
      return;
    }

    // red de seguridad: nada del laburo ni nombres de su vida que el contacto no haya dicho antes
    const delContacto = mensajes.filter((m) => m.autor === 'contacto').map((m) => m.texto).join('\n');
    const ajenos = nombresEn(texto, nombresPrivados()).filter((n) => !nombresEn(delContacto, [n]).length);
    if (contieneEmpresa(texto) || ajenos.length) {
      console.warn(`[cerebro] ${quien}: la respuesta tenía datos privados, no la mando`);
      return;
    }

    ctx.db.updateChat(req.jid, { categoria: salida.categoria, interes: salida.interes });

    if (req.modo === 'enviar') {
      // el pedido tarda segundos: la pausa o un cambio de regla en el tablero ganan
      if (ctx.db.pausado()) return;
      if (ctx.db.getChat(req.jid)?.regla !== 'auto') {
        console.log(`[cerebro] ${quien}: la regla cambió mientras pensaba, no mando`);
        return;
      }
    } else {
      ctx.db.insertDraft(req.jid, texto, req.disparadoPor);
    }

    const lista: RespuestaLista = {
      jid: req.jid,
      texto,
      propone_cita: salida.propone_cita,
      categoria: salida.categoria,
      interes: salida.interes,
      modo: req.modo,
      disparadoPor: req.disparadoPor,
    };
    seguro('chat_actualizado', () => ctx.bus.emit('chat_actualizado', { jid: req.jid }));
    seguro('respuesta_lista', () => ctx.bus.emit('respuesta_lista', lista));
    console.log(`[cerebro] ${quien}: respuesta lista (${req.modo}) en ${((Date.now() - t0) / 1000).toFixed(1)} s`);
  } finally {
    soltarCupo();
  }
}

function seguro(que: string, fn: () => void) {
  try {
    fn();
  } catch (e) {
    console.warn(`[cerebro] un listener de '${que}' falló: ${(e as Error).message}`);
  }
}

async function correr(ctx: AppContext, primero: PedirRespuesta): Promise<void> {
  let req: PedirRespuesta | undefined = primero;
  try {
    while (req) {
      try {
        await procesar(ctx, req);
      } catch (e) {
        console.warn(`[cerebro] error con un pedido: ${(e as Error).message?.slice(0, 160)}`);
      }
      const estado = porChat.get(primero.jid);
      req = estado?.pendiente;
      if (estado) estado.pendiente = undefined;
    }
  } finally {
    porChat.delete(primero.jid);
  }
}

export async function start(ctx: AppContext): Promise<void> {
  ctx.bus.on('mensaje_entrante', (m: MensajeEntrante) => {
    try {
      if (!m?.jid || !m.texto) return;
      const lista = entrantesRecientes.get(m.jid) ?? [];
      lista.push(m);
      entrantesRecientes.set(m.jid, lista.slice(-10));
    } catch {
      // solo es un respaldo
    }
  });

  ctx.bus.on('pedir_respuesta', (req: PedirRespuesta) => {
    try {
      if (!req?.jid) return;
      const estado = porChat.get(req.jid);
      if (estado) {
        estado.pendiente = req; // ya hay uno corriendo: este va después (y pisa a otros en espera)
        return;
      }
      porChat.set(req.jid, {});
      void correr(ctx, req);
    } catch (e) {
      console.warn(`[cerebro] error al recibir un pedido: ${(e as Error).message}`);
    }
  });

}

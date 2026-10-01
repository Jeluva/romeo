// Llamada a Claude Sonnet 5.5 con salida estructurada (output_config.format), fallback del lado
// del servidor y manejo de stop_reason antes de leer el contenido. Lo usan el cerebro y la memoria.
// pedirJson() reparte según el proveedor elegido: API, suscripción (Claude Code) o modelo local.
import Anthropic from '@anthropic-ai/sdk';
import { config } from '../config.js';
import { pedirLocal } from './local.js';
import { proveedorActivo } from './proveedores.js';
import { pedirSuscripcion } from './suscripcion.js';

export type Esfuerzo = 'low' | 'medium' | 'high';

export interface PedidoJson {
  /** para los logs */
  etiqueta: string;
  /** bloques de system: el estable con cache_control primero, lo volátil después */
  system: Anthropic.Beta.BetaTextBlockParam[];
  messages: Anthropic.Beta.BetaMessageParam[];
  schema: Record<string, unknown>;
  effort: Esfuerzo;
  maxTokens: number;
  timeoutMs: number;
}

export type ResultadoJson = { ok: true; data: unknown; modelo: string } | { ok: false; motivo: string };

/** true si hay un modelo de verdad para contestar (API, suscripción o local); false = modo prueba. */
export function hayApi(): boolean {
  return proveedorActivo() !== 'prueba';
}

let cliente: Anthropic | undefined;
function getCliente(): Anthropic {
  // el SDK ya reintenta 429/5xx/conexión; el timeout corto evita trabar un chat 10 minutos
  cliente ??= new Anthropic({ apiKey: config.anthropicApiKey, maxRetries: 2, timeout: 45_000 });
  return cliente;
}

/** Si el pedido con fallbacks dio 400 y sin fallbacks anduvo, no lo volvemos a intentar. */
let sinFallbacks = false;

export function describirError(e: unknown): string {
  if (e instanceof Anthropic.RateLimitError) return 'límite de uso (429)';
  if (e instanceof Anthropic.AuthenticationError) return 'API key inválida (401)';
  if (e instanceof Anthropic.PermissionDeniedError) return 'sin permiso (403)';
  if (e instanceof Anthropic.BadRequestError) return `pedido inválido (400): ${e.message.slice(0, 200)}`;
  if (e instanceof Anthropic.APIConnectionTimeoutError) return 'timeout';
  if (e instanceof Anthropic.APIConnectionError) return 'sin conexión';
  if (e instanceof Anthropic.APIError) return `error de la API ${e.status ?? ''}`.trim();
  return e instanceof Error ? e.message.slice(0, 200) : 'error desconocido';
}

interface Respuesta {
  stop_reason: string | null;
  categoriaRechazo: string | null;
  bloques: { type: string; text?: string }[];
  modelo: string;
  cacheLeido: number;
  cacheEscrito: number;
}

async function crear(p: PedidoJson): Promise<Respuesta> {
  const base = {
    model: config.model,
    max_tokens: p.maxTokens,
    system: p.system,
    messages: p.messages,
    output_config: {
      effort: p.effort,
      format: { type: 'json_schema' as const, schema: p.schema },
    },
  } satisfies Anthropic.Beta.MessageCreateParamsNonStreaming;
  const opciones = { timeout: p.timeoutMs };

  const normalizar = (m: Anthropic.Beta.BetaMessage | Anthropic.Message): Respuesta => ({
    stop_reason: m.stop_reason,
    categoriaRechazo: m.stop_details?.category ?? null,
    bloques: m.content as { type: string; text?: string }[],
    modelo: m.model,
    cacheLeido: m.usage.cache_read_input_tokens ?? 0,
    cacheEscrito: m.usage.cache_creation_input_tokens ?? 0,
  });

  if (!sinFallbacks) {
    try {
      const conFallbacks: Anthropic.Beta.MessageCreateParamsNonStreaming = {
        ...base,
        betas: ['server-side-fallback-2026-07-01'],
        fallbacks: 'default',
      };
      return normalizar(await getCliente().beta.messages.create(conFallbacks, opciones));
    } catch (e) {
      if (!(e instanceof Anthropic.BadRequestError)) throw e;
      console.warn(`[claude] ${p.etiqueta}: con fallbacks dio 400, reintento sin fallbacks`);
      const r = await getCliente().messages.create(base as Anthropic.MessageCreateParamsNonStreaming, opciones);
      sinFallbacks = true; // anduvo sin fallbacks: el 400 era por los fallbacks
      return normalizar(r);
    }
  }
  return normalizar(await getCliente().messages.create(base as Anthropic.MessageCreateParamsNonStreaming, opciones));
}

/** Llama a Claude y devuelve el JSON ya parseado, o el motivo por el que no hay nada que usar. */
export async function pedirJson(p: PedidoJson): Promise<ResultadoJson> {
  const proveedor = proveedorActivo();
  if (proveedor === 'suscripcion') return pedirSuscripcion(p);
  if (proveedor === 'local') return pedirLocal(p);
  if (proveedor === 'prueba') return { ok: false, motivo: 'modo prueba' };
  return pedirApi(p);
}

async function pedirApi(p: PedidoJson): Promise<ResultadoJson> {
  let r: Respuesta;
  try {
    r = await crear(p);
  } catch (e) {
    return { ok: false, motivo: describirError(e) };
  }

  // stop_reason antes que el contenido: solo end_turn trae una respuesta completa
  if (r.stop_reason === 'refusal') {
    return { ok: false, motivo: `rechazo (${r.categoriaRechazo ?? 'sin categoría'})` };
  }
  if (r.stop_reason === 'max_tokens') return { ok: false, motivo: 'se cortó por max_tokens' };
  if (r.stop_reason !== 'end_turn') return { ok: false, motivo: `stop_reason inesperado: ${r.stop_reason}` };

  // si hubo fallback, lo que vale es lo que viene después del último bloque fallback
  const ultimoFallback = r.bloques.map((b) => b.type).lastIndexOf('fallback');
  const texto = r.bloques
    .slice(ultimoFallback + 1)
    .filter((b) => b.type === 'text' && typeof b.text === 'string')
    .map((b) => b.text)
    .join('')
    .trim();
  if (!texto) return { ok: false, motivo: 'respuesta sin texto' };

  let data: unknown;
  try {
    data = JSON.parse(texto);
  } catch {
    return { ok: false, motivo: 'JSON inválido' };
  }
  if (r.cacheLeido || r.cacheEscrito) {
    console.log(`[claude] ${p.etiqueta}: caché leída ${r.cacheLeido} / escrita ${r.cacheEscrito} tokens`);
  }
  return { ok: true, data, modelo: r.modelo };
}

// Proveedor "local": un modelo corriendo en tu compu (LM Studio u Ollama) por su API compatible con
// OpenAI (/v1/chat/completions). Nada sale de la compu.
import { config } from '../config.js';
import type { PedidoJson, ResultadoJson } from './claude.js';
import { extraerJson, mensajesPlanos, textoDeSystem } from './formato.js';

let modeloDescubierto: string | undefined;
/** Si el servidor no acepta response_format con json_schema, se pide JSON solo por instrucción. */
let sinEsquema = false;

async function modeloLocal(): Promise<string> {
  if (config.localModelo) return config.localModelo;
  if (modeloDescubierto) return modeloDescubierto;
  const r = await fetch(`${config.localBaseUrl}/models`, { signal: AbortSignal.timeout(5_000) });
  if (!r.ok) throw new Error(`el servidor local respondió ${r.status} en /models`);
  const j = (await r.json()) as { data?: { id: string }[] };
  const id = j.data?.map((m) => m.id).find((m) => !/embed/i.test(m));
  if (!id) throw new Error('el servidor local no tiene ningún modelo de chat cargado');
  modeloDescubierto = id;
  console.log(`[local] uso el modelo ${id}`);
  return id;
}

/** Los modelos que razonan (Qwen) a veces mandan <think>…</think> antes de la respuesta. */
function sinPensamiento(t: string): string {
  return t.replace(/<think>[\s\S]*?<\/think>/gi, '').trim();
}

export async function pedirLocal(p: PedidoJson): Promise<ResultadoJson> {
  try {
    const model = await modeloLocal();
    // "/no_think" y los dos campos de abajo apagan el razonamiento de Qwen y similares:
    // con razonamiento, en una notebook, una respuesta corta pasa de ~5 s a casi un minuto
    const sistema =
      `${textoDeSystem(p.system)}\n\nRespondé SOLO con un objeto JSON (sin texto antes ni después) que cumpla este esquema:\n` +
      `${JSON.stringify(p.schema)}\n/no_think`;
    const cuerpo: Record<string, unknown> = {
      model,
      messages: [{ role: 'system', content: sistema }, ...mensajesPlanos(p.messages)],
      temperature: 0.6,
      max_tokens: Math.min(p.maxTokens, 4_000),
      stream: false,
    };
    if (!sinEsquema) {
      cuerpo.response_format = { type: 'json_schema', json_schema: { name: 'salida', strict: true, schema: p.schema } };
      cuerpo.reasoning_effort = 'none';
      cuerpo.chat_template_kwargs = { enable_thinking: false };
    }
    // un modelo local en una notebook puede tardar: más margen que la API
    const pedir = () =>
      fetch(`${config.localBaseUrl}/chat/completions`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify(cuerpo),
        signal: AbortSignal.timeout(p.timeoutMs + 60_000),
      });
    let r = await pedir();
    if (r.status === 400 && !sinEsquema) {
      console.warn('[local] el servidor no aceptó json_schema, sigo pidiendo JSON por instrucción');
      sinEsquema = true;
      delete cuerpo.response_format;
      delete cuerpo.reasoning_effort;
      delete cuerpo.chat_template_kwargs;
      r = await pedir();
    }
    if (!r.ok) return { ok: false, motivo: `el modelo local respondió ${r.status}: ${(await r.text()).slice(0, 160)}` };
    const j = (await r.json()) as { choices?: { message?: { content?: string }; finish_reason?: string }[] };
    const c = j.choices?.[0];
    if (c?.finish_reason === 'length') return { ok: false, motivo: 'se cortó por max_tokens' };
    const data = extraerJson(sinPensamiento(c?.message?.content ?? ''));
    if (data === undefined) return { ok: false, motivo: 'JSON inválido' };
    return { ok: true, data, modelo: `local (${model})` };
  } catch (e) {
    const err = e as Error & { cause?: { code?: string } };
    if (err.cause?.code === 'ECONNREFUSED') {
      return { ok: false, motivo: `no hay servidor local en ${config.localBaseUrl} (abrí LM Studio u Ollama)` };
    }
    if (err.name === 'TimeoutError') return { ok: false, motivo: 'el modelo local tardó demasiado' };
    return { ok: false, motivo: err.message?.slice(0, 200) ?? 'error del modelo local' };
  }
}

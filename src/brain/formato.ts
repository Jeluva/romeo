// Conversión de un pedido (system en bloques + mensajes de Anthropic) a lo que necesitan los
// proveedores que no son la API: texto plano para Claude Code, mensajes simples para modelos locales.
import type Anthropic from '@anthropic-ai/sdk';
import { persona } from '../persona.js';

export function textoDeSystem(bloques: Anthropic.Beta.BetaTextBlockParam[]): string {
  return bloques.map((b) => b.text).join('\n\n');
}

function textoDe(content: Anthropic.Beta.BetaMessageParam['content']): string {
  if (typeof content === 'string') return content;
  return content
    .map((b) => (b.type === 'text' ? b.text : ''))
    .filter(Boolean)
    .join('\n');
}

/** Para modelos locales: los mismos turnos, como texto. */
export function mensajesPlanos(
  mensajes: Anthropic.Beta.BetaMessageParam[],
): { role: 'user' | 'assistant' | 'system'; content: string }[] {
  return mensajes.map((m) => ({ role: m.role, content: textoDe(m.content) }));
}

/** Para Claude Code: un solo prompt. Un pedido de un mensaje va tal cual; un chat se pasa como historial. */
export function aplanarMensajes(mensajes: Anthropic.Beta.BetaMessageParam[]): string {
  if (mensajes.length === 1) return textoDe(mensajes[0].content);
  const quien = { user: 'contacto', assistant: `vos (${persona.nombre})`, system: 'instrucción' } as const;
  const lineas = mensajes.map((m) => `[${quien[m.role]}]\n${textoDe(m.content)}`);
  return `Historial del chat de WhatsApp, del más viejo al más nuevo:\n\n${lineas.join('\n\n')}\n\nContestá el último mensaje del contacto.`;
}

/** JSON de un texto que puede venir con ```json o con texto alrededor. */
export function extraerJson(texto: string): unknown {
  const t = texto.trim().replace(/^```(?:json)?\s*/i, '').replace(/\s*```$/, '');
  try {
    return JSON.parse(t);
  } catch {
    const i = t.indexOf('{');
    const f = t.lastIndexOf('}');
    if (i < 0 || f <= i) return undefined;
    try {
      return JSON.parse(t.slice(i, f + 1));
    } catch {
      return undefined;
    }
  }
}

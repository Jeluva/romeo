// Manual de estilo del dueño a partir de sus mensajes reales (style_samples) + ejemplos few-shot.
import type { Db } from '../db/index.js';
import { persona } from '../persona.js';
import { horaDelDia } from '../memory/tiempo.js';
import { nombresPrivados } from '../memory/index.js';
import { contieneEmpresa, nombresEn, sinTildes } from '../memory/privacidad.js';

export interface Estilo {
  /** viñetas del manual */
  manual: string;
  /** ejemplos reales (o frases típicas si no hay muestras) */
  ejemplos: string[];
  /** true si salió de sus mensajes reales */
  real: boolean;
  muestras: number;
}

const RECALCULO_MS = 30 * 60_000;
const MIN_MUESTRAS = 30;
const MAX_EJEMPLOS = 20;

/** Manual de respaldo (romeo.config.json) mientras no haya mensajes tuyos importados del historial. */
const MANUAL_RESPALDO = persona.estilo.manual.join('\n');

const EJEMPLOS_RESPALDO = persona.estilo.ejemplos;

const TICS = [
  'amigo', 'che', 'dale', 'posta', 're', 'bueno', 'nada', 'igual', 'tipo', 'onda', 'genio', 'joya', 'buenisimo',
  'obvio', 'literal', 'banda', 'ahre', 'boludo', 'capo', 'crack', 'listo', 'ni idea', 'todo bien', 'de una',
  'mira', 'viste', 'alto', 'sisi', 'nono', 'naa', 'bien ahi', 'q', 'xq', 'tmb', 'nose',
];

/** Palabras que delatan contenido privado: esos mensajes no sirven de ejemplo. */
const PRIVADO =
  /(plata|pago|pagu[eé]|transfer|cbu|alias|cuenta|deuda|sueldo|mam[aá]|pap[aá]|\bma\b|\bpa\b|mami|papi|viej[oa]|abuel|\bt[ií][oa]s?\b|prim[oa]|herman|m[eé]dic|hospital|turno|enferm|direcci|calle|\bdni\b|clave|contrase|c[oó]digo|laburo|trabajo|jefe|oficina)/i;

const RISA = /^(?:j[aeis]?){2,}j?$/;
const EMOJI = /\p{Extended_Pictographic}/u;
const EMOJI_G = /\p{Extended_Pictographic}/gu;

function palabras(t: string): string[] {
  return sinTildes(t)
    .toLowerCase()
    .replace(/[^\p{L}\p{N}]+/gu, ' ')
    .trim()
    .split(' ')
    .filter(Boolean);
}

function hash(s: string): number {
  let h = 0x811c9dc5;
  for (let i = 0; i < s.length; i++) {
    h ^= s.charCodeAt(i);
    h = Math.imul(h, 0x01000193) >>> 0;
  }
  return h;
}

const pct = (n: number, de: number) => (de ? Math.round((100 * n) / de) : 0);

function mediana(xs: number[]): number {
  if (!xs.length) return 0;
  const s = [...xs].sort((a, b) => a - b);
  const m = Math.floor(s.length / 2);
  return s.length % 2 ? s[m] : Math.round((s[m - 1] + s[m]) / 2);
}

function calcularManual(muestras: { texto: string; at: number }[]): string {
  const textos = muestras.map((m) => m.texto.trim()).filter(Boolean);
  const n = textos.length;
  const lineas: string[] = [];

  const conLetra = textos.filter((t) => /^\p{L}/u.test(t));
  const minus = conLetra.filter((t) => t[0] === t[0].toLowerCase() && t[0] !== t[0].toUpperCase());
  lineas.push(`- arranca en minúscula (${pct(minus.length, conLetra.length)}% de sus mensajes)`);

  const conPunto = textos.filter((t) => /[^.]\.$|^\.$/.test(t));
  lineas.push(`- termina con punto el ${pct(conPunto.length, n)}% de las veces${pct(conPunto.length, n) <= 3 ? ' (o sea, nunca)' : ''}`);

  const preguntas = textos.filter((t) => t.includes('?'));
  const conApertura = preguntas.filter((t) => t.includes('¿'));
  if (preguntas.length >= 5) lineas.push(`- usa "¿" en el ${pct(conApertura.length, preguntas.length)}% de sus preguntas`);

  lineas.push(`- largo típico: ${mediana(textos.map((t) => t.length))} caracteres por mensaje`);

  const conEmoji = textos.filter((t) => EMOJI.test(t));
  const totalEmojis = textos.reduce((s, t) => s + (t.match(EMOJI_G)?.length ?? 0), 0);
  lineas.push(
    conEmoji.length <= Math.max(2, n * 0.02)
      ? `- casi no usa emojis (${totalEmojis} en ${n} mensajes)`
      : `- usa emojis en el ${pct(conEmoji.length, n)}% de los mensajes`,
  );

  const listas = textos.map((t) => ` ${palabras(t).join(' ')} `);
  const tics = TICS.map((tic) => ({ tic, veces: listas.filter((l) => l.includes(` ${tic} `)).length }))
    .filter((x) => x.veces >= Math.max(2, n * 0.015))
    .sort((a, b) => b.veces - a.veces || a.tic.localeCompare(b.tic))
    .slice(0, 6);
  if (tics.length) lineas.push(`- muletillas: ${tics.map((x) => `"${x.tic}" (${pct(x.veces, n)}%)`).join(', ')}`);

  const risas = new Map<string, number>();
  for (const t of textos) for (const p of palabras(t)) if (RISA.test(p)) risas.set(p, (risas.get(p) ?? 0) + 1);
  const totalRisas = [...risas.values()].reduce((a, b) => a + b, 0);
  if (totalRisas >= 3) {
    const [top] = [...risas.entries()].sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]));
    const terminanJ = [...risas.entries()].filter(([r]) => r.endsWith('j')).reduce((s, [, c]) => s + c, 0);
    lineas.push(`- se ríe con "${top[0]}" (el ${pct(terminanJ, totalRisas)}% de sus risas termina en j)`);
  }

  const horas = new Map<number, number>();
  for (const m of muestras) {
    const h = horaDelDia(m.at);
    horas.set(h, (horas.get(h) ?? 0) + 1);
  }
  const [hora] = [...horas.entries()].sort((a, b) => b[1] - a[1] || a[0] - b[0]);
  if (hora) lineas.push(`- su hora más activa es a las ${hora[0]} h`);

  return lineas.join('\n');
}

function elegirEjemplos(muestras: { texto: string }[]): string[] {
  const nombres = nombresPrivados();
  const vistos = new Set<string>();
  const candidatos: string[] = [];
  for (const { texto } of muestras) {
    const t = texto.trim();
    if (t.length < 2 || t.length > 60) continue;
    if (/[​-‍﻿\n]/.test(t)) continue;
    if (/\d/.test(t) || t.includes('@') || /https?:|www\.|\.com|\.ar\b/i.test(t)) continue;
    if (/\p{Lu}/u.test(t.slice(1))) continue; // nada de mayúsculas salvo la primera letra (nombres, siglas)
    if (PRIVADO.test(sinTildes(t)) || PRIVADO.test(t) || contieneEmpresa(t)) continue;
    if (nombresEn(t, nombres).length) continue;
    const clave = palabras(t).join(' ');
    if (!clave || vistos.has(clave)) continue;
    vistos.add(clave);
    candidatos.push(t);
  }

  // orden determinístico pero mezclado, con cupos por largo y sin repetir mucho la primera palabra
  candidatos.sort((a, b) => hash(a) - hash(b) || a.localeCompare(b));
  const cupos = { corto: 7, medio: 8, largo: 5 };
  const primeras = new Map<string, number>();
  let risas = 0;
  const elegidos: string[] = [];
  for (const t of candidatos) {
    if (elegidos.length >= MAX_EJEMPLOS) break;
    const balde = t.length < 12 ? 'corto' : t.length <= 30 ? 'medio' : 'largo';
    if (cupos[balde] <= 0) continue;
    const ps = palabras(t);
    const primera = ps[0] ?? '';
    if ((primeras.get(primera) ?? 0) >= 2) continue;
    const esRisa = ps.every((p) => RISA.test(p));
    if (esRisa && risas >= 2) continue;
    cupos[balde]--;
    primeras.set(primera, (primeras.get(primera) ?? 0) + 1);
    if (esRisa) risas++;
    elegidos.push(t);
  }
  return elegidos;
}

let cache: { estilo: Estilo; at: number } | undefined;

export function estiloActual(db: Db): Estilo {
  // con el manual de respaldo vuelvo a mirar seguido: el historial de WhatsApp puede llegar después
  const ttl = cache?.estilo.real ? RECALCULO_MS : 2 * 60_000;
  if (cache && Date.now() - cache.at < ttl) return cache.estilo;
  let estilo: Estilo;
  try {
    const muestras = db.styleSamples(5000);
    if (muestras.length < MIN_MUESTRAS) {
      estilo = { manual: MANUAL_RESPALDO, ejemplos: EJEMPLOS_RESPALDO, real: false, muestras: muestras.length };
    } else {
      const ejemplos = elegirEjemplos(muestras);
      estilo = {
        manual: calcularManual(muestras),
        ejemplos: ejemplos.length >= 5 ? ejemplos : [...ejemplos, ...EJEMPLOS_RESPALDO].slice(0, 8),
        real: true,
        muestras: muestras.length,
      };
    }
  } catch (e) {
    console.warn(`[cerebro] no pude calcular el estilo: ${(e as Error).message}`);
    estilo = { manual: MANUAL_RESPALDO, ejemplos: EJEMPLOS_RESPALDO, real: false, muestras: 0 };
  }
  cache = { estilo, at: Date.now() };
  return estilo;
}

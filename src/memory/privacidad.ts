// Red de seguridad determinística: aunque el filtro con Claude falle, nombres de personas,
// el nombre de la empresa, links, mails, teléfonos y montos no pasan a la memoria ni a las respuestas.

import { persona } from '../persona.js';

/** Cómo se puede nombrar al laburo hacia afuera (romeo.config.json). */
export const EMPRESA_PUBLICA = persona.privacidad.empresaPublica;

/** Nombre real de la empresa en cualquier forma, de romeo.config.json. Sin patrón, no hay nada que tapar. */
const EMPRESA_RE: RegExp | undefined = (() => {
  if (!persona.privacidad.empresaPatron) return undefined;
  try {
    return new RegExp(persona.privacidad.empresaPatron, 'giu');
  } catch {
    console.warn('[privacidad] empresaPatron no es una regex válida: no tapo el nombre de la empresa');
    return undefined;
  }
})();

// Palabras comunes que no se redactan aunque alguien se llame así ("en julio" no es una persona).
const NO_SON_NOMBRES = new Set([
  sinTildes(persona.nombre).toLowerCase(), 'romeo', 'yo', 'vos', 'nadie', 'alguien',
  'enero', 'febrero', 'marzo', 'abril', 'mayo', 'junio', 'julio', 'agosto', 'septiembre', 'setiembre', 'octubre',
  'noviembre', 'diciembre', 'lunes', 'martes', 'miercoles', 'jueves', 'viernes', 'sabado', 'domingo',
]);

export function sinTildes(s: string): string {
  return s.normalize('NFD').replace(/\p{M}/gu, '');
}

function escapar(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

/** Regex que matchea la palabra con o sin tildes y sin pegarse a otras letras. */
function regexPalabra(palabra: string): RegExp {
  const variantes: Record<string, string> = { a: '[aá]', e: '[eé]', i: '[ií]', o: '[oó]', u: '[uúü]' };
  const cuerpo = [...sinTildes(palabra).toLowerCase()]
    .map((c) => variantes[c] ?? escapar(c))
    .join('');
  return new RegExp(`(?<![\\p{L}\\p{N}])${cuerpo}(?![\\p{L}\\p{N}])`, 'giu');
}

function limpiarNombre(s: string): string {
  return s
    .replace(/^\s*["'[]+|["'\]]+\s*$/g, '')
    .replace(/^\[\[|\]\]$/g, '')
    .replace(/^.*\//, '')
    .replace(/\|.*$/, '')
    .trim();
}

function agregarNombre(destino: Set<string>, crudo: string) {
  const nombre = limpiarNombre(crudo);
  if (nombre.length < 3 || nombre.length > 40 || /\d/.test(nombre)) return;
  const partes = [nombre, ...nombre.split(/\s+/).filter((p) => p.length >= 4)];
  for (const p of partes) {
    if (!NO_SON_NOMBRES.has(sinTildes(p).toLowerCase())) destino.add(p);
  }
}

/**
 * Junta nombres de personas que aparecen en una nota: `people:` / `con:` del frontmatter,
 * los `**Nombre**:` de una sección "Personas..." y los links a People/.
 */
export function cosecharNombres(texto: string, destino: Set<string>) {
  const fm = /^---\r?\n([\s\S]*?)\r?\n---/.exec(texto);
  if (fm) {
    for (const linea of fm[1].split(/\r?\n/)) {
      const m = /^(people|personas|con|with)\s*:\s*\[(.*)\]\s*$/i.exec(linea.trim());
      if (m) for (const n of m[2].split(',')) agregarNombre(destino, n);
    }
  }

  let enPersonas = 0;
  for (const linea of texto.split(/\r?\n/)) {
    const h = /^(#+)\s+(.*)$/.exec(linea);
    if (h) {
      if (/personas|gente|people/i.test(h[2])) enPersonas = h[1].length;
      else if (enPersonas && h[1].length <= enPersonas) enPersonas = 0;
      continue;
    }
    if (enPersonas) {
      const b = /^\s*[*-]\s+\*\*([^*]+)\*\*/.exec(linea);
      if (b) agregarNombre(destino, b[1]);
    }
  }

  for (const m of texto.matchAll(/\[\[People\/([^\]|#]+)(?:[|#][^\]]*)?\]\]/gi)) agregarNombre(destino, m[1]);
}

export function contieneEmpresa(texto: string): boolean {
  if (!EMPRESA_RE) return false;
  EMPRESA_RE.lastIndex = 0;
  return EMPRESA_RE.test(texto);
}

/** Nombres de la lista que aparecen en el texto. */
export function nombresEn(texto: string, nombres: Iterable<string>): string[] {
  const hallados: string[] = [];
  for (const n of nombres) if (regexPalabra(n).test(texto)) hallados.push(n);
  return hallados;
}

/** Saca links, mails, teléfonos, montos, el nombre de la empresa y los nombres de personas. */
export function redactar(texto: string, nombres: Iterable<string>): string {
  let t = texto
    .replace(/\[\[([^\]|]+)\|([^\]]+)\]\]/g, '$2')
    .replace(/\[\[(?:[^\]]*\/)?([^\]]+)\]\]/g, '$1')
    .replace(/\[([^\]]*)\]\((?:https?:)?[^)]*\)/g, '$1')
    .replace(/\b(?:https?:\/\/|www\.)\S+/gi, '')
    .replace(/[\w.+-]+@[\w-]+\.[\w.]+/g, '')
    .replace(/(?<!\d)(?:\+?\d{1,3}[\s.-]?)?(?:\(?\d{2,4}\)?[\s.-]?)?\d{4}[\s.-]?\d{4}(?!\d)/g, '')
    .replace(/(?:US\$|U\$S|USD|ARS|R\$|\$)\s?\d[\d.,]*(?:\s?(?:k|mil|millones))?/gi, '')
    .replace(/\d[\d.,]*\s?(?:USD|ARS|d[oó]lares|pesos|reales)\b/gi, '');
  if (EMPRESA_RE) t = t.replace(EMPRESA_RE, EMPRESA_PUBLICA);
  // los más largos primero, para que "Valentino Borreo" se vaya entero
  const lista = [...new Set(nombres)].sort((a, b) => b.length - a.length);
  for (const n of lista) t = t.replace(regexPalabra(n), 'alguien');
  return t.replace(/[ \t]{2,}/g, ' ').replace(/ +([,.;:])/g, '$1');
}

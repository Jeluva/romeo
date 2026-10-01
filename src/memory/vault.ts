// Lectura del Vault de Obsidian: SOLO una lista cerrada de notas (nunca un glob recursivo),
// con una lista negra que se chequea en cada ruta antes de abrirla.
import { readFile, realpath, stat } from 'node:fs/promises';
import { isAbsolute, relative, resolve } from 'node:path';
import { config } from '../config.js';
import { carpetasProhibidas, persona } from '../persona.js';
import { sumarDias } from './tiempo.js';
import { cosecharNombres, redactar } from './privacidad.js';

const MAX_CHARS = 12_000;

/** Carpetas que nunca se leen, estén donde estén dentro del Vault (romeo.config.json + las de siempre). */
const CARPETAS_PROHIBIDAS = carpetasProhibidas();
/** Prefijos de archivo prohibidos (relativos al Vault, en minúscula). */
const PREFIJOS_PROHIBIDOS = persona.vault.prefijosProhibidos.map((p) => p.replaceAll('\\', '/').toLowerCase());

/** Secciones que se tiran antes de mandar nada a Claude (sentimientos, plata, salud, gente, direcciones). */
const SECCIONES_PRIVADAS =
  /(c[oó]mo me sent|sentimient|emoci|[aá]nimo|estado actual|personas|gente|salud|m[eé]dic|medidas|costos?|presupuesto|precio|(?<!mar del )plata|dinero|finanzas|pagos?|sueldo|alojamiento|airbnb|direcci[oó]n|fuentes|lo que me dijo|lo que dije|feedback)/i;

/** Claves del frontmatter que sí pasan (el resto, como people/mood/energy/presupuesto, no). */
const FRONTMATTER_OK = /^(date|fecha|fecha objetivo|actualizado|updated)\s*:/i;

export interface Nota {
  /** ruta relativa al Vault, con / */
  ruta: string;
  etiqueta: string;
  esJournal: boolean;
  /** Texto preparado para el filtro: sin frontmatter privado, sin secciones privadas, sin links ni nombres conocidos. */
  texto: string;
  /** Texto original recortado. Solo para el modo de prueba local; nunca sale del proceso. */
  crudo: string;
}

export interface LecturaVault {
  notas: Nota[];
  /** ruta:mtime:tamaño de cada nota de la lista (null si no existe) */
  huella: string[];
  /** nombres de personas encontrados en las notas permitidas, para redactar */
  nombres: Set<string>;
}

const NOMBRE_DIA = ['HOY', 'AYER', 'ANTEAYER'];

/** El diario de los últimos días + las notas de romeo.config.json. Nunca otra cosa. */
function listaPermitida(hoy: string): { ruta: string; etiqueta: string; esJournal: boolean }[] {
  const dias = Math.max(1, Math.min(7, persona.vault.diasDeDiario));
  const diario = persona.vault.diario.replace(/[\\/]+$/, '');
  const lista = Array.from({ length: dias }, (_, i) => {
    const fecha = sumarDias(hoy, -i);
    return {
      ruta: `${diario}/${fecha}.md`,
      etiqueta: `diario de ${NOMBRE_DIA[i] ?? `hace ${i} días`} (${fecha})`,
      esJournal: true,
    };
  });
  for (const n of persona.vault.notas) lista.push({ ruta: n.ruta, etiqueta: n.etiqueta, esJournal: false });
  return lista;
}

/** true si la ruta (relativa al Vault) está fuera de la lista negra. */
export function rutaPermitida(rel: string): boolean {
  const r = rel.replaceAll('\\', '/').toLowerCase();
  if (!r || r.startsWith('../') || r === '..' || isAbsolute(rel)) return false;
  const segmentos = r.split('/');
  if (segmentos.some((s) => s === '..' || CARPETAS_PROHIBIDAS.includes(s))) return false;
  if (PREFIJOS_PROHIBIDOS.some((p) => r.startsWith(p))) return false;
  return true;
}

/** Resuelve y valida la ruta (también después de seguir symlinks). undefined si no se puede leer. */
async function resolverSegura(base: string, rel: string): Promise<string | undefined> {
  if (!rutaPermitida(rel)) return undefined;
  const abs = resolve(base, rel);
  if (!rutaPermitida(relative(base, abs))) return undefined;
  let real: string;
  let baseReal: string;
  try {
    real = await realpath(abs);
    baseReal = await realpath(base);
  } catch {
    return undefined; // no existe
  }
  if (!rutaPermitida(relative(baseReal, real))) return undefined;
  return real;
}

function preparar(crudo: string, nombres: Set<string>): string {
  const lineas = crudo.split(/\r?\n/);
  const salida: string[] = [];
  let i = 0;

  // frontmatter: solo fechas
  if (lineas[0]?.trim() === '---') {
    const fin = lineas.findIndex((l, j) => j > 0 && l.trim() === '---');
    if (fin > 0) {
      for (const l of lineas.slice(1, fin)) if (FRONTMATTER_OK.test(l.trim())) salida.push(l.trim());
      i = fin + 1;
    }
  }

  let saltearNivel = 0;
  for (; i < lineas.length; i++) {
    const l = lineas[i];
    const h = /^(#+)\s+(.*)$/.exec(l);
    if (h) {
      if (saltearNivel && h[1].length > saltearNivel) continue;
      // el título (#) de la nota nunca tira la nota entera: solo se saltean secciones (## o más)
      saltearNivel = h[1].length >= 2 && SECCIONES_PRIVADAS.test(h[2]) ? h[1].length : 0;
      if (saltearNivel) continue;
    } else if (saltearNivel) {
      continue;
    }
    if (/^\s*>/.test(l)) continue; // notas al margen (suelen linkear a carpetas privadas)
    salida.push(l);
  }

  return redactar(salida.join('\n'), nombres)
    .replace(/\n{3,}/g, '\n\n')
    .trim();
}

export async function leerVault(hoy: string): Promise<LecturaVault> {
  const base = resolve(config.vaultPath);
  const huella: string[] = [];
  const nombres = new Set<string>();
  const leidas: { ruta: string; etiqueta: string; esJournal: boolean; crudo: string }[] = [];

  for (const item of listaPermitida(hoy)) {
    const abs = await resolverSegura(base, item.ruta);
    if (!abs) {
      huella.push(`${item.ruta}:null`);
      continue;
    }
    try {
      const st = await stat(abs);
      if (!st.isFile()) {
        huella.push(`${item.ruta}:null`);
        continue;
      }
      huella.push(`${item.ruta}:${Math.floor(st.mtimeMs)}:${st.size}`);
      const crudo = (await readFile(abs, 'utf8')).slice(0, MAX_CHARS);
      cosecharNombres(crudo, nombres);
      leidas.push({ ...item, crudo });
    } catch {
      huella.push(`${item.ruta}:error`);
    }
  }

  const notas = leidas.map((n) => ({ ...n, texto: preparar(n.crudo, nombres) }));
  return { notas, huella, nombres };
}

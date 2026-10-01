// Quién es el dueño de este Romeo. Sale de romeo.config.json (no se sube al repo: cada compu
// tiene el suyo, se arma con `npm run configurar`). Nada personal queda escrito en el código.
import { existsSync, readFileSync } from 'node:fs';

export interface NotaExtra {
  /** ruta relativa al Vault */
  ruta: string;
  /** cómo se la presenta al modelo */
  etiqueta: string;
}

export interface Persona {
  /** cómo se llama (como lo conocen en los chats) */
  nombre: string;
  /** una línea para la voz, ej. "un pibe argentino de veintipico" */
  descripcion: string;
  zonaHoraria: string;
  /** etiqueta corta del evento para el tablero, ej. "SideQuest · LOVE.exe" ("" = ninguna) */
  evento: string;
  /** quién le escribe a Romeo y desde dónde (va al prompt) */
  contexto: string;
  vault: {
    ruta: string;
    /** carpeta de notas diarias, cada una AAAA-MM-DD.md */
    diario: string;
    /** cuántos días de diario lee (hoy incluido) */
    diasDeDiario: number;
    /** otras notas que Romeo puede leer (lista cerrada) */
    notas: NotaExtra[];
    /** carpetas que nunca se leen, estén donde estén */
    carpetasProhibidas: string[];
    /** prefijos de ruta prohibidos, relativos al Vault */
    prefijosProhibidos: string[];
  };
  privacidad: {
    /** cómo se nombra el laburo hacia afuera, ej. "una empresa de software" */
    empresaPublica: string;
    /** regex (sin barras) con el nombre real de la empresa, para taparlo siempre. "" = ninguna */
    empresaPatron: string;
    /** cómo explicar la jerga del laburo, en dos niveles */
    jerga: string;
  };
  estilo: {
    /** manual de respaldo si todavía no hay mensajes tuyos importados */
    manual: string[];
    ejemplos: string[];
  };
}

export const ARCHIVO_PERSONA = 'romeo.config.json';

/** Lo que nunca se lee del Vault, aunque la configuración no lo diga. */
const SIEMPRE_PROHIBIDAS = ['.obsidian', '.claude', '.git', '.trash'];

export const PERSONA_BASE: Persona = {
  nombre: 'el dueño',
  descripcion: 'una persona de Argentina chateando con el celu',
  zonaHoraria: 'America/Argentina/Buenos_Aires',
  evento: '',
  contexto: 'Quien escribe puede ser cualquiera de sus contactos.',
  vault: {
    ruta: './vault',
    diario: 'Journal',
    diasDeDiario: 3,
    notas: [],
    carpetasProhibidas: [],
    prefijosProhibidos: [],
  },
  privacidad: {
    empresaPublica: 'el laburo',
    empresaPatron: '',
    jerga: '',
  },
  estilo: {
    manual: ['- mensajes cortos, como en un chat', '- sin emojis'],
    ejemplos: ['jaja', 'dale', 'despues te cuento'],
  },
};

function cargar(): Persona {
  if (!existsSync(ARCHIVO_PERSONA)) return PERSONA_BASE;
  try {
    const j = JSON.parse(readFileSync(ARCHIVO_PERSONA, 'utf8')) as Partial<Persona>;
    return {
      ...PERSONA_BASE,
      ...j,
      vault: { ...PERSONA_BASE.vault, ...j.vault },
      privacidad: { ...PERSONA_BASE.privacidad, ...j.privacidad },
      estilo: { ...PERSONA_BASE.estilo, ...j.estilo },
    };
  } catch (e) {
    console.warn(`[config] ${ARCHIVO_PERSONA} no se pudo leer (${(e as Error).message}): uso valores genéricos`);
    return PERSONA_BASE;
  }
}

export const persona: Persona = cargar();
export const personaConfigurada = existsSync(ARCHIVO_PERSONA);

export function carpetasProhibidas(): string[] {
  return [...SIEMPRE_PROHIBIDAS, ...persona.vault.carpetasProhibidas].map((c) => c.toLowerCase());
}

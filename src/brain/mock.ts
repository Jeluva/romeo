// Modo de prueba (sin ANTHROPIC_API_KEY): respuestas determinísticas en el estilo del dueño.
import type { Categoria, Memoria } from '../contract.js';
import { sinTildes } from '../memory/privacidad.js';
import { persona } from '../persona.js';

export interface Salida {
  texto: string;
  propone_cita: boolean;
  categoria: Categoria;
  interes: number;
}

function norm(t: string): string {
  return ` ${sinTildes(t).toLowerCase().replace(/[^\p{L}\p{N}]+/gu, ' ').trim()} `;
}

/** Primera viñeta de un campo de la memoria, pasada a cómo escribe él. */
function lineaDe(campo: string | undefined, preferir?: RegExp): string | undefined {
  if (!campo) return undefined;
  const lineas = campo
    .split('\n')
    .map((l) => l.replace(/^\s*[-*]\s*/, '').replace('[modo prueba]', '').trim())
    .filter((l) => l && !/no tengo nada cargado/i.test(l));
  const l = (preferir && lineas.find((x) => preferir.test(sinTildes(x).toLowerCase()))) || lineas[0];
  if (!l) return undefined;
  return l.charAt(0).toLowerCase() + l.slice(1);
}

function hash(s: string): number {
  let h = 0;
  for (let i = 0; i < s.length; i++) h = (Math.imul(h, 31) + s.charCodeAt(i)) >>> 0;
  return h;
}

export function respuestaDePrueba(ultimoDelContacto: string, memoria: Memoria | undefined): Salida {
  const n = norm(ultimoDelContacto);
  const base = { propone_cita: false, categoria: 'desconocido' as Categoria, interes: 50 };

  if (/ (bot|ia|ai|robot|chatgpt|claude|inteligencia artificial|maquina|automatico|sos romeo|sos real|sos vos|de verdad|sos una persona) /.test(n)) {
    return { ...base, texto: `jaja soy romeo, ${persona.nombre.toLowerCase()} está ocupado`, interes: 60 };
  }
  if (/ (que hiciste|que estuviste haciendo|que hacias|como (te fue|estuvo) (hoy|el dia|tu dia)|que tal (el|tu) dia|que contas|en que andas|que haces) /.test(n)) {
    // a un desconocido, nada de jerga del laburo: la versión simple
    const l = lineaDe(memoria?.hoy, /labur|program/);
    return {
      ...base,
      texto: l ? 'estuve programando para el laburo y ahora estoy presentando esto' : 'jaja nada amigo despues te cuento',
      interes: 60,
    };
  }
  if (/ (donde estas|donde andas|que vas a hacer|esta noche|mas tarde|agenda|manana) /.test(n)) {
    const l = lineaDe(memoria?.agenda, /sidequest/);
    return { ...base, texto: l ?? 'jaja despues te cuento', interes: 55 };
  }
  if (/ (birra|cerveza|salir|vernos|juntarnos|tomar algo|cita) /.test(n)) {
    return { ...base, texto: 'dale amigo, despues de la charla vemos', propone_cita: true, categoria: 'nada_serio', interes: 70 };
  }
  if (/^ (hola|holis|holaa+|buenas|hey|ey|que onda|que tal|buen dia|buenas noches|como va|como andas) /.test(n) || / hola romeo /.test(n)) {
    return { ...base, texto: 'que onda amigo' };
  }
  const comodines = ['jajajajaj posta?', 'jaja despues te cuento', 'uh mira vos', 'dale amigo'];
  return { ...base, texto: comodines[hash(n) % comodines.length], interes: 40 };
}

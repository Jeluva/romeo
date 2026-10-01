// Calendario: de cada evento pasa SOLO título, inicio y fin. Nunca descripción, lugar,
// invitados, organizador ni links (las descripciones tienen notas privadas).
import ical, { type CalendarResponse, type ParameterValue, type VEvent } from 'node-ical';
import { fechaCorta, horaLocal } from './tiempo.js';

const TIMEOUT_MS = 20_000;

export interface EventoReducido {
  titulo: string;
  /** ISO */
  inicio: string;
  /** ISO */
  fin: string;
  todoElDia: boolean;
}

function texto(v: ParameterValue | undefined): string {
  if (v == null) return '';
  return (typeof v === 'string' ? v : String(v.val ?? '')).replace(/\s+/g, ' ').trim();
}

/** Eventos (incluye repeticiones) que se superponen con [desde, hasta). */
export function reducirCalendario(data: CalendarResponse, desde: number, hasta: number): EventoReducido[] {
  const salida = new Map<string, EventoReducido>();
  for (const comp of Object.values(data)) {
    if (!comp || typeof comp !== 'object' || comp.type !== 'VEVENT') continue;
    const ev = comp as VEvent;
    if (ev.status === 'CANCELLED') continue;
    if (ev.recurrenceid && !ev.rrule) continue; // las excepciones vienen dentro del evento base
    try {
      const instancias = ical.expandRecurringEvent(ev, {
        from: new Date(desde),
        to: new Date(hasta),
        expandOngoing: true,
      });
      for (const inst of instancias) {
        if (inst.event?.status === 'CANCELLED') continue;
        const ini = inst.start.getTime();
        const fin = (inst.end ?? inst.start).getTime();
        if (!(ini < hasta && Math.max(fin, ini + 1) > desde)) continue;
        const titulo = texto(inst.summary) || texto(ev.summary) || '(sin título)';
        const r: EventoReducido = {
          titulo: titulo.slice(0, 120),
          inicio: new Date(ini).toISOString(),
          fin: new Date(Math.max(fin, ini)).toISOString(),
          todoElDia: inst.isFullDay,
        };
        salida.set(`${r.titulo}|${r.inicio}`, r);
      }
    } catch {
      // un evento roto no tira abajo el resto
    }
  }
  return [...salida.values()].sort((a, b) => a.inicio.localeCompare(b.inicio) || a.titulo.localeCompare(b.titulo));
}

export async function leerCalendario(url: string, desde: number, hasta: number): Promise<EventoReducido[]> {
  // fromURL acepta opciones de fetch en runtime; los tipos solo declaran la forma (url) => Promise
  const fromURL = ical.async.fromURL as unknown as (u: string, o: { signal: AbortSignal }) => Promise<CalendarResponse>;
  const data = await fromURL(url, { signal: AbortSignal.timeout(TIMEOUT_MS) });
  return reducirCalendario(data, desde, hasta);
}

/** "jue, 1/10 18:30–22:30 · SideQuest" (o "todo el día") */
export function formatearEvento(e: EventoReducido): string {
  const ini = Date.parse(e.inicio);
  const fin = Date.parse(e.fin);
  if (e.todoElDia) return `${fechaCorta(ini + 12 * 3600_000)} todo el día · ${e.titulo}`;
  return `${fechaCorta(ini)} ${horaLocal(ini)}–${horaLocal(fin)} · ${e.titulo}`;
}

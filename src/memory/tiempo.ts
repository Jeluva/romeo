// Fechas y horas en la zona del dueño (config.timezone), sin depender de la zona de la máquina.
import { config } from '../config.js';

const TZ = config.timezone;

const fmtPartes = new Intl.DateTimeFormat('en-US', {
  timeZone: TZ,
  hourCycle: 'h23',
  year: 'numeric',
  month: '2-digit',
  day: '2-digit',
  hour: '2-digit',
  minute: '2-digit',
  second: '2-digit',
});

function partes(ms: number) {
  const p: Record<string, number> = {};
  for (const { type, value } of fmtPartes.formatToParts(new Date(ms))) {
    if (type !== 'literal') p[type] = Number(value);
  }
  return { y: p.year, m: p.month, d: p.day, h: p.hour % 24, mi: p.minute, s: p.second };
}

/** Diferencia (ms) entre la hora local de la zona y UTC en ese instante. */
function offsetMs(ms: number): number {
  const p = partes(ms);
  return Date.UTC(p.y, p.m - 1, p.d, p.h, p.mi, p.s) - Math.floor(ms / 1000) * 1000;
}

const dos = (n: number) => String(n).padStart(2, '0');

/** 'YYYY-MM-DD' en la zona del dueño. */
export function fechaLocal(ms: number): string {
  const p = partes(ms);
  return `${p.y}-${dos(p.m)}-${dos(p.d)}`;
}

/** Suma días a una fecha 'YYYY-MM-DD' (calendario, sin zona). */
export function sumarDias(ymd: string, n: number): string {
  const [y, m, d] = ymd.split('-').map(Number);
  return new Date(Date.UTC(y, m - 1, d + n)).toISOString().slice(0, 10);
}

/** Epoch ms de las 00:00 de ese día en la zona del dueño. */
export function inicioDelDia(ymd: string): number {
  const [y, m, d] = ymd.split('-').map(Number);
  const guess = Date.UTC(y, m - 1, d);
  const t = guess - offsetMs(guess);
  return guess - offsetMs(t);
}

/** 'HH:MM' en la zona del dueño. */
export function horaLocal(ms: number): string {
  const p = partes(ms);
  return `${dos(p.h)}:${dos(p.mi)}`;
}

/** Hora (0-23) en la zona del dueño. */
export function horaDelDia(ms: number): number {
  return partes(ms).h;
}

const fmtLarga = new Intl.DateTimeFormat('es-AR', {
  timeZone: TZ,
  weekday: 'long',
  day: 'numeric',
  month: 'long',
  year: 'numeric',
});

const fmtCorta = new Intl.DateTimeFormat('es-AR', {
  timeZone: TZ,
  weekday: 'short',
  day: 'numeric',
  month: 'numeric',
});

/** "jueves, 1 de octubre de 2026" */
export function fechaLarga(ms: number): string {
  return fmtLarga.format(new Date(ms));
}

/** "jue, 1/10" */
export function fechaCorta(ms: number): string {
  return fmtCorta.format(new Date(ms));
}

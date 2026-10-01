import { createHash } from 'node:crypto';
import type { AppContext, Memoria } from '../contract.js';
import { config } from '../config.js';
import { hayApi } from '../brain/claude.js';
import { proveedorActivo } from '../brain/proveedores.js';
import { leerCalendario, type EventoReducido } from './calendario.js';
import { filtrarConClaude, memoriaDePrueba } from './filtro.js';
import { fechaLocal, inicioDelDia, sumarDias } from './tiempo.js';
import { leerVault } from './vault.js';

// Agente Cerebro: lee el Vault (lista cerrada de notas) y el calendario, y arma la memoria filtrada.

const CLAVE_DB = 'memoria';
const ESPERA_INICIAL_MS = 12_000;
const REINTENTO_MS = 60_000;

let actual: Memoria | undefined;
let nombres = new Set<string>();
/** huella de las entradas con las que se armó `actual` (solo en memoria: al reiniciar se recalcula una vez) */
let ultimaHuella: string | undefined;
let calCache: { dia: string; eventos: EventoReducido[] } | undefined;
let corriendo = false;
let reintento: NodeJS.Timeout | undefined;

/** Última memoria filtrada, o undefined si todavía no se calculó. */
export function memoriaActual(): Memoria | undefined {
  return actual;
}

/** Nombres de personas vistos en las notas permitidas (para que el cerebro no los use). */
export function nombresPrivados(): ReadonlySet<string> {
  return nombres;
}

function emitir(ctx: AppContext, m: Memoria) {
  try {
    ctx.bus.emit('memoria', m);
  } catch (e) {
    console.warn(`[memoria] un listener de 'memoria' falló: ${(e as Error).message}`);
  }
}

function cargarGuardada(ctx: AppContext): Memoria | undefined {
  try {
    const raw = ctx.db.getEstado(CLAVE_DB);
    if (!raw) return undefined;
    const m = JSON.parse(raw) as Partial<Memoria>;
    if (typeof m.at !== 'number' || typeof m.agenda !== 'string' || typeof m.hoy !== 'string' || typeof m.perfil !== 'string') {
      return undefined;
    }
    // con API, la memoria de prueba no sirve: se recalcula enseguida
    if (hayApi() && m.hoy.startsWith('[modo prueba]')) return undefined;
    return { at: m.at, agenda: m.agenda, hoy: m.hoy, perfil: m.perfil };
  } catch {
    return undefined;
  }
}

async function eventosDelCalendario(hoy: string): Promise<EventoReducido[]> {
  if (!config.calendarIcsUrl) return [];
  try {
    const eventos = await leerCalendario(config.calendarIcsUrl, inicioDelDia(hoy), inicioDelDia(sumarDias(hoy, 2)));
    calCache = { dia: hoy, eventos };
    return eventos;
  } catch (e) {
    console.warn(`[memoria] no pude leer el calendario: ${(e as Error).message?.slice(0, 120)}`);
    // si falla la red, sigo con lo último de hoy para no recalcular sin calendario
    return calCache?.dia === hoy ? calCache.eventos : [];
  }
}

async function refrescar(ctx: AppContext): Promise<void> {
  if (corriendo) return;
  corriendo = true;
  try {
    const ahora = Date.now();
    const hoy = fechaLocal(ahora);
    const vault = await leerVault(hoy);
    nombres = vault.nombres;
    const eventos = await eventosDelCalendario(hoy);

    const huella = createHash('sha256')
      .update(JSON.stringify({ hoy, modo: proveedorActivo(), vault: vault.huella, eventos }))
      .digest('hex');
    if (huella === ultimaHuella && actual) return;

    const entradas = { ahora, notas: vault.notas, eventos, nombres: vault.nombres };
    // con un modelo local, el filtro largo traba la cola del servidor y las respuestas esperan:
    // la memoria sale del diario con el filtro por código (privacidad.ts), sin pasar por el modelo
    const conFiltro = hayApi() && proveedorActivo() !== 'local';
    const real = conFiltro ? await filtrarConClaude(entradas) : undefined;
    // si el filtro falla y no hay nada, queda lo básico del diario
    const m = real ?? (!conFiltro || !actual ? memoriaDePrueba(entradas) : undefined);
    if (!m) {
      programarReintento(ctx);
      return;
    }
    actual = m;
    if (real || !conFiltro) ultimaHuella = huella;
    else programarReintento(ctx);
    ctx.db.setEstado(CLAVE_DB, JSON.stringify(m));
    console.log(`[memoria] actualizada (${vault.notas.length} notas, ${eventos.length} eventos${hayApi() ? '' : ', modo prueba'})`);
    emitir(ctx, m);
  } catch (e) {
    console.warn(`[memoria] error al refrescar: ${(e as Error).message?.slice(0, 160)}`);
    programarReintento(ctx);
  } finally {
    corriendo = false;
  }
}

function programarReintento(ctx: AppContext) {
  if (reintento) return;
  reintento = setTimeout(() => {
    reintento = undefined;
    void refrescar(ctx);
  }, REINTENTO_MS);
  reintento.unref();
}

/** Recalcular ya (por ejemplo, al cambiar de proveedor desde el tablero). */
export function refrescarAhora(ctx: AppContext): void {
  void refrescar(ctx);
}

export async function start(ctx: AppContext): Promise<void> {
  try {
    actual = cargarGuardada(ctx);
    if (actual) emitir(ctx, actual);

    const primera = refrescar(ctx);
    // sin memoria guardada, espero un rato a la primera (sin trabar el arranque si Claude tarda)
    if (!actual) {
      await Promise.race([primera, new Promise((r) => setTimeout(r, ESPERA_INICIAL_MS).unref())]);
    }

    const t = setInterval(() => void refrescar(ctx), config.memoriaCadaMs);
    t.unref();
  } catch (e) {
    console.warn(`[memoria] no pude arrancar: ${(e as Error).message}`);
  }
}

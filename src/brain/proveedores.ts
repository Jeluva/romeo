// Qué modelo contesta: API key, tu suscripción (Claude Code) o un modelo local.
// Se elige en el .env (ROMEO_PROVEEDOR) y se puede cambiar en vivo desde el tablero.
import { existsSync } from 'node:fs';
import { config } from '../config.js';

export type Proveedor = 'api' | 'suscripcion' | 'local' | 'prueba';
export type Eleccion = Proveedor | 'auto';

export const ELECCIONES: readonly Eleccion[] = ['auto', 'api', 'suscripcion', 'local', 'prueba'];

let eleccion: Eleccion = config.proveedor;

/** 'auto' usa la API si hay key; si no, respuestas de prueba. */
export function proveedorActivo(): Proveedor {
  if (eleccion === 'auto') return config.anthropicApiKey ? 'api' : 'prueba';
  if (eleccion === 'api' && !config.anthropicApiKey) return 'prueba';
  return eleccion;
}

export function eleccionActual(): Eleccion {
  return eleccion;
}

export function elegirProveedor(e: string): boolean {
  if (!(ELECCIONES as readonly string[]).includes(e)) return false;
  eleccion = e as Eleccion;
  console.log(`[cerebro] proveedor: ${describirProveedor()}`);
  return true;
}

export function describirProveedor(p: Proveedor = proveedorActivo()): string {
  switch (p) {
    case 'api':
      return `API de Anthropic (${config.model})`;
    case 'suscripcion':
      return `tu suscripción vía Claude Code (${config.suscripcionModelo})`;
    case 'local':
      return `modelo local en ${config.localBaseUrl}${config.localModelo ? ` (${config.localModelo})` : ''}`;
    default:
      return 'respuestas de prueba';
  }
}

/** Para el tablero: qué opciones tienen lo necesario configurado. */
export function opcionesProveedor() {
  return [
    { id: 'api', nombre: 'API key', listo: Boolean(config.anthropicApiKey) },
    {
      id: 'suscripcion',
      nombre: 'Suscripción (Claude Code)',
      listo: config.claudeCodePath === 'claude' || existsSync(config.claudeCodePath),
    },
    { id: 'local', nombre: 'Modelo local', listo: true },
    { id: 'prueba', nombre: 'Prueba', listo: true },
  ];
}

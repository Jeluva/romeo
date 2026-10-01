// Contrato compartido entre módulos. Cada módulo se comunica SOLO por este bus y por src/db.
// No cambies estos tipos desde un módulo: si hace falta un campo nuevo, avisalo en tu resumen.
import { EventEmitter } from 'node:events';
import type { Db } from './db/index.js';

export type Regla = 'auto' | 'sugerir' | 'no_tocar';
export type Autor = 'contacto' | 'romeo' | 'vos';
export type Categoria = 'pareja' | 'situationship' | 'amistad' | 'familia' | 'nada_serio' | 'desconocido';

/** whatsapp → rules (y dashboard). Solo chats privados y mensajes nuevos, nunca historial. */
export interface MensajeEntrante {
  jid: string;
  id: string;
  texto: string;
  /** epoch ms */
  at: number;
  nombre?: string;
}

/** rules → brain: este chat merece respuesta. */
export interface PedirRespuesta {
  jid: string;
  /** id del mensaje entrante que la dispara */
  disparadoPor: string;
  /** 'enviar' si la regla es auto, 'borrador' si es sugerir */
  modo: 'enviar' | 'borrador';
}

/** brain → whatsapp (modo enviar) o → dashboard (modo borrador). */
export interface RespuestaLista {
  jid: string;
  texto: string;
  propone_cita: boolean;
  categoria: Categoria;
  /** 0 a 100 */
  interes: number;
  modo: 'enviar' | 'borrador';
  disparadoPor: string;
}

/** dashboard → whatsapp: mandar un borrador aprobado a mano. */
export interface EnviarTexto {
  jid: string;
  texto: string;
  disparadoPor?: string;
  propone_cita?: boolean;
}

/** whatsapp → dashboard: Romeo mandó un mensaje. */
export interface MensajeEnviado {
  jid: string;
  id: string;
  texto: string;
  at: number;
  /** desde que llegó el mensaje que lo disparó */
  latencia_ms: number | null;
}

export interface EstadoConexion {
  estado: 'conectando' | 'esperando_vinculo' | 'conectado' | 'desconectado';
  /** nombre de la cuenta vinculada, si se conoce */
  como?: string;
  /** código de vinculación por número, si se usa. El QR va SOLO a la terminal, nunca al bus. */
  codigoVinculo?: string;
}

/** memory → brain y dashboard: memoria filtrada, lo único que el prompt puede ver de tu vida. */
export interface Memoria {
  /** epoch ms */
  at: number;
  agenda: string;
  hoy: string;
  perfil: string;
}

export interface Eventos {
  mensaje_entrante: [MensajeEntrante];
  pedir_respuesta: [PedirRespuesta];
  respuesta_lista: [RespuestaLista];
  enviar_texto: [EnviarTexto];
  mensaje_enviado: [MensajeEnviado];
  conexion: [EstadoConexion];
  memoria: [Memoria];
  /** cualquier cambio en un chat (regla, categoría, mensaje nuevo) para refrescar el tablero */
  chat_actualizado: [{ jid: string }];
}

export class Bus extends EventEmitter<Eventos> {}

export interface AppContext {
  bus: Bus;
  db: Db;
}

/** Marca invisible que va al final de cada mensaje de Romeo (slide dashboards). Cosmética: las métricas usan la tabla messages. */
export const MARCA_ROMEO = '​‌​';

/** Frase del QR que habilita el modo automático en un chat nuevo. Se compara sin mayúsculas ni tildes. */
export const FRASE_OPT_IN = 'hola romeo';

/** Un chat es privado si no es grupo, difusión, canal ni estado. Acepta @s.whatsapp.net y @lid. */
export function esChatPrivado(jid: string): boolean {
  return !(
    jid.endsWith('@g.us') ||
    jid.endsWith('@broadcast') ||
    jid.endsWith('@newsletter') ||
    jid.startsWith('status@')
  );
}

/** +54 9 11 ••••-5678 para @s.whatsapp.net; los @lid no traen número. */
export function enmascarar(jid: string, nombre?: string | null): string {
  const user = jid.split('@')[0].split(':')[0];
  if (jid.endsWith('@s.whatsapp.net') && /^\d{8,}$/.test(user)) {
    return `+${user.slice(0, 2)} ${user.slice(2, 3)} ${user.slice(3, 5)} ••••-${user.slice(-4)}`;
  }
  return nombre ? `${nombre.split(' ')[0]} ••` : `contacto ••${user.slice(-2)}`;
}

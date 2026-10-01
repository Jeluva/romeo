import { DatabaseSync } from 'node:sqlite';
import { mkdirSync } from 'node:fs';
import { join } from 'node:path';
import type { Autor, Categoria, Regla } from '../contract.js';

export interface Chat {
  jid: string;
  nombre: string | null;
  regla: Regla;
  opt_in: number;
  primer_mensaje_at: number | null;
  categoria: Categoria | null;
  interes: number | null;
  actualizado_at: number;
}

export interface Mensaje {
  id: string;
  jid: string;
  autor: Autor;
  texto: string;
  at: number;
  propone_cita: number;
  latencia_ms: number | null;
  respuesta_a: string | null;
}

export interface Borrador {
  id: number;
  jid: string;
  texto: string;
  creado_at: number;
  estado: 'pendiente' | 'enviado' | 'descartado';
  disparado_por: string | null;
}

const SCHEMA = `
CREATE TABLE IF NOT EXISTS chats (
  jid TEXT PRIMARY KEY,
  nombre TEXT,
  regla TEXT NOT NULL DEFAULT 'no_tocar',
  opt_in INTEGER NOT NULL DEFAULT 0,
  primer_mensaje_at INTEGER,
  categoria TEXT,
  interes INTEGER,
  actualizado_at INTEGER NOT NULL
);
CREATE TABLE IF NOT EXISTS messages (
  id TEXT PRIMARY KEY,
  jid TEXT NOT NULL,
  autor TEXT NOT NULL,
  texto TEXT NOT NULL,
  at INTEGER NOT NULL,
  propone_cita INTEGER NOT NULL DEFAULT 0,
  latencia_ms INTEGER,
  respuesta_a TEXT
);
CREATE INDEX IF NOT EXISTS messages_jid_at ON messages (jid, at);
CREATE TABLE IF NOT EXISTS drafts (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  jid TEXT NOT NULL,
  texto TEXT NOT NULL,
  creado_at INTEGER NOT NULL,
  estado TEXT NOT NULL DEFAULT 'pendiente',
  disparado_por TEXT
);
CREATE TABLE IF NOT EXISTS estado (
  clave TEXT PRIMARY KEY,
  valor TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS style_samples (
  id TEXT PRIMARY KEY,
  jid TEXT NOT NULL,
  texto TEXT NOT NULL,
  at INTEGER NOT NULL
);
`;

export function openDb(dataDir: string) {
  mkdirSync(dataDir, { recursive: true });
  const sql = new DatabaseSync(join(dataDir, 'romeo.db'));
  sql.exec('PRAGMA journal_mode = WAL;');
  sql.exec(SCHEMA);

  const db = {
    sql,

    getChat(jid: string): Chat | undefined {
      return sql.prepare('SELECT * FROM chats WHERE jid = ?').get(jid) as Chat | undefined;
    },

    /** Crea el chat si no existe (regla no_tocar). Nunca pisa la regla ni el opt-in. */
    ensureChat(jid: string, nombre?: string | null): Chat {
      const now = Date.now();
      sql
        .prepare(
          `INSERT INTO chats (jid, nombre, actualizado_at) VALUES (?, ?, ?)
           ON CONFLICT(jid) DO UPDATE SET nombre = COALESCE(excluded.nombre, chats.nombre)`,
        )
        .run(jid, nombre ?? null, now);
      return db.getChat(jid)!;
    },

    updateChat(jid: string, campos: Partial<Omit<Chat, 'jid'>>) {
      const keys = Object.keys(campos) as (keyof typeof campos)[];
      if (keys.length === 0) return;
      const set = keys.map((k) => `${k} = ?`).join(', ');
      sql
        .prepare(`UPDATE chats SET ${set}, actualizado_at = ? WHERE jid = ?`)
        .run(...keys.map((k) => campos[k] as never), Date.now(), jid);
    },

    listChats(): Chat[] {
      return sql.prepare('SELECT * FROM chats ORDER BY actualizado_at DESC').all() as unknown as Chat[];
    },

    insertMessage(m: Omit<Mensaje, 'propone_cita' | 'latencia_ms' | 'respuesta_a'> & Partial<Mensaje>) {
      sql
        .prepare(
          `INSERT OR IGNORE INTO messages (id, jid, autor, texto, at, propone_cita, latencia_ms, respuesta_a)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
        )
        .run(m.id, m.jid, m.autor, m.texto, m.at, m.propone_cita ?? 0, m.latencia_ms ?? null, m.respuesta_a ?? null);
    },

    getMessage(id: string): Mensaje | undefined {
      return sql.prepare('SELECT * FROM messages WHERE id = ?').get(id) as Mensaje | undefined;
    },

    /** Últimos n mensajes del chat, del más viejo al más nuevo. */
    recentMessages(jid: string, n = 20): Mensaje[] {
      const rows = sql
        .prepare('SELECT * FROM messages WHERE jid = ? ORDER BY at DESC LIMIT ?')
        .all(jid, n) as unknown as Mensaje[];
      return rows.reverse();
    },

    /** Mensajes de Romeo en este chat en la última ventana. */
    countRomeoSince(jid: string, desde: number): number {
      const row = sql
        .prepare("SELECT COUNT(*) AS n FROM messages WHERE jid = ? AND autor = 'romeo' AND at >= ?")
        .get(jid, desde) as { n: number };
      return row.n;
    },

    insertDraft(jid: string, texto: string, disparadoPor: string | null): number {
      const r = sql
        .prepare('INSERT INTO drafts (jid, texto, creado_at, disparado_por) VALUES (?, ?, ?, ?)')
        .run(jid, texto, Date.now(), disparadoPor);
      return Number(r.lastInsertRowid);
    },

    pendingDrafts(): Borrador[] {
      return sql
        .prepare("SELECT * FROM drafts WHERE estado = 'pendiente' ORDER BY creado_at DESC")
        .all() as unknown as Borrador[];
    },

    setDraftEstado(id: number, estado: Borrador['estado']) {
      sql.prepare('UPDATE drafts SET estado = ? WHERE id = ?').run(estado, id);
    },

    getEstado(clave: string): string | undefined {
      const row = sql.prepare('SELECT valor FROM estado WHERE clave = ?').get(clave) as
        | { valor: string }
        | undefined;
      return row?.valor;
    },

    setEstado(clave: string, valor: string) {
      sql
        .prepare('INSERT INTO estado (clave, valor) VALUES (?, ?) ON CONFLICT(clave) DO UPDATE SET valor = excluded.valor')
        .run(clave, valor);
    },

    /** Pausa global: si es true, Romeo no contesta nada. */
    pausado(): boolean {
      return db.getEstado('pausado') === '1';
    },

    /** Hora de corte (epoch ms) para el opt-in, o undefined si no se activó. */
    horaCorte(): number | undefined {
      const v = db.getEstado('hora_corte');
      return v ? Number(v) : undefined;
    },

    insertStyleSample(id: string, jid: string, texto: string, at: number) {
      sql.prepare('INSERT OR IGNORE INTO style_samples (id, jid, texto, at) VALUES (?, ?, ?, ?)').run(id, jid, texto, at);
    },

    styleSamples(limit = 5000): { id: string; jid: string; texto: string; at: number }[] {
      return sql
        .prepare('SELECT * FROM style_samples ORDER BY at DESC LIMIT ?')
        .all(limit) as unknown as { id: string; jid: string; texto: string; at: number }[];
    },
  };

  return db;
}

export type Db = ReturnType<typeof openDb>;

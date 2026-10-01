// Agente Tablero: servidor, vistas Conexión / Controles / Romeo / Chats / Borradores / Memoria, actualización en vivo.
//
// Privacidad (se proyecta en vivo): todo lo que va al navegador pasa por las funciones de "armado" de abajo.
// - Solo se listan chats con opt_in = 1 o regla != 'no_tocar'. El resto es un número, sin detalles.
// - Nunca se manda `nombre` al navegador; los chats se muestran con enmascarar(jid, null).
// - Los textos de los mensajes solo viajan para chats con opt_in = 1 (los del público).
// - El QR nunca pasa por acá: sale solo en la terminal.
import express, { type NextFunction, type Request, type Response } from 'express';
import { createServer } from 'node:http';
import { randomBytes } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { config } from '../config.js';
import { persona } from '../persona.js';
import {
  enmascarar,
  FRASE_OPT_IN,
  type AppContext,
  type Categoria,
  type EnviarTexto,
  type EstadoConexion,
  type MensajeEnviado,
  type Memoria,
  type Regla,
  type RespuestaLista,
} from '../contract.js';
import type { Borrador, Mensaje } from '../db/index.js';
import { memoriaActual, refrescarAhora } from '../memory/index.js';
import { describirProveedor, eleccionActual, elegirProveedor, opcionesProveedor } from '../brain/proveedores.js';

const REGLAS: readonly Regla[] = ['auto', 'sugerir', 'no_tocar'];
const CATEGORIAS: readonly Categoria[] = ['pareja', 'situationship', 'amistad', 'familia', 'nada_serio', 'desconocido'];
const FILTRO_VISIBLE = "(opt_in = 1 OR regla != 'no_tocar')";
const MAX_CHATS = 40;
const LARGO_MENSAJE = 80;
const LARGO_BORRADOR = 600;
const CADA_METRICAS_MS = 10_000;
const CADA_LATIDO_MS = 15_000;

/** "hola romeo" → "Hola Romeo", para mostrar. */
const FRASE_VISIBLE = FRASE_OPT_IN.replace(/(^|\s)\p{L}/gu, (m) => m.toUpperCase());

export async function start(ctx: AppContext): Promise<void> {
  const { db, bus } = ctx;
  const rutaPagina = new URL('./page.html', import.meta.url);
  const plantillaInicial = readFileSync(rutaPagina, 'utf8');
  /** Se relee en cada GET / para poder retocar el CSS sin reiniciar Romeo (y su sesión de WhatsApp). */
  function plantilla(): string {
    try {
      return readFileSync(rutaPagina, 'utf8');
    } catch {
      return plantillaInicial;
    }
  }

  // ---------- estado en memoria ----------
  let conexion: EstadoConexion = { estado: 'desconectado' };
  let ultimaMemoria: Memoria | undefined;
  /** propone_cita de cada borrador que insertamos nosotros, para pasarlo al enviar. */
  const citaDeBorrador = new Map<number, boolean>();

  // ---------- consultas (todo lo que sale al navegador pasa por acá) ----------
  const q = {
    visible: db.sql.prepare(`SELECT 1 AS ok FROM chats WHERE jid = ? AND ${FILTRO_VISIBLE}`),
    chatsVisibles: db.sql.prepare(
      `SELECT jid, regla, opt_in, categoria, interes, actualizado_at FROM chats WHERE ${FILTRO_VISIBLE}
       ORDER BY actualizado_at DESC LIMIT ${MAX_CHATS}`,
    ),
    contarVisibles: db.sql.prepare(`SELECT COUNT(*) AS n FROM chats WHERE ${FILTRO_VISIBLE}`),
    contarOcultos: db.sql.prepare(`SELECT COUNT(*) AS n FROM chats WHERE NOT ${FILTRO_VISIBLE}`),
    latencias: db.sql.prepare(
      `SELECT latencia_ms AS l FROM messages
       WHERE autor = 'romeo' AND at >= ? AND latencia_ms IS NOT NULL AND latencia_ms >= 0
       ORDER BY latencia_ms`,
    ),
    totales: db.sql.prepare(
      `SELECT COUNT(*) AS enviados, COUNT(DISTINCT jid) AS chats, COALESCE(SUM(propone_cita), 0) AS citas
       FROM messages WHERE autor = 'romeo' AND at >= ?`,
    ),
    ultimoEnvio: db.sql.prepare(
      `SELECT m.jid AS jid, m.at AS at, m.latencia_ms AS latencia_ms FROM messages m JOIN chats c ON c.jid = m.jid
       WHERE m.autor = 'romeo' AND (c.opt_in = 1 OR c.regla != 'no_tocar') ORDER BY m.at DESC LIMIT 1`,
    ),
    borrador: db.sql.prepare('SELECT * FROM drafts WHERE id = ?'),
    borradorPendiente: db.sql.prepare(
      `SELECT id FROM drafts WHERE jid = ? AND estado = 'pendiente' AND (disparado_por = ? OR (disparado_por IS NULL AND texto = ?))
       ORDER BY id DESC LIMIT 1`,
    ),
  };

  const esVisible = (jid: string) => q.visible.get(jid) !== undefined;

  function horaCorte(): number | null {
    const v = db.horaCorte();
    return v !== undefined && Number.isFinite(v) && v > 0 ? v : null;
  }

  function calcularMetricas() {
    const corte = horaCorte();
    const desde = corte ?? inicioDeHoy(config.timezone);
    const lat = (q.latencias.all(desde) as { l: number }[]).map((r) => Number(r.l));
    const tot = q.totales.get(desde) as { enviados: number; chats: number; citas: number };
    return {
      desde,
      desdeCorte: corte !== null,
      medianaMs: mediana(lat),
      chats: Number(tot.chats) || 0,
      enviados: Number(tot.enviados) || 0,
      citas: Number(tot.citas) || 0,
      at: Date.now(),
    };
  }

  function conexionPublica() {
    return {
      estado: conexion.estado,
      como: typeof conexion.como === 'string' ? conexion.como.slice(0, 60) : null,
      codigoVinculo:
        conexion.estado === 'esperando_vinculo' && typeof conexion.codigoVinculo === 'string'
          ? conexion.codigoVinculo.slice(0, 16)
          : null,
    };
  }

  function chatsVisibles() {
    const filas = q.chatsVisibles.all() as {
      jid: string;
      regla: Regla;
      opt_in: number;
      categoria: Categoria | null;
      interes: number | null;
      actualizado_at: number;
    }[];
    return filas.map((c) => {
      const delPublico = Number(c.opt_in) === 1;
      const mensajes = delPublico
        ? db.recentMessages(c.jid, 2).map((m: Mensaje) => ({
            autor: m.autor,
            texto: recortar(m.texto, LARGO_MENSAJE),
            at: m.at,
          }))
        : [];
      return {
        jid: c.jid,
        quien: enmascarar(c.jid, null),
        regla: REGLAS.includes(c.regla) ? c.regla : 'no_tocar',
        delPublico,
        categoria: c.categoria && CATEGORIAS.includes(c.categoria) ? c.categoria : null,
        interes: c.interes === null || c.interes === undefined ? null : limitar(Number(c.interes), 0, 100),
        mensajes,
        actualizadoAt: c.actualizado_at,
      };
    });
  }

  function borradoresVisibles() {
    return db
      .pendingDrafts()
      .filter((d: Borrador) => esVisible(d.jid))
      .slice(0, 20)
      .map((d: Borrador) => {
        const chat = db.getChat(d.jid);
        return {
          id: d.id,
          quien: enmascarar(d.jid, null),
          delPublico: chat?.opt_in === 1,
          texto: recortar(d.texto, LARGO_BORRADOR, false),
          creadoAt: d.creado_at,
        };
      });
  }

  function memoriaVigente(): Memoria | null {
    let m: Memoria | undefined;
    try {
      m = memoriaActual();
    } catch (err) {
      log('memoriaActual() falló', err);
    }
    if (!m || (ultimaMemoria && ultimaMemoria.at > m.at)) m = ultimaMemoria;
    if (!m) return null;
    return {
      at: Number(m.at) || 0,
      agenda: String(m.agenda ?? ''),
      hoy: String(m.hoy ?? ''),
      perfil: String(m.perfil ?? ''),
    };
  }

  function controles() {
    return {
      pausado: db.pausado(),
      horaCorte: horaCorte(),
      frase: FRASE_VISIBLE,
      proveedor: eleccionActual(),
      proveedorTexto: describirProveedor(),
      proveedores: opcionesProveedor(),
    };
  }

  function ultimoEnvio() {
    const u = q.ultimoEnvio.get() as { jid: string; at: number; latencia_ms: number | null } | undefined;
    return u ? { quien: enmascarar(u.jid, null), at: u.at, latencia_ms: u.latencia_ms ?? null } : null;
  }

  function armarTablero() {
    const total = Number((q.contarVisibles.get() as { n: number }).n) || 0;
    return {
      ahora: Date.now(),
      tz: config.timezone,
      dueno: persona.nombre,
      evento: persona.evento,
      conexion: conexionPublica(),
      ...controles(),
      metricas: calcularMetricas(),
      chats: chatsVisibles(),
      chatsTotal: total,
      noTocar: Number((q.contarOcultos.get() as { n: number }).n) || 0,
      borradores: borradoresVisibles(),
      memoria: memoriaVigente(),
      ultimoEnvio: ultimoEnvio(),
    };
  }

  // ---------- SSE ----------
  const clientes = new Set<Response>();

  function enviarA(res: Response, evento: string, datos: unknown) {
    if (res.writableEnded || res.destroyed) {
      clientes.delete(res);
      return;
    }
    try {
      res.write(`event: ${evento}\ndata: ${JSON.stringify(datos)}\n\n`);
    } catch {
      clientes.delete(res);
    }
  }

  function difundir(evento: string, datos: unknown) {
    for (const res of clientes) enviarA(res, evento, datos);
  }

  /** Recalcula y manda métricas + tablero, agrupando cambios seguidos. */
  let pendiente: NodeJS.Timeout | undefined;
  function refrescar() {
    if (pendiente || clientes.size === 0) return;
    pendiente = setTimeout(() => {
      pendiente = undefined;
      try {
        const t = armarTablero();
        difundir('metricas', t.metricas);
        difundir('tablero', t);
      } catch (err) {
        log('no pude armar el tablero', err);
      }
    }, 150);
  }

  setInterval(() => {
    if (clientes.size === 0) return;
    try {
      difundir('metricas', calcularMetricas());
    } catch (err) {
      log('no pude calcular métricas', err);
    }
  }, CADA_METRICAS_MS).unref();

  setInterval(() => {
    for (const res of clientes) {
      try {
        if (res.writableEnded || res.destroyed) clientes.delete(res);
        else res.write(`: latido ${Date.now()}\n\n`);
      } catch {
        clientes.delete(res);
      }
    }
  }, CADA_LATIDO_MS).unref();

  // ---------- bus: se escucha UNA vez y se reparte a todos los navegadores ----------
  function seguro<A extends unknown[]>(evento: string, fn: (...args: A) => void): (...args: A) => void {
    return (...args: A) => {
      try {
        fn(...args);
      } catch (err) {
        log(`error manejando '${evento}'`, err);
      }
    };
  }

  bus.on(
    'conexion',
    seguro('conexion', (c: EstadoConexion) => {
      if (!c || typeof c !== 'object') return;
      conexion = c;
      difundir('conexion', conexionPublica());
    }),
  );

  bus.on(
    'mensaje_enviado',
    seguro('mensaje_enviado', (m: MensajeEnviado) => {
      if (!m || typeof m.jid !== 'string') return;
      if (esVisible(m.jid)) {
        difundir('mensaje_enviado', {
          quien: enmascarar(m.jid, null),
          latencia_ms: typeof m.latencia_ms === 'number' ? m.latencia_ms : null,
          at: Number(m.at) || Date.now(),
        });
      }
      refrescar();
    }),
  );

  bus.on(
    'chat_actualizado',
    seguro('chat_actualizado', () => {
      // sin jid: el navegador no lo necesita, el tablero que sigue ya viene filtrado
      difundir('chat_actualizado', {});
      refrescar();
    }),
  );

  bus.on(
    'mensaje_entrante',
    seguro('mensaje_entrante', () => refrescar()),
  );

  bus.on(
    'memoria',
    seguro('memoria', (m: Memoria) => {
      if (!m || typeof m !== 'object') return;
      ultimaMemoria = m;
      difundir('memoria', memoriaVigente());
    }),
  );

  bus.on(
    'respuesta_lista',
    seguro('respuesta_lista', (r: RespuestaLista) => {
      if (!r || typeof r.jid !== 'string') return;
      // El cerebro ya guarda el borrador y la categoría antes de emitir; esto es solo una red por si no lo hace.
      // Esperamos un poco para no duplicar si lo guarda justo después de emitir.
      setTimeout(
        seguro('respuesta_lista (diferido)', () => {
          const chat = db.getChat(r.jid);
          if (chat) {
            const campos: { categoria?: Categoria; interes?: number } = {};
            if (CATEGORIAS.includes(r.categoria) && chat.categoria !== r.categoria) campos.categoria = r.categoria;
            const interes = Math.round(limitar(Number(r.interes), 0, 100));
            if (Number.isFinite(Number(r.interes)) && chat.interes !== interes) campos.interes = interes;
            if (Object.keys(campos).length > 0) db.updateChat(r.jid, campos);
          }
          if (r.modo === 'borrador' && typeof r.texto === 'string' && r.texto.trim()) {
            const disparo = typeof r.disparadoPor === 'string' ? r.disparadoPor : null;
            const existente = q.borradorPendiente.get(r.jid, disparo, r.texto) as { id: number } | undefined;
            const id = existente ? Number(existente.id) : db.insertDraft(r.jid, r.texto, disparo);
            citaDeBorrador.set(id, Boolean(r.propone_cita));
          }
          refrescar();
        }),
        60,
      );
    }),
  );

  // ---------- servidor ----------
  const app = express();
  app.disable('x-powered-by');
  app.set('etag', false);

  const hostsPermitidos = new Set([`127.0.0.1:${config.port}`, `localhost:${config.port}`, `[::1]:${config.port}`]);
  app.use((req: Request, res: Response, next: NextFunction) => {
    // contra DNS rebinding: solo atendemos si el navegador cree que está en esta compu
    if (!hostsPermitidos.has(String(req.headers.host ?? '').toLowerCase())) {
      res.status(403).type('text/plain').send('Solo desde esta compu.');
      return;
    }
    res.setHeader('X-Content-Type-Options', 'nosniff');
    res.setHeader('Referrer-Policy', 'no-referrer');
    res.setHeader('X-Frame-Options', 'DENY');
    res.setHeader('Cache-Control', 'no-store');
    next();
  });

  app.use('/api', (req: Request, res: Response, next: NextFunction) => {
    // un formulario de otra pestaña no puede mandar application/json sin preflight (y no damos CORS)
    if (req.method !== 'GET' && !req.is('application/json')) {
      res.status(415).json({ error: 'Mandá JSON (Content-Type: application/json).' });
      return;
    }
    next();
  });
  app.use(express.json({ limit: '16kb', strict: true }));

  app.get('/', (_req: Request, res: Response) => {
    const nonce = randomBytes(16).toString('base64');
    res.setHeader(
      'Content-Security-Policy',
      [
        "default-src 'self'",
        `script-src 'nonce-${nonce}'`,
        "style-src 'self' 'unsafe-inline' https://fonts.googleapis.com",
        'font-src https://fonts.gstatic.com',
        "img-src 'self' data:",
        "connect-src 'self'",
        "base-uri 'none'",
        "form-action 'none'",
        "frame-ancestors 'none'",
      ].join('; '),
    );
    res.type('html').send(plantilla().replaceAll('__NONCE__', nonce));
  });

  app.get('/api/estado', (_req: Request, res: Response) => {
    res.json(armarTablero());
  });

  app.get('/api/stream', (req: Request, res: Response) => {
    res.writeHead(200, {
      'Content-Type': 'text/event-stream; charset=utf-8',
      'Cache-Control': 'no-store, no-transform',
      Connection: 'keep-alive',
      'X-Accel-Buffering': 'no',
    });
    res.write('retry: 3000\n\n');
    clientes.add(res);
    req.on('close', () => clientes.delete(res));
    res.on('error', () => clientes.delete(res));
    try {
      const t = armarTablero();
      enviarA(res, 'conexion', t.conexion);
      enviarA(res, 'metricas', t.metricas);
      enviarA(res, 'tablero', t);
    } catch (err) {
      log('no pude armar el tablero inicial', err);
    }
  });

  app.post('/api/pausa', (req: Request, res: Response) => {
    const pausado = (req.body as { pausado?: unknown } | undefined)?.pausado;
    if (typeof pausado !== 'boolean') {
      res.status(400).json({ error: 'Falta "pausado" (true o false).' });
      return;
    }
    db.setEstado('pausado', pausado ? '1' : '0');
    console.log(pausado ? '[tablero] Romeo en PAUSA' : '[tablero] Romeo reanudado');
    const c = controles();
    difundir('controles', c);
    res.json({ ok: true, ...c });
  });

  app.post('/api/proveedor', (req: Request, res: Response) => {
    const p = (req.body as { proveedor?: unknown } | undefined)?.proveedor;
    if (typeof p !== 'string' || !elegirProveedor(p)) {
      res.status(400).json({ error: 'Proveedor inválido (auto, api, suscripcion, local o prueba).' });
      return;
    }
    db.setEstado('proveedor', p);
    refrescarAhora(ctx); // la memoria se rearma con el cerebro nuevo
    const c = controles();
    difundir('controles', c);
    res.json({ ok: true, ...c });
  });

  app.post('/api/corte', (_req: Request, res: Response) => {
    const ahora = Date.now();
    db.setEstado('hora_corte', String(ahora));
    console.log(`[tablero] Balcón abierto: hora de corte ${new Date(ahora).toLocaleTimeString('es-AR', { timeZone: config.timezone })}`);
    const c = controles();
    difundir('controles', c);
    refrescar();
    res.json({ ok: true, ...c });
  });

  app.post('/api/chats/:jid/regla', (req: Request, res: Response) => {
    const jid = String(req.params.jid ?? '');
    const regla = (req.body as { regla?: unknown } | undefined)?.regla;
    if (typeof regla !== 'string' || !REGLAS.includes(regla as Regla)) {
      res.status(400).json({ error: 'Regla inválida: auto, sugerir o no_tocar.' });
      return;
    }
    if (!jid || jid.length > 128 || !db.getChat(jid)) {
      res.status(404).json({ error: 'No conozco ese chat.' });
      return;
    }
    db.updateChat(jid, { regla: regla as Regla });
    bus.emit('chat_actualizado', { jid });
    res.json({ ok: true, regla });
  });

  function borradorDe(req: Request, res: Response): Borrador | undefined {
    const id = Number(req.params.id);
    if (!Number.isSafeInteger(id) || id <= 0) {
      res.status(400).json({ error: 'Id de borrador inválido.' });
      return undefined;
    }
    const d = q.borrador.get(id) as Borrador | undefined;
    if (!d || !esVisible(d.jid)) {
      res.status(404).json({ error: 'No encuentro ese borrador.' });
      return undefined;
    }
    if (d.estado !== 'pendiente') {
      res.status(409).json({ error: `Ese borrador ya está ${d.estado}.` });
      return undefined;
    }
    return d;
  }

  app.post('/api/borradores/:id/enviar', (req: Request, res: Response) => {
    const d = borradorDe(req, res);
    if (!d) return;
    const envio: EnviarTexto = { jid: d.jid, texto: d.texto };
    if (d.disparado_por) envio.disparadoPor = d.disparado_por;
    const cita = citaDeBorrador.get(d.id);
    if (cita !== undefined) envio.propone_cita = cita;
    bus.emit('enviar_texto', envio);
    db.setDraftEstado(d.id, 'enviado');
    citaDeBorrador.delete(d.id);
    refrescar();
    res.json({ ok: true });
  });

  app.post('/api/borradores/:id/descartar', (req: Request, res: Response) => {
    const d = borradorDe(req, res);
    if (!d) return;
    db.setDraftEstado(d.id, 'descartado');
    citaDeBorrador.delete(d.id);
    refrescar();
    res.json({ ok: true });
  });

  app.use('/api', (_req: Request, res: Response) => {
    res.status(404).json({ error: 'No existe.' });
  });

  // eslint-disable-next-line @typescript-eslint/no-unused-vars
  app.use((err: unknown, _req: Request, res: Response, _next: NextFunction) => {
    const status = typeof (err as { status?: unknown })?.status === 'number' ? (err as { status: number }).status : 500;
    if (status >= 500) log('error en una ruta', err);
    if (res.headersSent) {
      res.end();
      return;
    }
    res.status(status >= 400 && status < 600 ? status : 500).json({
      error: status < 500 ? 'Pedido inválido.' : 'Error interno del tablero.',
    });
  });

  const server = createServer(app);
  await new Promise<void>((resolve, reject) => {
    const alFallar = (err: NodeJS.ErrnoException) => {
      reject(
        err.code === 'EADDRINUSE'
          ? new Error(`El puerto ${config.port} está ocupado: ¿ya hay otro Romeo corriendo? Cerralo o cambiá PORT.`)
          : err,
      );
    };
    server.once('error', alFallar);
    server.listen(config.port, '127.0.0.1', () => {
      server.off('error', alFallar);
      server.on('error', (err) => log('error del servidor', err));
      resolve();
    });
  });
  console.log(`[tablero] escuchando en http://127.0.0.1:${config.port} (solo esta compu)`);
}

// ---------- utilidades ----------

function log(msg: string, err?: unknown) {
  console.error(`[tablero] ${msg}:`, err instanceof Error ? err.message : err);
}

function mediana(valores: number[]): number | null {
  const v = valores.filter((x) => Number.isFinite(x));
  if (v.length === 0) return null;
  const m = Math.floor(v.length / 2);
  return v.length % 2 ? v[m] : Math.round((v[m - 1] + v[m]) / 2);
}

function limitar(n: number, min: number, max: number): number {
  if (!Number.isFinite(n)) return min;
  return Math.min(max, Math.max(min, n));
}

/** Saca marcas invisibles, junta espacios y corta en `max` caracteres (sin partir emojis). */
function recortar(texto: unknown, max: number, unaLinea = true): string {
  let t = String(texto ?? '').replace(/[​-‍⁠﻿]/g, '');
  t = unaLinea ? t.replace(/\s+/g, ' ').trim() : t.trim();
  const chars = Array.from(t);
  return chars.length > max ? chars.slice(0, max - 1).join('').trimEnd() + '…' : t;
}

/** Medianoche de hoy en la zona horaria dada, en epoch ms. */
function inicioDeHoy(tz: string, ahora = Date.now()): number {
  const partes = new Intl.DateTimeFormat('en-US', {
    timeZone: tz,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
    second: '2-digit',
    hourCycle: 'h23',
  }).formatToParts(ahora);
  const p = (t: string) => Number(partes.find((x) => x.type === t)?.value);
  const comoUtc = Date.UTC(p('year'), p('month') - 1, p('day'), p('hour'), p('minute'), p('second'));
  const desfase = comoUtc - Math.floor(ahora / 1000) * 1000;
  return Date.UTC(p('year'), p('month') - 1, p('day')) - desfase;
}

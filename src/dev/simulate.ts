process.env.ROMEO_DATA_DIR ??= 'data-sim';
// Agente Tablero: arranca Romeo sin WhatsApp, con un WhatsApp falso que inyecta mensajes y "envía" respuestas.
//
//   npm run simulate              escenario guionado + modo interactivo (borra data-sim/ al arrancar)
//   npm run simulate -- --conservar   no borra data-sim/
//
// En modo interactivo, cada línea es "<A|B|C|jid|número> <texto>". Ej.: "A te invito un café?".
// Los imports con config van dinámicos para que config.ts ya vea ROMEO_DATA_DIR.
import { rmSync } from 'node:fs';
import { resolve } from 'node:path';
import { createInterface } from 'node:readline';
import { enmascarar, type EnviarTexto, type RespuestaLista } from '../contract.js';

if (process.env.ROMEO_DATA_DIR === 'data-sim' && !process.argv.includes('--conservar')) {
  try {
    rmSync(resolve('data-sim'), { recursive: true, force: true });
  } catch (err) {
    console.warn(`[sim] no pude borrar data-sim/ (¿otro Romeo abierto?): ${(err as Error).message}`);
  }
}

const { main } = await import('../index.js');
const { config } = await import('../config.js');
const ctx = await main({ sinWhatsapp: true });

const URL_TABLERO = `http://127.0.0.1:${config.port}`;
const RUN = Date.now().toString(36);
let n = 0;
const dormir = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));

const CHATS = {
  A: { jid: '5491100000001@s.whatsapp.net', nombre: 'Ana' },
  B: { jid: '5491100000002@s.whatsapp.net', nombre: 'Mamá' },
  C: { jid: '123456789012345@lid', nombre: undefined },
} as const;
type Letra = keyof typeof CHATS;
const letraDe = (jid: string) => (Object.keys(CHATS) as Letra[]).find((k) => CHATS[k].jid === jid);
const etiqueta = (jid: string) => {
  const l = letraDe(jid);
  return `${l ? `[${l}] ` : ''}${enmascarar(jid, null)}`;
};

// ---------- WhatsApp falso ----------
const respuestas = new Map<string, number>();

async function enviarFalso(e: EnviarTexto) {
  if (!e?.jid || !e.texto?.trim()) return;
  await dormir(1500 + Math.random() * 1500); // "escribiendo…"
  if (ctx.db.pausado()) {
    console.log(`[sim] Romeo está en pausa: no envío a ${etiqueta(e.jid)}`);
    return;
  }
  const at = Date.now();
  const origen = e.disparadoPor ? ctx.db.getMessage(e.disparadoPor) : undefined;
  const latencia_ms = origen ? at - origen.at : null;
  const id = `sim-${RUN}-${++n}`;
  ctx.db.insertMessage({
    id,
    jid: e.jid,
    autor: 'romeo',
    texto: e.texto,
    at,
    propone_cita: e.propone_cita ? 1 : 0,
    latencia_ms,
    respuesta_a: e.disparadoPor ?? null,
  });
  respuestas.set(e.jid, (respuestas.get(e.jid) ?? 0) + 1);
  ctx.bus.emit('mensaje_enviado', { jid: e.jid, id, texto: e.texto, at, latencia_ms });
  ctx.bus.emit('chat_actualizado', { jid: e.jid });
  console.log(`→ Romeo a ${etiqueta(e.jid)}: ${e.texto}`);
}

function enviarSeguro(e: EnviarTexto) {
  enviarFalso(e).catch((err) => console.error('[sim] falló el envío falso:', err));
}

ctx.bus.on('respuesta_lista', (r: RespuestaLista) => {
  try {
    if (r.modo === 'enviar') {
      enviarSeguro({ jid: r.jid, texto: r.texto, disparadoPor: r.disparadoPor, propone_cita: r.propone_cita });
    } else {
      console.log(`✎ Borrador para ${etiqueta(r.jid)}: ${r.texto}  (aprobalo en el tablero)`);
    }
  } catch (err) {
    console.error('[sim] respuesta_lista:', err);
  }
});

ctx.bus.on('enviar_texto', (e: EnviarTexto) => {
  try {
    enviarSeguro(e);
  } catch (err) {
    console.error('[sim] enviar_texto:', err);
  }
});

/** Lo mismo que hace src/whatsapp con un mensaje nuevo de un contacto. */
function entrante(jid: string, texto: string, nombre?: string) {
  const id = `sim-in-${RUN}-${++n}`;
  const at = Date.now();
  const chat = ctx.db.ensureChat(jid, nombre ?? null);
  if (chat.primer_mensaje_at == null) ctx.db.updateChat(jid, { primer_mensaje_at: at });
  ctx.db.insertMessage({ id, jid, autor: 'contacto', texto, at });
  console.log(`← ${etiqueta(jid)}: ${texto}`);
  try {
    ctx.bus.emit('mensaje_entrante', nombre ? { jid, id, texto, at, nombre } : { jid, id, texto, at });
    ctx.bus.emit('chat_actualizado', { jid });
  } catch (err) {
    console.error('[sim] un oyente falló con el mensaje entrante:', err);
  }
}

// ---------- escenario ----------
console.log(`\n[sim] Tablero: ${URL_TABLERO}`);
ctx.bus.emit('conexion', { estado: 'conectando' });
await dormir(800);
ctx.bus.emit('conexion', { estado: 'conectado', como: 'vos (simulado)' });

const corte = Date.now();
ctx.db.setEstado('hora_corte', String(corte));
console.log('[sim] Balcón abierto (hora de corte = ahora).');
// Mamá ya es una relación existente: el dueño le escribió ayer
ctx.db.insertStyleSample('old-1', CHATS.B.jid, 'ya llego ma', Date.now() - 86_400_000);

await dormir(1500);
entrante(CHATS.A.jid, 'Hola Romeo', CHATS.A.nombre);
await dormir(3500);
entrante(CHATS.B.jid, 'Hola Romeo, sos vos hijo?', CHATS.B.nombre);
await dormir(4000);
entrante(CHATS.A.jid, 'que hiciste hoy?', CHATS.A.nombre);
await dormir(3000);
entrante(CHATS.C.jid, 'hola romeo, sos un bot?');

// esperamos a que contesten A y C (Claude puede tardar), con tope
const hasta = Date.now() + 60_000;
const contestados = () =>
  new Set(
    (
      ctx.db.sql
        .prepare("SELECT DISTINCT jid FROM messages WHERE autor = 'romeo' AND at >= ?")
        .all(corte) as { jid: string }[]
    ).map((r) => r.jid),
  );
while (Date.now() < hasta) {
  const c = contestados();
  if (c.has(CHATS.A.jid) && c.has(CHATS.C.jid)) break;
  await dormir(500);
}
await dormir(4000); // por si a B le llega algo tarde

const c = contestados();
console.log('\n[sim] ───────── Resumen ─────────');
if (c.size === 0) {
  console.log('[sim] Sin respuestas: el cerebro (src/brain, src/rules) todavía no contesta o está en pausa.');
}
for (const l of ['A', 'B', 'C'] as const) {
  const { jid } = CHATS[l];
  const chat = ctx.db.getChat(jid);
  const recibio = c.has(jid);
  const esperado = l !== 'B';
  const ok = recibio === esperado ? 'OK   ' : 'FALLA';
  console.log(
    `[sim] ${ok} ${l} ${enmascarar(jid, null).padEnd(20)} ${recibio ? 'recibió respuesta' : 'sin respuesta'}` +
      ` (esperado: ${esperado ? 'respuesta' : 'nada'}; regla ${chat?.regla ?? '?'}, opt_in ${chat?.opt_in ?? '?'})`,
  );
}
if (c.has(CHATS.B.jid)) console.log('[sim] ¡OJO! Romeo le contestó a Mamá: revisar las reglas antes del escenario.');

// ---------- modo interactivo ----------
console.log(`\n[sim] Modo interactivo. Escribí "<A|B|C|jid|número> <texto>" (ej.: "A te invito un café?"). "salir" para terminar.`);
console.log(`[sim] Tablero: ${URL_TABLERO}\n`);

function jidDe(token: string): string | undefined {
  const t = token.trim();
  const l = t.toUpperCase();
  if (l === 'A' || l === 'B' || l === 'C') return CHATS[l].jid;
  if (/^[^\s@]+@(s\.whatsapp\.net|lid)$/.test(t)) return t;
  if (/^\d{8,15}$/.test(t)) return `${t}@s.whatsapp.net`;
  return undefined;
}

const rl = createInterface({ input: process.stdin, terminal: false });
rl.on('line', (linea) => {
  try {
    const l = linea.trim();
    if (!l) return;
    if (l === 'salir' || l === 'exit') process.exit(0);
    const [quien, ...resto] = l.split(/\s+/);
    const texto = l.slice(quien.length).trim();
    const jid = jidDe(quien);
    if (!jid || !texto || resto.length === 0) {
      console.log('[sim] Formato: "<A|B|C|jid|número> <texto>"');
      return;
    }
    const letra = letraDe(jid);
    entrante(jid, texto, letra ? CHATS[letra].nombre : undefined);
  } catch (err) {
    console.error('[sim] no pude inyectar ese mensaje:', err);
  }
});
// stdin cerrado (por ejemplo, corriendo en segundo plano): el tablero sigue andando
rl.on('close', () => console.log(`[sim] Sin entrada interactiva. El tablero sigue en ${URL_TABLERO} (Ctrl+C para salir).`));

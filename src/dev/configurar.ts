// npm run configurar — arma romeo.config.json (quién sos en ESTA compu) y el .env (qué cerebro usa).
// Cada compu tiene los suyos: ninguno de los dos se sube al repo.
import { copyFileSync, existsSync, readFileSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { createInterface } from 'node:readline/promises';
import { ARCHIVO_PERSONA, PERSONA_BASE, type Persona } from '../persona.js';

const rl = createInterface({ input: process.stdin, output: process.stdout });

async function preguntar(texto: string, porDefecto = ''): Promise<string> {
  const r = (await rl.question(porDefecto ? `${texto} [${porDefecto}]: ` : `${texto}: `)).trim();
  return r || porDefecto;
}

function leerPrevia(): Persona | undefined {
  try {
    return existsSync(ARCHIVO_PERSONA) ? (JSON.parse(readFileSync(ARCHIVO_PERSONA, 'utf8')) as Persona) : undefined;
  } catch {
    return undefined;
  }
}

/** Cambia (o agrega) CLAVE=valor en el texto de un .env. */
function ponerEnv(texto: string, clave: string, valor: string): string {
  const linea = `${clave}=${valor}`;
  const re = new RegExp(`^${clave}=.*$`, 'm');
  return re.test(texto) ? texto.replace(re, linea) : `${texto.trimEnd()}\n${linea}\n`;
}

async function modelosLocales(base: string): Promise<string[]> {
  try {
    const r = await fetch(`${base}/models`, { signal: AbortSignal.timeout(4_000) });
    const j = (await r.json()) as { data?: { id: string }[] };
    return (j.data ?? []).map((m) => m.id).filter((id) => !/embed/i.test(id));
  } catch {
    return [];
  }
}

const previa = leerPrevia();
const p: Persona = structuredClone(previa ?? PERSONA_BASE);
console.log('\nConfiguración de Romeo para esta compu. Enter deja el valor entre corchetes.\n');

p.nombre = await preguntar('¿Cómo te llamás? (como te dicen en los chats)', previa?.nombre ?? '');
p.descripcion = await preguntar('Una línea sobre cómo hablás', p.descripcion);

// Vault
for (;;) {
  const ruta = await preguntar('Carpeta de tu Vault de Obsidian', previa?.vault.ruta ?? '');
  if (ruta && existsSync(ruta)) {
    p.vault.ruta = resolve(ruta).replaceAll('\\', '/');
    break;
  }
  console.log('  No encuentro esa carpeta. Probá de nuevo (en Windows podés usar / o \\).');
}
const candidatos = ['Journal', 'Diario', 'Daily', 'journal', 'diario', 'daily'].filter((d) => existsSync(join(p.vault.ruta, d)));
p.vault.diario = await preguntar('Carpeta del diario (notas AAAA-MM-DD.md)', candidatos[0] ?? p.vault.diario);
if (!previa) {
  p.vault.notas = ['_sobre-mi.md', 'sobre-mi.md', 'Sobre mí.md']
    .filter((n) => existsSync(join(p.vault.ruta, n)))
    .map((ruta) => ({ ruta, etiqueta: 'sobre mí (perfil general)' }));
}
console.log(`  Notas extra que puede leer: ${p.vault.notas.map((n) => n.ruta).join(', ') || 'ninguna'} (se editan en ${ARCHIVO_PERSONA})`);

// Laburo
p.privacidad.empresaPublica = await preguntar('¿Cómo se nombra tu laburo hacia afuera?', p.privacidad.empresaPublica);
const empresa = await preguntar('Nombre real de la empresa, para taparlo siempre (vacío = ninguno)', '');
if (empresa) p.privacidad.empresaPatron = empresa.toLowerCase().replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

p.evento = await preguntar('Evento donde lo mostrás (vacío = ninguno)', p.evento);
if (p.evento) p.contexto = await preguntar('¿Quién te va a escribir?', `Quien escribe probablemente está en ${p.evento} viendo la charla sobre Romeo.`);

if (previa) copyFileSync(ARCHIVO_PERSONA, `${ARCHIVO_PERSONA}.bak`);
writeFileSync(ARCHIVO_PERSONA, `${JSON.stringify(p, null, 2)}\n`, 'utf8');
console.log(`\n✔ ${ARCHIVO_PERSONA} listo${previa ? ` (el anterior quedó en ${ARCHIVO_PERSONA}.bak)` : ''}.`);

// Cerebro
let env = existsSync('.env') ? readFileSync('.env', 'utf8') : readFileSync('.env.example', 'utf8');
const cerebro = await preguntar('\n¿Qué cerebro? api / suscripcion / local', 'local');
env = ponerEnv(env, 'ROMEO_PROVEEDOR', cerebro);
if (cerebro === 'local') {
  const base = await preguntar('Servidor local (LM Studio :1234, Ollama :11434)', 'http://127.0.0.1:1234/v1');
  env = ponerEnv(env, 'LOCAL_BASE_URL', base);
  const modelos = await modelosLocales(base);
  if (modelos.length) {
    console.log(`  Modelos cargados: ${modelos.join(', ')}`);
    env = ponerEnv(env, 'LOCAL_MODEL', await preguntar('¿Cuál uso?', modelos[0]));
  } else {
    console.log('  No respondió el servidor: abrilo (LM Studio › Developer › Start Server) y cargá un modelo. Queda el primero que liste.');
  }
} else if (cerebro === 'api') {
  console.log('  Pegá tu key en ANTHROPIC_API_KEY dentro del .env (no la escribas acá).');
} else if (cerebro === 'suscripcion') {
  console.log('  Corré "claude setup-token" y pegá el token en CLAUDE_CODE_OAUTH_TOKEN dentro del .env.');
}
writeFileSync('.env', env, 'utf8');
console.log('✔ .env listo.\n\nAhora: npm start (y escaneá el QR de la terminal con WhatsApp › Dispositivos vinculados).\n');
rl.close();

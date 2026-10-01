// Proveedor "suscripción": usa tu Claude Code instalado en modo headless (`claude -p`), con tu login
// de Claude (o el token de `claude setup-token`). Uso personal: Romeo llama a TU Claude Code en TU compu.
import { spawn } from 'node:child_process';
import { mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { config } from '../config.js';
import type { PedidoJson, ResultadoJson } from './claude.js';
import { aplanarMensajes, extraerJson, textoDeSystem } from './formato.js';

/** Carpeta vacía como directorio de trabajo: sin CLAUDE.md ni settings de ningún proyecto. */
const CWD = resolve(config.dataDir, 'claude-code');
let n = 0;
/** Si el CLI no reconoce el id del modelo, se pasa al alias y no se vuelve a intentar. */
let modelo = config.suscripcionModelo;

interface SalidaCli {
  is_error?: boolean;
  result?: string;
  structured_output?: unknown;
  stop_reason?: string;
  total_cost_usd?: number;
}

function correrCli(args: string[], entrada: string, timeoutMs: number): Promise<{ codigo: number | null; stdout: string; stderr: string }> {
  return new Promise((ok, mal) => {
    const env = { ...process.env };
    // con una API key en el entorno, Claude Code la usaría en vez de la suscripción
    delete env.ANTHROPIC_API_KEY;
    delete env.ANTHROPIC_AUTH_TOKEN;
    if (config.claudeCodeOAuthToken) env.CLAUDE_CODE_OAUTH_TOKEN = config.claudeCodeOAuthToken;

    const hijo = spawn(config.claudeCodePath, args, { cwd: CWD, env, windowsHide: true, stdio: ['pipe', 'pipe', 'pipe'] });
    let stdout = '';
    let stderr = '';
    const reloj = setTimeout(() => hijo.kill(), timeoutMs);
    hijo.stdout.on('data', (d) => (stdout += d));
    hijo.stderr.on('data', (d) => (stderr += d));
    hijo.on('error', (e) => {
      clearTimeout(reloj);
      mal(e);
    });
    hijo.on('close', (codigo) => {
      clearTimeout(reloj);
      ok({ codigo, stdout, stderr });
    });
    hijo.stdin.end(entrada);
  });
}

async function intentar(p: PedidoJson, sistemaArchivo: string, entrada: string, conModelo: string) {
  const args = [
    '-p',
    '--model', conModelo,
    '--effort', p.effort,
    '--tools', '',
    '--system-prompt-file', sistemaArchivo,
    '--json-schema', JSON.stringify(p.schema),
    '--output-format', 'json',
    '--no-session-persistence',
    '--setting-sources', 'project',
    '--strict-mcp-config',
  ];
  // el CLI tarda unos segundos en arrancar: más margen que la API
  const r = await correrCli(args, entrada, p.timeoutMs + 30_000);
  let salida: SalidaCli | undefined;
  try {
    salida = JSON.parse(r.stdout.slice(r.stdout.indexOf('{'))) as SalidaCli;
  } catch {
    salida = undefined;
  }
  return { r, salida };
}

export async function pedirSuscripcion(p: PedidoJson): Promise<ResultadoJson> {
  mkdirSync(CWD, { recursive: true });
  const sistemaArchivo = join(CWD, `sistema-${process.pid}-${++n}.txt`);
  writeFileSync(sistemaArchivo, textoDeSystem(p.system), 'utf8');
  const entrada = `${aplanarMensajes(p.messages)}\n\nDevolvé solo el objeto JSON pedido.`;
  try {
    let { r, salida } = await intentar(p, sistemaArchivo, entrada, modelo);
    const errModelo = /model/i.test(`${salida?.result ?? ''} ${r.stderr}`) && (salida?.is_error || r.codigo !== 0);
    if (errModelo && modelo !== 'sonnet') {
      console.warn(`[suscripcion] el CLI no tomó el modelo "${modelo}", pruebo con el alias "sonnet"`);
      modelo = 'sonnet';
      ({ r, salida } = await intentar(p, sistemaArchivo, entrada, modelo));
    }
    if (!salida) {
      const pista = r.stderr.trim().split('\n').pop()?.slice(0, 160) || `salida ${r.codigo}`;
      return { ok: false, motivo: `Claude Code no devolvió JSON: ${pista}` };
    }
    if (salida.is_error) {
      const m = (salida.result ?? '').slice(0, 200);
      if (/authenticat|login|oauth|expired/i.test(m)) {
        return { ok: false, motivo: `sin sesión de Claude Code (${m}). Corré "claude setup-token" y pegá el token en CLAUDE_CODE_OAUTH_TOKEN` };
      }
      return { ok: false, motivo: `Claude Code: ${m || 'error'}` };
    }
    if (salida.stop_reason === 'refusal') return { ok: false, motivo: 'rechazo' };
    const data = salida.structured_output ?? extraerJson(salida.result ?? '');
    if (data === undefined) return { ok: false, motivo: 'JSON inválido' };
    return { ok: true, data, modelo: `suscripción (${modelo})` };
  } catch (e) {
    const err = e as NodeJS.ErrnoException;
    if (err.code === 'ENOENT') return { ok: false, motivo: `no encuentro Claude Code en ${config.claudeCodePath}` };
    return { ok: false, motivo: err.message?.slice(0, 200) ?? 'error de Claude Code' };
  } finally {
    rmSync(sistemaArchivo, { force: true });
  }
}

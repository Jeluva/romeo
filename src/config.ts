import { existsSync } from 'node:fs';
import { join } from 'node:path';
import { persona } from './persona.js';

try {
  process.loadEnvFile('.env');
} catch {
  // sin .env: valores por defecto y modo de prueba
}

export type ProveedorConfig = 'auto' | 'api' | 'suscripcion' | 'local';

/** El claude.exe que instala npm; sin eso, el `claude` del PATH. */
function rutaClaudeCode(): string {
  if (process.platform === 'win32' && process.env.APPDATA) {
    const exe = join(process.env.APPDATA, 'npm', 'node_modules', '@anthropic-ai', 'claude-code', 'bin', 'claude.exe');
    if (existsSync(exe)) return exe;
  }
  return 'claude';
}

export const config = {
  /** api (API key) · suscripcion (tu Claude Code, `claude -p`) · local (LM Studio u Ollama) · auto (api si hay key) */
  proveedor: (process.env.ROMEO_PROVEEDOR || 'auto') as ProveedorConfig,
  anthropicApiKey: process.env.ANTHROPIC_API_KEY || undefined,
  model: 'claude-sonnet-5-5',
  claudeCodePath: process.env.CLAUDE_CODE_PATH || rutaClaudeCode(),
  /** token de `claude setup-token`; sin esto usa el login de tu Claude Code */
  claudeCodeOAuthToken: process.env.CLAUDE_CODE_OAUTH_TOKEN || undefined,
  suscripcionModelo: process.env.SUSCRIPCION_MODELO || 'claude-sonnet-5-5',
  /** LM Studio: http://127.0.0.1:1234/v1 · Ollama: http://127.0.0.1:11434/v1 */
  localBaseUrl: (process.env.LOCAL_BASE_URL || 'http://127.0.0.1:1234/v1').replace(/\/+$/, ''),
  /** ej. qwen3:8b o gemma3:12b; vacío = el primer modelo que liste el servidor */
  localModelo: process.env.LOCAL_MODEL || undefined,
  /** VAULT_PATH del .env gana sobre romeo.config.json */
  vaultPath: process.env.VAULT_PATH || persona.vault.ruta,
  calendarIcsUrl: process.env.CALENDAR_ICS_URL || undefined,
  pairingPhone: process.env.WA_PAIRING_PHONE || undefined,
  port: Number(process.env.PORT || 4545),
  timezone: persona.zonaHoraria,
  simulate: process.env.ROMEO_SIMULATE === '1',
  /** la simulación usa data-sim/ para no ensuciar la base real */
  dataDir: process.env.ROMEO_DATA_DIR || 'data',
  authDir: 'auth',
  /** tope de respuestas automáticas por chat por minuto */
  maxRespuestasPorMinuto: 4,
  /** cada cuánto se recalcula la memoria filtrada */
  memoriaCadaMs: 10 * 60 * 1000,
} as const;

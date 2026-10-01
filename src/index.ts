import { config } from './config.js';
import { Bus, type AppContext } from './contract.js';
import { openDb } from './db/index.js';
import * as whatsapp from './whatsapp/index.js';
import * as rules from './rules/index.js';
import * as memory from './memory/index.js';
import * as brain from './brain/index.js';
import * as dashboard from './dashboard/index.js';
import { describirProveedor, elegirProveedor } from './brain/proveedores.js';

export async function main(opts: { sinWhatsapp?: boolean } = {}): Promise<AppContext> {
  const ctx: AppContext = { bus: new Bus(), db: openDb(config.dataDir) };
  // lo último que se eligió en el tablero gana sobre el .env
  const elegido = ctx.db.getEstado('proveedor');
  if (elegido) elegirProveedor(elegido);

  await memory.start(ctx);
  await brain.start(ctx);
  await rules.start(ctx);
  await dashboard.start(ctx);
  if (!opts.sinWhatsapp && !config.simulate) await whatsapp.start(ctx);

  console.log(`Romeo listo. Tablero en http://localhost:${config.port}`);
  console.log(`Cerebro: ${describirProveedor()}`);
  return ctx;
}

// Se ejecuta solo con `npm start`; src/dev/simulate.ts importa main() sin dispararlo.
if (process.argv[1]?.replaceAll('\\', '/').endsWith('src/index.ts')) {
  main().catch((err) => {
    console.error(err);
    process.exit(1);
  });
}

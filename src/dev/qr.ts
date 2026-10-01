// npm run qr -- <tu número>  →  arma el link de WhatsApp con "Hola Romeo" ya escrito y su QR.
// Acepta "11 2345-6789", "+54 9 11 2345 6789", "5491123456789"… (Argentina: sin 0 ni 15).
import { writeFileSync } from 'node:fs';
import QRCode from 'qrcode';
import qrTerminal from 'qrcode-terminal';
import { FRASE_OPT_IN } from '../contract.js';

/** Número internacional para wa.me: solo dígitos, con 549 para celulares de Argentina. */
export function numeroWaMe(entrada: string): string {
  let d = entrada.replace(/\D/g, '');
  if (d.startsWith('00')) d = d.slice(2);
  if (d.startsWith('0')) d = d.slice(1); // 011 → 11
  if (d.length === 12 && /^\d{2}15/.test(d)) d = d.slice(0, 2) + d.slice(4); // 11 15 xxxx xxxx → 11 xxxx xxxx
  if (d.length === 10) d = `549${d}`; // área + número
  else if (d.startsWith('54') && !d.startsWith('549') && d.length === 12) d = `549${d.slice(2)}`;
  return d;
}

const arg = process.argv.slice(2).join(' ');
if (!arg) {
  console.log('Uso: npm run qr -- <tu número>   (ej. npm run qr -- 11 2345 6789)');
  process.exit(1);
}
const numero = numeroWaMe(arg);
if (!/^\d{11,15}$/.test(numero)) {
  console.log(`No entiendo el número "${arg}". Probá con código de área, ej. 11 2345 6789.`);
  process.exit(1);
}
const frase = FRASE_OPT_IN.replace(/(^|\s)\p{L}/gu, (m) => m.toUpperCase());
const link = `https://wa.me/${numero}?text=${encodeURIComponent(frase)}`;
const svg = await QRCode.toString(link, {
  type: 'svg',
  errorCorrectionLevel: 'M',
  margin: 2,
  color: { dark: '#1F1512', light: '#F1E6CF' },
});
writeFileSync('qr-whatsapp.svg', svg, 'utf8');
console.log(`\nLink: ${link}\nQR guardado en qr-whatsapp.svg. Probalo con la cámara del celu:\n`);
qrTerminal.generate(link, { small: true });

'use strict';
const fs = require('node:fs');
const path = require('node:path');
const source = 'https://www.nasdaqtrader.com/dynamic/SymDir/nasdaqlisted.txt';
const target = path.join(__dirname, '../docs/data/catalogue.json');
async function main() {
  const prior = fs.existsSync(target) ? JSON.parse(fs.readFileSync(target, 'utf8')) : null;
  if (!process.argv[2] && prior && Date.now() - Date.parse(prior.updatedAt) < 86400000) return;
  const response = process.argv[2] ? null : await fetch(source, {signal: AbortSignal.timeout(30000)});
  if (response && !response.ok) throw new Error('Nasdaq directory HTTP ' + response.status);
  const text = response ? await response.text() : fs.readFileSync(process.argv[2], 'utf8');
  if (!text.startsWith('Symbol|Security Name|')) throw new Error('Unexpected directory format');
  const rows = text.split(/\r?\n/).slice(1).map(line => line.split('|'))
    .filter(c => c.length === 8 && c[3] === 'N' && c[6] === 'N' && c[7] === 'N' && /^[A-Z0-9]{1,6}(?:[.-][A-Z0-9]{1,4})?$/.test(c[0]))
    .map(c => ({symbol:c[0],name:(c[0] === 'SPCX' ? 'SpaceX / ' : '') + c[1]}));
  if (rows.length < 1000) throw new Error('Incomplete Nasdaq directory');
  fs.writeFileSync(target, JSON.stringify({source,updatedAt:new Date().toISOString(),rows})+'\n');
  console.log('Nasdaq directory: ' + rows.length + ' listings');
}
main().catch(error => {console.error(error.message);process.exitCode=1;});

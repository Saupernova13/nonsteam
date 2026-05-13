import { NonSteam } from './dist/bundle/index.js';
import fs from 'fs';

const input = 'C:\\Program Files (x86)\\Steam\\userdata\\462180944\\config\\shortcuts.vdf';

const nonsteam = await NonSteam.load(input);
console.log('=== BEFORE ADDING ===');
console.log('Total entries:', nonsteam.shortcuts.entries.length);
console.log('Entry sizes:');
nonsteam.shortcuts.entries.slice(0, 3).forEach((e, i) => {
  const buf = e.toBuffer();
  console.log(`  Entry ${i}: ${e.appName} - buffer ${buf.length} bytes`);
});

nonsteam.addEntry({
  appName: 'Mixtape',
  exe: 'H:\\Games\\PC\\Mixtape (2026)\\Mixtape\\Mixtape.exe',
  startDir: 'H:\\Games\\PC\\Mixtape (2026)\\Mixtape\\',
});

console.log('\n=== AFTER ADDING ===');
console.log('Total entries:', nonsteam.shortcuts.entries.length);
console.log('Entry sizes:');
nonsteam.shortcuts.entries.slice(-3).forEach((e, i) => {
  const buf = e.toBuffer();
  const idx = nonsteam.shortcuts.entries.length - 3 + i;
  console.log(`  Entry ${idx}: ${e.appName} - buffer ${buf.length} bytes`);
});

const mixtape = nonsteam.shortcuts.entries.find(e => e.appName === 'Mixtape');
console.log('\nMixtape entry:');
console.log('  appId:', mixtape.appId);
console.log('  appName:', mixtape.appName);
console.log('  exe:', mixtape.exe);
console.log('  startDir:', mixtape.startDir);
console.log('  Buffer size:', mixtape.toBuffer().length);

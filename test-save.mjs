import { NonSteam, Shortcuts } from './dist/bundle/index.js';
import fs from 'fs';
import path from 'path';

const input = 'C:\\Program Files (x86)\\Steam\\userdata\\462180944\\config\\shortcuts.vdf';

console.log('Path exists:', fs.existsSync(input));
console.log('Path is readable:', fs.accessSync(input, fs.constants.R_OK) ? false : true);
console.log('Path is writable:', (() => { try { fs.accessSync(input, fs.constants.W_OK); return true; } catch { return false; } })());

const nonsteam = await NonSteam.load(input);
console.log('Loaded. Entries:', nonsteam.shortcuts.entries.length);
console.log('LoadedPath:', nonsteam.shortcuts.loadedPath);

nonsteam.addEntry({
  appName: 'Mixtape Test',
  exe: 'test.exe',
});

console.log('Added. Entries:', nonsteam.shortcuts.entries.length);

try {
  console.log('Attempting save to:', input);
  await nonsteam.save(input);
  console.log('Save completed successfully');
} catch (err) {
  console.error('Save failed:', err.message);
}

// Check if file changed
const newSize = fs.statSync(input).size;
console.log('Final file size:', newSize);

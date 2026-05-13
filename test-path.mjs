import { NonSteam } from './dist/bundle/index.js';
import fs from 'fs/promises';
import path from 'path';

const input = 'C:\\Program Files (x86)\\Steam\\userdata\\462180944\\config\\shortcuts.vdf';

const nonsteam = await NonSteam.load(input);

// Monkey-patch fs.writeFile to see what's being called
const originalWriteFile = fs.writeFile;
fs.writeFile = async (filePath, data) => {
  console.log('fs.writeFile called:');
  console.log('  filePath:', filePath);
  console.log('  filePath type:', typeof filePath);
  console.log('  data size:', data.length, 'bytes');
  return originalWriteFile.call(fs, filePath, data);
};

nonsteam.addEntry({
  appName: 'Test',
  exe: 'test.exe',
});

console.log('Calling nonsteam.save(' + input + ')');
await nonsteam.save(input);
console.log('Save completed');

const finalSize = (await fs.stat(input)).size;
console.log('Final file size:', finalSize);

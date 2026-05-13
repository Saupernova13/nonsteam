import { NonSteam } from './dist/bundle/index.js';
import fs from 'fs';

const input = 'C:\\Program Files (x86)\\Steam\\userdata\\462180944\\config\\shortcuts.vdf';

try {
  console.log('Loading shortcuts...');
  const nonsteam = await NonSteam.load(input);
  console.log('Current entries:', nonsteam.shortcuts.entries.length);
  console.log('LoadedPath:', nonsteam.shortcuts.loadedPath);

  const stats1 = fs.statSync(input);
  console.log('File size before modifications:', stats1.size, 'bytes');

  nonsteam.addEntry({
    appName: 'Mixtape',
    exe: 'H:\\Games\\PC\\Mixtape (2026)\\Mixtape\\Mixtape.exe',
    startDir: 'H:\\Games\\PC\\Mixtape (2026)\\Mixtape\\',
  });
  console.log('After adding entry:', nonsteam.shortcuts.entries.length, 'entries');

  const mixtapeEntry = nonsteam.shortcuts.entries.find(e => e.appName === 'Mixtape');
  console.log('Mixtape entry found:', mixtapeEntry ? 'YES' : 'NO');
  if (mixtapeEntry) {
    console.log('  ID:', mixtapeEntry.appId);
    console.log('  AppName:', mixtapeEntry.appName);
  }

  console.log('\nAbout to save...');
  const buffer = nonsteam.shortcuts.toBuffer();
  console.log('Buffer size to write:', buffer.length, 'bytes');

  await nonsteam.save(input);
  console.log('✓ Save completed');

  const stats2 = fs.statSync(input);
  console.log('File size after save:', stats2.size, 'bytes');
  console.log('Size difference:', stats2.size - stats1.size, 'bytes');

  // Small delay to ensure file is written and flushed
  await new Promise(resolve => setTimeout(resolve, 500));

  // Verify by reloading
  console.log('\nReloading file...');
  const verify = await NonSteam.load(input);
  console.log('After reload - entries count:', verify.shortcuts.entries.length);
  const found = verify.shortcuts.entries.find(e => e.appName === 'Mixtape');
  console.log('Mixtape found in saved file:', found ? 'YES' : 'NO');
  if (found) {
    console.log('  ID:', found.appId);
    console.log('  AppName:', found.appName);
  } else {
    console.log('\n⚠️ PROBLEM: Entry was added but not persisted!');
  }
} catch (err) {
  console.error('Error:', err.message);
  console.error(err.stack);
  process.exit(1);
}

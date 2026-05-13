import { NonSteam } from './dist/bundle/index.js';

const input = 'C:\\Program Files (x86)\\Steam\\userdata\\462180944\\config\\shortcuts.vdf';

const nonsteam = await NonSteam.load(input);

console.log('installInfo:', nonsteam.installInfo);
console.log('userInfo:', nonsteam.userInfo);
console.log('userId:', nonsteam.userId);

nonsteam.addEntry({
  appName: 'Test',
  exe: 'test.exe',
});

console.log('\nCalling save...');
if (!nonsteam.userInfo) {
  console.log('⚠️ WARNING: userInfo is undefined! Save will return early!');
}

await nonsteam.save(input);
console.log('Save completed');

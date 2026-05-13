import fs from 'fs/promises';
import path from 'path';

const testFile = path.join(process.cwd(), 'test-write-output.txt');
console.log('Test file path:', testFile);

await fs.writeFile(testFile, 'Test content 12345');
const stat = await fs.stat(testFile);
console.log('Written. File size:', stat.size);

const content = await fs.readFile(testFile, 'utf8');
console.log('Read back:', content);

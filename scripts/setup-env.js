import fs from 'node:fs';
import path from 'node:path';

const root = process.cwd();
const example = path.join(root, '.env.example');
const target = path.join(root, '.env');

if (fs.existsSync(target)) {
  console.log('.env already exists — leaving it unchanged.');
  process.exit(0);
}

if (!fs.existsSync(example)) {
  console.error('.env.example is missing.');
  process.exit(1);
}

fs.copyFileSync(example, target, fs.constants.COPYFILE_EXCL);
console.log('Created .env from .env.example.');
console.log('Edit .env and set EULERSTREAM_API_KEY before starting the server.');

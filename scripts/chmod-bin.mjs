import { chmodSync } from 'node:fs';

chmodSync(new URL('../dist/bin/ituran-axi.js', import.meta.url), 0o755);

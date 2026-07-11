// 把编译产物标记为 CommonJS：项目根 package.json 为 "type":"module"，
// 因此把 sim 编译到 .tmp-test 后，需要在该目录放一个 {"type":"commonjs"}
// 的 package.json，让 Node 以 CJS 方式加载（否则 .js 会被当作 ESM 而报错）。
import { writeFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';

const here = dirname(fileURLToPath(import.meta.url));
const target = resolve(here, '../.tmp-test/package.json');
writeFileSync(target, '{\n  "type": "commonjs"\n}\n');
console.log('[test:det] wrote', target);

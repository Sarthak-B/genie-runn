import {mkdir,copyFile} from 'node:fs/promises';
await mkdir('dist',{recursive:true});
await copyFile('public/index.html','dist/index.html');

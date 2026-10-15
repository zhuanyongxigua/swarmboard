// Bundle the board into one self-contained document for both MCP Apps hosts and local preview.
import { build } from 'esbuild';
import { mkdir, writeFile } from 'node:fs/promises';
const result = await build({entryPoints:['web/main.tsx'],bundle:true,write:false,outdir:'dist/ui',format:'iife',platform:'browser',target:'es2022',jsx:'automatic',minify:true,legalComments:'none'});
const js = result.outputFiles.find(file=>file.path.endsWith('.js'))?.text ?? result.outputFiles[0].text;
const css = result.outputFiles.find(file=>file.path.endsWith('.css'))?.text ?? '';
await mkdir('dist',{recursive:true});
await writeFile('dist/widget.html',`<!doctype html><html lang="zh-CN"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><meta name="color-scheme" content="light dark"><title>Swarmboard · 协作空间</title><style>${css}</style></head><body><div id="root"></div><script>${js.replace(/<\/script/gi,'<\\/script')}</script></body></html>`);

import { createCanvas, GlobalFonts } from '@napi-rs/canvas';
import { decompress } from 'wawoff2';
import { readFileSync, writeFileSync, mkdirSync } from 'fs';
import { createRequire } from 'module';
const require = createRequire(import.meta.url);
async function ttf(pkg, file){ const p=require.resolve(`${pkg}/files/${file}`); const out=await decompress(readFileSync(p)); const t=`/tmp/${file.replace('.woff2','.ttf')}`; writeFileSync(t,out); return t; }
GlobalFonts.registerFromPath(await ttf('@fontsource/fraunces','fraunces-latin-600-normal.woff2'),'FrauncesAM');
GlobalFonts.registerFromPath(await ttf('@fontsource/dm-sans','dm-sans-latin-600-normal.woff2'),'DMSansAM');

const W=1024,H=1536;
const cv=createCanvas(W,H); const ctx=cv.getContext('2d'); ctx.clearRect(0,0,W,H);

const topH=Math.round(H*0.14);
let g=ctx.createLinearGradient(0,0,0,topH);
g.addColorStop(0,'rgba(0,0,0,0.55)'); g.addColorStop(1,'rgba(0,0,0,0)');
ctx.fillStyle=g; ctx.fillRect(0,0,W,topH);

const botH=Math.round(H*0.14);
g=ctx.createLinearGradient(0,H-botH,0,H);
g.addColorStop(0,'rgba(0,0,0,0)'); g.addColorStop(1,'rgba(0,0,0,0.55)');
ctx.fillStyle=g; ctx.fillRect(0,H-botH,W,botH);

ctx.shadowColor='rgba(0,0,0,0.7)'; ctx.shadowBlur=10; ctx.shadowOffsetY=3;
ctx.fillStyle='#fff'; ctx.font='600 76px FrauncesAM';
ctx.textAlign='left'; ctx.textBaseline='top';
const padX=Math.round(W*0.05), padY=Math.round(H*0.03);
ctx.fillText('AskMai', padX, padY);

ctx.shadowBlur=6; ctx.shadowOffsetY=2;
ctx.font='600 40px DMSansAM'; ctx.textBaseline='alphabetic';
const url='www.askmai.co', ls=6;
let total=0; for(const ch of url){ total+=ctx.measureText(ch).width+ls; } total-=ls;
let x=W/2-total/2; const y=Math.round(H-botH*0.42); ctx.textAlign='left';
for(const ch of url){ ctx.fillText(ch,x,y); x+=ctx.measureText(ch).width+ls; }

mkdirSync('src/lib/render-assets',{recursive:true});
writeFileSync('src/lib/render-assets/askmai-share-overlay-1024x1536.png', cv.toBuffer('image/png'));
console.log('overlay regenerated (wordmark top-left)');

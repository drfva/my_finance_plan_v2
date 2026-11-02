import {test} from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import {fileURLToPath} from 'node:url';

const root=path.resolve(fileURLToPath(new URL('../',import.meta.url)));
const html=fs.readFileSync(path.join(root,'help/index.html'),'utf8');
const values=(pattern,source=html)=>[...source.matchAll(pattern)].map(match=>match[1]);

test('руководство: содержание, якоря и локальные ресурсы не имеют битых ссылок',()=>{
  const ids=values(/\bid="([^"]+)"/g);
  assert.equal(new Set(ids).size,ids.length,'ID должны быть уникальными');
  const sections=values(/<section id="([^"]+)" data-guide-section/g);
  assert.ok(sections.length>=12,'нужны инструкции для личного и семейного плана');
  const hashes=values(/href="#([^"]+)"/g);
  for(const id of hashes)assert.ok(ids.includes(id),`Не найден якорь ${id}`);
  for(const id of sections)assert.ok(hashes.includes(id),`Раздел ${id} отсутствует в содержании`);
  for(const link of values(/(?:href|src)="([^"#]+)"/g)){
    if(/^(?:https?:|data:)/.test(link))continue;
    const target=path.resolve(root,'help',link);
    assert.ok(target===root||target.startsWith(root+path.sep),`Ресурс вне проекта: ${link}`);
    assert.ok(fs.existsSync(target),`Не найден ${link}`);
    if(fs.statSync(target).isDirectory())assert.ok(fs.existsSync(path.join(target,'index.html')));
  }
});

test('руководство: скриншоты существуют, имеют alt и правильные размеры',()=>{
  const images=[...html.matchAll(/<img src="(images\/[^"]+)" alt="([^"]+)"[^>]*width="(\d+)" height="(\d+)"/g)];
  assert.ok(images.length>=10,'нужны скриншоты основных сценариев');
  for(const [,name,alt,width,height] of images){
    assert.ok(alt.length>15,`Нужен понятный alt для ${name}`);
    const bytes=fs.readFileSync(path.join(root,'help',name));
    assert.equal(bytes.readUInt16BE(0),0xffd8,'снимок должен быть настоящим JPEG');
    let size;
    for(let offset=2;offset<bytes.length;){
      if(bytes[offset++]!==0xff)continue;
      while(bytes[offset]===0xff)offset++;
      const marker=bytes[offset++];if(marker===0xd8||marker===0xd9)continue;
      const length=bytes.readUInt16BE(offset);
      if([0xc0,0xc1,0xc2,0xc3,0xc5,0xc6,0xc7,0xc9,0xca,0xcb,0xcd,0xce,0xcf].includes(marker)){
        size=[bytes.readUInt16BE(offset+5),bytes.readUInt16BE(offset+3)];break;
      }
      offset+=length;
    }
    assert.deepEqual(size,[Number(width),Number(height)],name);
    assert.ok(bytes.length<1024*1024,`Слишком большой снимок ${name}`);
  }
});

test('руководство: общая шапка открывает справку относительно адреса GitHub Pages',()=>{
  const shell=fs.readFileSync(path.join(root,'src/ui/app.js'),'utf8');
  const link=shell.match(/<a class="help-link"[^>]*>/)?.[0];
  assert.ok(link,'значок справки должен быть в общей шапке');
  assert.match(link,/target="_blank"/);assert.match(link,/rel="noopener"/);
  const href=link.match(/href="([^"]+)"/)[1];
  for(const base of ['https://example.test/project/','https://example.test/project/index.html?plan=private','https://example.test/']){
    const url=new URL(href,base);
    assert.equal(url.origin,new URL(base).origin);assert.ok(url.pathname.endsWith('/help/'));
    if(base.includes('/project/'))assert.equal(url.pathname,'/project/help/');
    assert.equal(url.search,'','в справку не передаётся ID личного плана');
  }
  const script=fs.readFileSync(path.join(root,'help/guide.js'),'utf8');
  assert.doesNotMatch(script,/createClient|\.rpc\(|APP_CONFIG|service_role/,'справка должна открываться без базы и авторизации');
});

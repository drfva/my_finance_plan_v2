import {applyTheme,readTheme,nextTheme} from '../src/core/theme.js';
import {themeButton,updateThemeButton} from '../src/ui/theme-switch.js';

applyTheme(readTheme());
const themeRoot=document.querySelector('#guide-theme');
themeRoot.innerHTML=themeButton();
themeRoot.addEventListener('click',event=>{
  const button=event.target.closest('[data-theme-cycle]');if(!button)return;
  const theme=applyTheme(nextTheme(button.dataset.theme));updateThemeButton(button,theme);
});

const search=document.querySelector('#guide-search');
const sections=[...document.querySelectorAll('[data-guide-section]')];
const links=[...document.querySelectorAll('.guide-toc a')];
const normalize=value=>value.toLocaleLowerCase('ru').replace(/ё/g,'е');
const contents=new Map(sections.map(section=>[section,normalize(section.textContent+' '+section.dataset.keywords)]));
function filter(){
  const words=normalize(search.value).trim().split(/\s+/).filter(Boolean);
  let shown=0;
  for(const section of sections){
    section.hidden=!words.every(word=>contents.get(section).includes(word));if(!section.hidden)shown++;
    const link=links.find(a=>a.hash==='#'+section.id);if(link)link.hidden=section.hidden;
    if(words.length)for(const item of section.querySelectorAll('details'))item.open=words.every(word=>normalize(item.textContent).includes(word));
  }
  document.querySelector('#guide-empty').hidden=shown>0;
  document.querySelector('#guide-results').textContent=words.length?`Найдено разделов: ${shown} из ${sections.length}`:'';
}
search.addEventListener('input',filter);
function revealHash(){
  let id;try{id=decodeURIComponent(location.hash.slice(1));}catch{return;}
  const target=document.getElementById(id);
  if(target?.closest('[data-guide-section]')?.hidden){search.value='';filter();target.scrollIntoView();}
}
window.addEventListener('hashchange',revealHash);revealHash();
if('IntersectionObserver' in window){
  const observer=new IntersectionObserver(entries=>{
    const current=entries.find(entry=>entry.isIntersecting&&!entry.target.hidden);if(!current)return;
    for(const link of links){if(link.hash==='#'+current.target.id)link.setAttribute('aria-current','location');else link.removeAttribute('aria-current');}
  },{rootMargin:'-10% 0px -70% 0px'});
  sections.forEach(section=>observer.observe(section));
}
const navigation=document.querySelector('.guide-navigation');
navigation.open=matchMedia('(min-width:761px)').matches;
document.querySelector('.guide-toc').addEventListener('click',event=>{
  if(event.target.closest('a')&&matchMedia('(max-width:760px)').matches)navigation.open=false;
});
document.querySelector('#guide-print').addEventListener('click',()=>{
  search.value='';filter();
  const details=[...document.querySelectorAll('#questions details')],before=details.map(item=>item.open);
  details.forEach(item=>item.open=true);
  window.addEventListener('afterprint',()=>details.forEach((item,i)=>item.open=before[i]),{once:true});
  window.print();
});
const dialog=document.querySelector('#guide-image-dialog');
document.addEventListener('click',event=>{
  const link=event.target.closest('[data-enlarge]');if(!link||!dialog.showModal)return;
  event.preventDefault();
  const image=link.querySelector('img'),large=document.querySelector('#guide-image');
  large.src=link.href;large.alt=image.alt;
  document.querySelector('#guide-image-caption').textContent=link.closest('figure').querySelector('figcaption').textContent;
  dialog.showModal();
});
document.querySelector('#guide-image-close').addEventListener('click',()=>dialog.close());
dialog.addEventListener('click',event=>{if(event.target===dialog){const rect=dialog.getBoundingClientRect();if(event.clientX<rect.left||event.clientX>rect.right||event.clientY<rect.top||event.clientY>rect.bottom)dialog.close();}});

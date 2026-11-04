/* Навигация телефона: native dialog даёт inert-фон, Escape и удержание фокуса. */
import {esc} from './dom.js';
export function mobileNavigation(tabs,{planTitle='',role=''}={}){
  return `<button class="mobile-menu-button" data-mobile-menu-open aria-label="Открыть меню" aria-haspopup="dialog" aria-expanded="false" aria-controls="mobile-navigation"><svg width="24" height="24" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" aria-hidden="true"><path d="M4 6h16M4 12h16M4 18h16"/></svg></button>
    <dialog id="mobile-navigation" class="mobile-navigation" aria-label="Разделы плана"><div class="row between"><h2>Разделы</h2><button data-mobile-menu-close aria-label="Закрыть меню">✕</button></div><p class="mobile-plan-name">${esc(planTitle)}<small>${esc(role)}</small></p><nav aria-label="Разделы плана">${tabs}</nav></dialog>`;
}
export function syncMobileNavigation(root,ui){
  const dialog=root.querySelector('#mobile-navigation');if(!dialog)return;
  if(ui.mobileMenu&&!dialog.open)dialog.showModal();
  root.querySelector('[data-mobile-menu-open]')?.setAttribute('aria-expanded',String(Boolean(ui.mobileMenu)));
  document.body.classList.toggle('navigation-open',Boolean(ui.mobileMenu));
  if(ui.mobileScrollTop){ui.mobileScrollTop=false;window.scrollTo({top:0,behavior:'instant'});}
  const close=()=>{ui.mobileMenu=false;document.body.classList.remove('navigation-open');const button=root.querySelector('[data-mobile-menu-open]');button?.setAttribute('aria-expanded','false');button?.focus({preventScroll:true});};
  dialog.addEventListener('close',close);
  dialog.addEventListener('click',ev=>{if(ev.target!==dialog)return;const r=dialog.getBoundingClientRect();if(ev.clientX<r.left||ev.clientX>r.right||ev.clientY<r.top||ev.clientY>r.bottom)dialog.close();});
}
export function attachMobileNavigation(root,ui,render){
  const media=window.matchMedia('(max-width:760px)');
  media.addEventListener('change',ev=>{if(!ev.matches)root.querySelector('#mobile-navigation')?.close();});
  root.addEventListener('click',ev=>{
    if(ev.target.closest('[data-mobile-menu-open]')){ui.mobileMenu=true;render();return;}
    if(ev.target.closest('[data-mobile-menu-close]'))root.querySelector('#mobile-navigation')?.close();
    if(ev.target.closest('[data-tab]')){ui.mobileScrollTop=Boolean(ev.target.closest('#mobile-navigation'));ui.mobileMenu=false;document.body.classList.remove('navigation-open');}
  });
}

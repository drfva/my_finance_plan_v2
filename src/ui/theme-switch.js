import { currentTheme, nextTheme } from '../core/theme.js';

const labels={light:'светлая',dark:'тёмная',system:'как в системе'};
const shapes={
  light:'<circle cx="12" cy="12" r="4"/><path d="M12 2v2m0 16v2M2 12h2m16 0h2M4.93 4.93l1.42 1.42m11.3 11.3 1.42 1.42M4.93 19.07l1.42-1.42m11.3-11.3 1.42-1.42"/>',
  dark:'<path d="M20.9 13A9 9 0 0 1 11 3.1 9 9 0 1 0 20.9 13Z"/>',
  system:'<rect x="3" y="4" width="18" height="13" rx="2"/><path d="M8 21h8m-4-4v4"/>',
};
const icon=theme=>`<svg width="21" height="21" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.7" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">${shapes[theme]}</svg>`;
const description=theme=>`Тема: ${labels[theme]}. Переключить: ${labels[nextTheme(theme)]}`;

export function themeButton(theme=currentTheme()) {
  return `<button class="ghost theme-switch" data-theme-cycle data-theme="${theme}" aria-label="${description(theme)}" title="${description(theme)}">${icon(theme)}</button>`;
}

export function updateThemeButton(button,theme) {
  button.dataset.theme=theme;
  button.innerHTML=icon(theme);
  button.setAttribute('aria-label',description(theme));
  button.setAttribute('title',description(theme));
}

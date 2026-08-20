/**
 * navmenu.js — the discoverable route into the terminal.
 *
 * The module tabs are already clickable, but they only work if you can guess
 * what "04 Options" holds, and their leading numbers read as ordinals rather
 * than as key hints. This menu names every module, says in one line what is
 * in it, and shows the key beside it — so someone who has never touched the
 * keyboard shortcuts can navigate by clicking, and picks them up on the way.
 */

import { h, mount, icon } from '../core/dom.js';
import { bind, pushScope, popScope, keycaps, IS_MAC } from '../core/keys.js';

export function NavMenu({ modules, onPick, onSearch, isCurrent }) {
  const label = h('span.navbtn__t', 'Modules');
  const trigger = h('button.navbtn', {
    type: 'button',
    'aria-haspopup': 'menu',
    'aria-expanded': 'false',
    'aria-controls': 'navMenu',
    title: 'Browse all modules',
  }, icon('grid', 13), label, h('span.navbtn__c', icon('chevron', 11)));

  const list = h('div.menu__list', { role: 'menu', 'aria-label': 'Modules' });
  const el = h('div.menu#navMenu', { hidden: true },
    h('div.menu__head', 'Go to'),
    list,
    h('div.menu__foot',
      h('span', 'Tip: press '),
      h('kbd', '1'), h('span', '–'), h('kbd', '7'), h('span', ' to switch instantly, or '),
      h('kbd', IS_MAC ? '⌘' : 'Ctrl'), h('kbd', 'K'), h('span', ' to search everything.')));

  let open = false;
  let items = [];
  let cursor = 0;

  function draw() {
    items = modules.map((m, i) => {
      const here = isCurrent(m.id);
      const row = h('button.menu__i', {
        type: 'button',
        role: 'menuitem',
        'aria-current': here ? 'true' : null,
        onClick: () => { close(); onPick(m.id); },
        onMouseEnter: () => focusAt(i, false),
      },
        h('span.menu__ico', icon(m.icon, 14)),
        h('span.menu__b',
          h('span.menu__n', m.title, here ? h('span.menu__here', 'open') : null),
          h('span.menu__d', m.blurb)),
        h('kbd', String(i + 1)));
      return row;
    });
    mount(list, ...items);
  }

  function focusAt(i, move = true) {
    if (!items.length) return;
    cursor = (i + items.length) % items.length;
    if (move) items[cursor].focus();
  }

  function show() {
    if (open) return close();
    draw();
    const box = trigger.getBoundingClientRect();
    el.style.left = `${Math.round(box.left)}px`;
    el.style.top = `${Math.round(box.bottom + 6)}px`;
    el.hidden = false;
    // Reveal synchronously: a transition started from a frame callback never
    // runs in a background tab and would leave the menu open but invisible.
    void el.offsetHeight;
    el.classList.add('is-on');
    trigger.setAttribute('aria-expanded', 'true');
    open = true;
    pushScope('menu');
    cursor = Math.max(0, modules.findIndex((m) => isCurrent(m.id)));
    focusAt(cursor);
    document.addEventListener('pointerdown', onOutside, true);
  }

  function close() {
    if (!open) return;
    open = false;
    el.classList.remove('is-on');
    trigger.setAttribute('aria-expanded', 'false');
    popScope('menu');
    document.removeEventListener('pointerdown', onOutside, true);
    setTimeout(() => { el.hidden = true; }, 140);
    trigger.focus();
  }

  function onOutside(e) {
    if (!el.contains(e.target) && !trigger.contains(e.target)) close();
  }

  trigger.addEventListener('click', show);
  trigger.addEventListener('keydown', (e) => {
    if (e.key === 'ArrowDown' || e.key === 'ArrowUp') { e.preventDefault(); show(); }
  });

  el.addEventListener('keydown', (e) => {
    if (e.key === 'ArrowDown') { e.preventDefault(); focusAt(cursor + 1); }
    else if (e.key === 'ArrowUp') { e.preventDefault(); focusAt(cursor - 1); }
    else if (e.key === 'Home') { e.preventDefault(); focusAt(0); }
    else if (e.key === 'End') { e.preventDefault(); focusAt(items.length - 1); }
    else if (e.key === 'Tab') { close(); }
    else if (e.key === '/' && onSearch) { e.preventDefault(); close(); onSearch(); }
  });

  // Escape here beats the global "close / restore" binding while the menu is up.
  bind('menu', 'escape', close, { hidden: true });

  return { trigger, el, show, close, get isOpen() { return open; } };
}

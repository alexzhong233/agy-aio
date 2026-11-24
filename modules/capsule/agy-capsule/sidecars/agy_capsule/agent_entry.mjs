// Custom-agent entry for the enhanced model capsule.
// The host only passes `agentSelector` to the composer on the new-conversation page;
// an existing conversation keeps the agent it started with, so there is nothing to pick.
// Every function here is injected with fn.toString(), so each one stays self-contained.

export function readAgentState(trigger) {
  if (!trigger) return null;
  const key = Object.keys(trigger).find(k => k.startsWith('__reactFiber$'));
  let fiber = key && trigger[key];
  if (!fiber) return null;
  // After a commit the DOM node can still point at the previous fiber; read the current tree.
  if (fiber.alternate) {
    let root = fiber;
    while (root.return) root = root.return;
    if (root.stateNode?.current && root !== root.stateNode.current) fiber = fiber.alternate;
  }
  let selector = null;
  for (let node = fiber; node; node = node.return) {
    const el = node.memoizedProps?.agentSelector;
    const props = el && typeof el === 'object' ? el.props : null;
    if (props && Array.isArray(props.agentCustomizations) && typeof props.setSelectedAgentScriptItem === 'function') {
      selector = props;
      break;
    }
  }
  if (!selector || selector.agentScriptsEnabled === false) return null;
  const entries = selector.agentCustomizations.filter(c => c?.agent && !c.agent.disabled &&
    typeof c.agent.name === 'string' && c.agent.name.trim());
  if (!entries.length) return null;
  const selectedName = typeof selector.selectedAgentScriptItem?.name === 'string' ? selector.selectedAgentScriptItem.name : null;
  const err = selector.agentScriptsError;
  return {
    items: entries.map(c => ({
      name: c.agent.name,
      description: typeof c.agent.description === 'string' ? c.agent.description : '',
      path: typeof c.path === 'string' ? c.path : '',
    })),
    selected: entries.some(c => c.agent.name === selectedName) ? selectedName : null,
    loading: selector.isLoadingAgentScripts === true,
    error: err ? String(err.message || err) : null,
    choose(name) {
      if (name == null) return selector.setSelectedAgentScriptItem(undefined);
      const hit = entries.find(c => c.agent.name === name);
      if (hit) return selector.setSelectedAgentScriptItem(hit.agent, hit.path);
    },
    refresh() {
      if (typeof selector.refreshAgentScripts === 'function') selector.refreshAgentScripts();
    },
  };
}


export const AGENT_ENTRY_CSS = `
.dk-agent-slot[hidden] { display: none; }
.dk-ae-trigger {
  display: inline-flex; align-items: center; gap: 4px; max-width: 100%;
  height: 26px; margin: 1px 0 0; padding: 0 4px 0 7px; border: 0; border-radius: 9999px;
  background: transparent; color: var(--secondary-foreground, var(--foreground, CanvasText));
  font: inherit; cursor: pointer; outline: none; white-space: nowrap;
  transition: background 0.1s ease, color 0.1s ease;
}
.dk-ae-trigger:hover, .dk-ae-trigger:focus-visible, .dk-ae-trigger[aria-expanded="true"] {
  background: var(--secondary, rgba(128, 128, 128, 0.12)); color: var(--foreground, CanvasText);
}
.dk-ae-trigger[data-custom="true"] { color: var(--foreground, CanvasText); }
.dk-ae-trigger > .dk-ae-name { min-width: 0; overflow: hidden; text-overflow: ellipsis; }
.dk-ae-ico { width: 14px; height: 14px; flex-shrink: 0; display: block; }
.dk-ae-down { width: 14px; height: 14px; flex-shrink: 0; display: block; opacity: 0.8; transition: transform 0.16s ease; }
.dk-ae-trigger[aria-expanded="true"] .dk-ae-down { transform: rotate(180deg); }
/* The list drops down over the model list (then over Orchestrator and the effort bar) instead of
   growing the panel, which is anchored above the capsule and would otherwise grow upward. */
.dk-ae-list {
  position: absolute; z-index: 4; left: 4px; right: 4px; top: 0;
  overflow-y: auto; overscroll-behavior: contain; scrollbar-width: none;
  background: var(--card, rgb(19, 19, 23));
  opacity: 0; visibility: hidden; transform: translateY(-3px);
  transition: opacity 0.14s ease, transform 0.14s ease, visibility 0s linear 0.14s;
}
.dk-ae-list::-webkit-scrollbar { display: none; }
.dk-ae-list[data-open="true"] {
  opacity: 1; visibility: visible; transform: none;
  transition: opacity 0.14s ease, transform 0.14s ease, visibility 0s;
}
.dk-ae-list > div { display: flex; flex-direction: column; gap: 1px; padding-bottom: 4px; }
/* Closing divider so the agent rows read apart from the model rows left visible below. */
.dk-ae-list > div::after {
  content: ""; flex-shrink: 0; height: 1px; margin: 3px 6px 0;
  background: color-mix(in srgb, var(--foreground, #fff) 9%, transparent);
}
@media (prefers-reduced-motion: reduce) { .dk-ae-list, .dk-ae-list[data-open="true"] { transition: none; transform: none; } }
.dk-ae-list .dk-model-row .dk-mp-name { overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.dk-ae-sep { height: 1px; margin: 4px 6px; background: color-mix(in srgb, var(--foreground, #fff) 9%, transparent); }
#deck-metrics-strip .dk-ae-tag {
  display: inline-flex; align-items: center; gap: 3px; flex-shrink: 1; min-width: 0; max-width: 11em;
  height: 24px; margin-right: 6px; padding: 0 8px 0 6px; border: 0; border-radius: 9999px;
  background: color-mix(in srgb, var(--foreground, #fff) 7%, transparent);
  color: var(--secondary-foreground, var(--foreground, CanvasText)); font: inherit; cursor: pointer; outline: none;
  transition: background 0.1s ease, color 0.1s ease;
}
#deck-metrics-strip .dk-ae-tag:hover, #deck-metrics-strip .dk-ae-tag:focus-visible {
  background: var(--secondary, rgba(128, 128, 128, 0.14)); color: var(--foreground, CanvasText);
}
#deck-metrics-strip .dk-ae-tag > span { overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
#deck-metrics-strip .dk-ae-tag .dk-ae-ico { width: 13px; height: 13px; }
`;

// A capsule at the top of the model panel opens an inline, one-line-per-agent list;
// descriptions only show on hover. A tag right of the footer capsule keeps a custom agent visible.
export function renderAgentEntry(slot, agents, ctx) {
  const st = slot._dkAgent ??= {};
  // The host shows its own read-only chip for the chosen agent; ours replaces it while it is shown.
  const composer = ctx?.footer?.closest?.('.agy-composer-footer') || ctx?.footer;
  const clearTag = () => {
    st.tag?.remove();
    st.tag = null;
    if (composer?.dataset) delete composer.dataset.deckAgentTag;
  };
  if (!agents || !Array.isArray(agents.items) || !agents.items.length) {
    st.cleanup?.(); st.cleanup = null; st.sig = null; st.open = false; clearTag();
    slot.replaceChildren();
    return;
  }
  const SVG_BOT = '<svg class="dk-ae-ico" viewBox="0 -960 960 960" fill="currentColor" aria-hidden="true"><path d="M160-360q-50 0-85-35t-35-85q0-50 35-85t85-35v-80q0-33 23.5-56.5T240-760h120q0-50 35-85t85-35q50 0 85 35t35 85h120q33 0 56.5 23.5T800-680v80q50 0 85 35t35 85q0 50-35 85t-85 35v160q0 33-23.5 56.5T720-120H240q-33 0-56.5-23.5T160-200v-160Zm200-80q25 0 42.5-17.5T420-500q0-25-17.5-42.5T360-560q-25 0-42.5 17.5T300-500q0 25 17.5 42.5T360-440Zm240 0q25 0 42.5-17.5T660-500q0-25-17.5-42.5T600-560q-25 0-42.5 17.5T540-500q0 25 17.5 42.5T600-440ZM320-280h320v-80H320v80Zm-80 80h480v-480H240v480Zm240-240Z"/></svg>';
  const SVG_DOWN = '<svg class="dk-ae-down" viewBox="0 -960 960 960" fill="currentColor" aria-hidden="true"><path d="M480-357.85L253.85-584L296-626.15l184,184l184-184L706.15-584L480-357.85Z"/></svg>';
  const SVG_CHECK = '<svg class="dk-mp-check" viewBox="0 -960 960 960" fill="currentColor" aria-hidden="true"><path d="M382-240 154-468l57-57 171 171 367-367 57 57-424 424Z"/></svg>';
  const zh = !!ctx.zh;
  const T = zh
    ? { agent: 'Agent', main: '主 Agent', mainDesc: '默认 Agent，不加载自定义脚本', tag: '当前 Agent' }
    : { agent: 'Agent', main: 'Main Agent', mainDesc: 'Default agent, no custom script', tag: 'Current agent' };
  const choices = [{ name: null, label: T.main, description: T.mainDesc },
    ...agents.items.map(i => ({ name: i.name, label: i.name, description: i.description }))];
  const current = choices.find(c => c.name === agents.selected) || choices[0];
  const el = (tag, cls, html) => { const n = document.createElement(tag); if (cls) n.className = cls; if (html != null) n.innerHTML = html; return n; };

  // Footer tag right of the model capsule. The strip is not rebuilt on refresh, so keep one node and update it.
  if (agents.selected != null && ctx.button?.isConnected) {
    if (!st.tag) {
      st.tag = el('button', 'dk-ae-tag', SVG_BOT);
      st.tag.type = 'button';
      st.tag.append(el('span'));
      st.tag.addEventListener('click', () => {
        st.open = true;
        if (!ctx.panel.matches(':popover-open')) ctx.button.click();
        else st.setOpen?.(true);
      });
    }
    if (st.tag.previousElementSibling !== ctx.button) ctx.button.after(st.tag);
    st.tag.lastChild.textContent = agents.selected;
    if (composer?.dataset) composer.dataset.deckAgentTag = 'on';
    st.tag.setAttribute('aria-label', T.tag + ': ' + agents.selected);
    st.tag.title = T.tag + ': ' + agents.selected;
  } else clearTag();

  st.agents = agents;
  const sig = JSON.stringify([zh, agents.items, agents.selected]);
  if (st.sig === sig && slot.firstChild) {
    // The panel may have just opened from the footer tag.
    st.setOpen?.(!!st.open);
    return;
  }
  st.cleanup?.(); st.cleanup = null;
  st.sig = sig;

  const trigger = el('button', 'dk-ae-trigger', SVG_BOT);
  trigger.type = 'button';
  trigger.dataset.custom = String(agents.selected != null);
  trigger.setAttribute('aria-haspopup', 'listbox');
  const name = el('span', 'dk-ae-name');
  name.textContent = current.label;
  trigger.append(name);
  trigger.insertAdjacentHTML('beforeend', SVG_DOWN);
  trigger.setAttribute('aria-label', T.agent + ': ' + current.label);

  const list = el('div', 'dk-ae-list');
  const inner = el('div');
  inner.setAttribute('role', 'listbox');
  inner.setAttribute('aria-label', T.agent);
  list.append(inner);

  const tip = el('div', 'dk-model-tip');
  tip.popover = 'manual';
  tip.setAttribute('role', 'tooltip');
  ctx.panel.append(tip);
  let tipTimer = null;
  const hideTip = () => { clearTimeout(tipTimer); tipTimer = null; if (tip.matches(':popover-open')) tip.hidePopover(); };
  const showTip = (row, text) => {
    clearTimeout(tipTimer);
    if (!text) { hideTip(); return; }
    tipTimer = setTimeout(() => {
      if (!ctx.panel.matches(':popover-open') || !row.isConnected) return;
      tip.textContent = text;
      if (!tip.matches(':popover-open')) tip.showPopover();
      const box = ctx.panel.getBoundingClientRect(), r = row.getBoundingClientRect(), t = tip.getBoundingClientRect();
      const right = box.right + 6, left = box.left - t.width - 6;
      tip.style.left = Math.round(right + t.width <= innerWidth - 6 ? right : Math.max(6, left)) + 'px';
      tip.style.top = Math.round(Math.max(6, Math.min(r.top + r.height / 2 - t.height / 2, innerHeight - t.height - 6))) + 'px';
    }, 280);
  };

  for (const c of choices) {
    const on = c.name === agents.selected;
    const row = el('button', 'dk-model-row');
    row.type = 'button';
    row.setAttribute('role', 'option');
    row.setAttribute('aria-selected', String(on));
    row.setAttribute('aria-pressed', String(on));
    if (c.description) row.setAttribute('aria-description', c.description);
    const main = el('span', 'dk-model-main');
    const n = el('span', 'dk-mp-name');
    n.textContent = c.label;
    main.append(n);
    row.append(main, el('span', 'dk-mp-end', on ? SVG_CHECK : ''));
    row.addEventListener('pointerenter', () => showTip(row, c.description));
    row.addEventListener('pointerleave', hideTip);
    row.addEventListener('focus', () => showTip(row, c.description));
    row.addEventListener('blur', hideTip);
    row.addEventListener('click', () => {
      hideTip();
      setOpen(false);
      if (c.name !== st.agents.selected) st.agents.choose(c.name);
      trigger.focus({ preventScroll: true });
    });
    inner.append(row);
  }

  const sep = el('div', 'dk-ae-sep');
  // Start just under the divider and stop at the panel's inner bottom edge; longer lists scroll inside.
  const placeList = () => {
    const panel = ctx.panel;
    const top = sep.offsetTop + sep.offsetHeight + 1;
    list.style.top = top + 'px';
    list.style.maxHeight = Math.max(48, panel.scrollTop + panel.clientHeight - top - 4) + 'px';
  };
  const setOpen = open => {
    st.open = open;
    if (open) placeList();
    list.dataset.open = String(open);
    trigger.setAttribute('aria-expanded', String(open));
    for (const b of inner.querySelectorAll('button')) b.tabIndex = open ? 0 : -1;
    if (!open) hideTip();
  };
  st.setOpen = setOpen;
  trigger.addEventListener('click', () => {
    setOpen(!st.open);
    if (st.open) inner.querySelector('[aria-selected="true"]')?.focus({ preventScroll: true });
  });
  trigger.addEventListener('keydown', e => {
    if (e.key === 'Escape' && st.open) { setOpen(false); e.preventDefault(); e.stopPropagation(); return; }
    if (e.key !== 'ArrowDown') return;
    setOpen(true);
    inner.querySelector('[aria-selected="true"]')?.focus({ preventScroll: true });
    e.preventDefault(); e.stopPropagation();
  });
  inner.addEventListener('keydown', e => {
    const rows = [...inner.querySelectorAll('button')];
    const i = rows.indexOf(e.target.closest('button'));
    if (e.key === 'ArrowDown' || e.key === 'ArrowUp') rows[(i + (e.key === 'ArrowDown' ? 1 : -1) + rows.length) % rows.length]?.focus();
    else if (e.key === 'Escape') { setOpen(false); trigger.focus(); }
    else return;
    e.preventDefault(); e.stopPropagation();
  });
  // Opening from the footer tag sets st.open first; a refresh may not re-render, so apply it here.
  const onToggle = e => setOpen(e.newState === 'open' && !!st.open);
  ctx.panel.addEventListener('toggle', onToggle);
  st.cleanup = () => {
    hideTip(); tip.remove();
    ctx.panel.removeEventListener('toggle', onToggle);
    st.setOpen = null;
  };
  slot.replaceChildren(trigger, sep, list);
  // During beforetoggle the panel is not open yet: draw it collapsed but keep the intent for onToggle.
  const wantOpen = !!st.open;
  setOpen(wantOpen && ctx.panel.matches(':popover-open'));
  st.open = wantOpen;
}
